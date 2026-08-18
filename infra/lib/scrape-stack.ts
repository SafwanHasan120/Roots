import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import { Architecture, Runtime } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { CfnSchedule } from 'aws-cdk-lib/aws-scheduler';
import { Role, ServicePrincipal, PolicyStatement } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../..');
const SERVICES = path.join(REPO_ROOT, 'services/scrape');

export interface ScrapeStackProps extends StackProps {
  table: TableV2;
  /** SSM parameter holding a GitHub PAT. Optional: the scraper works unauthenticated. */
  githubTokenParameterName?: string;
}

/**
 * EventBridge Scheduler -> dispatcher Lambda -> SQS -> worker Lambda -> DynamoDB.
 *
 * A second schedule re-invokes the dispatcher in sweep mode after the queue has
 * drained. Kept in its own stack so `cdk destroy` here cannot touch the table.
 */
export class ScrapeStack extends Stack {
  constructor(scope: Construct, id: string, props: ScrapeStackProps) {
    super(scope, id, props);
    const { table } = props;

    // --- queues -------------------------------------------------------------

    const dlq = new Queue(this, 'ScrapeDlq', {
      retentionPeriod: Duration.days(14),
    });

    const workerTimeout = Duration.seconds(120);

    const queue = new Queue(this, 'ScrapeQueue', {
      // Must exceed the worker timeout or SQS redelivers a message that is
      // still being processed. 6x leaves room for a slow cold start.
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      deadLetterQueue: {
        queue: dlq,
        // 3 deliveries total, then dead-letter. Transient GitHub 5xx and
        // throttles are what is worth retrying; a fault surviving three
        // attempts is a code or schema problem a fourth will not fix.
        maxReceiveCount: 3,
      },
    });

    // --- bundling -----------------------------------------------------------

    const bundling = {
      format: 'esm' as const,
      target: 'node24',
      // The v3 SDK is present in the Lambda runtime, but bundling it pins the
      // version rather than inheriting whatever AWS ships this month.
      externalModules: [],
      // scraper.ts imports sources.json; esbuild inlines it.
      loader: { '.json': 'json' as const },
      banner:
        // aws-lambda-nodejs emits ESM, but some transitive deps still call
        // require(). This shim keeps them working under an ESM entry point.
        "import{createRequire}from'module';const require=createRequire(import.meta.url);",
    };

    const commonFnProps = {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      logRetention: RetentionDays.ONE_WEEK,
      bundling,
      // The entry files live in services/, so the project root must be the
      // workspace root that contains both it and infra/. esbuild is therefore
      // a root-level devDependency — CDK runs the bundler with cwd set here.
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    // --- functions ----------------------------------------------------------

    const dispatcher = new NodejsFunction(this, 'Dispatcher', {
      ...commonFnProps,
      entry: path.join(SERVICES, 'dispatcher.ts'),
      handler: 'handler',
      memorySize: 512,
      // Sweep mode pages every GSI1 shard and issues conditional updates, so it
      // needs materially longer than the fan-out path.
      timeout: Duration.seconds(120),
      environment: {
        ...commonFnProps.environment,
        QUEUE_URL: queue.queueUrl,
      },
    });

    const worker = new NodejsFunction(this, 'Worker', {
      ...commonFnProps,
      entry: path.join(SERVICES, 'worker.ts'),
      handler: 'handler',
      memorySize: 1024,
      timeout: workerTimeout,
      // No reservedConcurrentExecutions. This account's total concurrency limit
      // is 10 (the default for new accounts, not the familiar 1000), and Lambda
      // refuses any reservation that would drop unreserved capacity below 10 —
      // so every possible value is rejected here.
      //
      // Concurrency is bounded anyway: the dispatcher enqueues one message per
      // source (currently 2), and batchSize is 1, so at most 2 workers run at
      // once. Reinstate a reservation if the account limit is raised AND the
      // source count grows enough for fan-out to matter.
      environment: {
        ...commonFnProps.environment,
        ...(props.githubTokenParameterName
          ? { GITHUB_TOKEN_PARAM: props.githubTokenParameterName }
          : {}),
      },
    });

    worker.addEventSource(
      new SqsEventSource(queue, {
        // One source per invocation. Deliberately no reportBatchItemFailures —
        // partial batch response is meaningless at batchSize 1.
        batchSize: 1,
      }),
    );

    // --- permissions --------------------------------------------------------

    queue.grantSendMessages(dispatcher);
    table.grantReadWriteData(dispatcher);
    table.grantReadWriteData(worker);

    // grantReadWriteData covers the table but not its indexes, which the sweep
    // queries directly.
    const indexArns = new PolicyStatement({
      actions: ['dynamodb:Query'],
      resources: [`${table.tableArn}/index/*`],
    });
    dispatcher.addToRolePolicy(indexArns);
    worker.addToRolePolicy(indexArns);

    if (props.githubTokenParameterName) {
      StringParameter.fromSecureStringParameterAttributes(this, 'GithubToken', {
        parameterName: props.githubTokenParameterName,
      }).grantRead(worker);
    }

    // --- schedules ----------------------------------------------------------

    const schedulerRole = new Role(this, 'SchedulerRole', {
      assumedBy: new ServicePrincipal('scheduler.amazonaws.com'),
    });
    dispatcher.grantInvoke(schedulerRole);

    // 13:00 UTC daily, matching the Vercel cron this replaces.
    new CfnSchedule(this, 'ScrapeSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(0 13 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      description: 'Daily internship scrape fan-out',
      target: {
        arn: dispatcher.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ mode: 'scrape' }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    // +15 min: the two-source queue drains in well under that. If sources grow
    // substantially this becomes a race and should move to a queue-depth trigger.
    new CfnSchedule(this, 'SweepSchedule', {
      flexibleTimeWindow: { mode: 'OFF' },
      scheduleExpression: 'cron(15 13 * * ? *)',
      scheduleExpressionTimezone: 'UTC',
      description: 'Deactivate listings absent from source or aged out',
      target: {
        arn: dispatcher.functionArn,
        roleArn: schedulerRole.roleArn,
        input: JSON.stringify({ mode: 'sweep' }),
        retryPolicy: { maximumRetryAttempts: 2, maximumEventAgeInSeconds: 3600 },
      },
    });

    // --- outputs ------------------------------------------------------------

    new CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'DlqUrl', { value: dlq.queueUrl });
    new CfnOutput(this, 'DispatcherName', { value: dispatcher.functionName });
    new CfnOutput(this, 'WorkerName', { value: worker.functionName });
  }
}
