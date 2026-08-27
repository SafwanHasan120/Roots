import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Stack, StackProps, Duration, CfnOutput, RemovalPolicy } from 'aws-cdk-lib';
import { Architecture, Runtime, FunctionUrlAuthType } from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import { SqsEventSource } from 'aws-cdk-lib/aws-lambda-event-sources';
import { Queue } from 'aws-cdk-lib/aws-sqs';
import { RetentionDays } from 'aws-cdk-lib/aws-logs';
import { Bucket, BlockPublicAccess, BucketEncryption, HttpMethods } from 'aws-cdk-lib/aws-s3';
import { PolicyStatement, type IRole } from 'aws-cdk-lib/aws-iam';
import { StringParameter } from 'aws-cdk-lib/aws-ssm';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

const here = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(here, '../..');
const SERVICES = path.join(REPO_ROOT, 'services/tailor');

export interface TailorStackProps extends StackProps {
  table: TableV2;
  /** SSM SecureString parameter holding the Anthropic API key. */
  anthropicKeyParameterName: string;
  /** Firebase project id — the expected `aud` and `iss` on ID tokens. */
  firebaseProjectId: string;
  /** Vercel's OIDC role, granted permission to invoke the function URL. */
  vercelRole?: IRole;
  /**
   * Browser origins allowed to download artifacts from the bucket.
   *
   * The client fetches the presigned URL directly, so without a matching CORS
   * rule S3 returns the object but omits `Access-Control-Allow-Origin` and the
   * browser blocks the read — a 200 that still fails, which is why this was easy
   * to miss.
   *
   * Exact origins only. A `*` here would let any site that obtained a presigned
   * URL read a user's tailored resume.
   */
  artifactOrigins: string[];
}

/**
 * Async tailor path: Vercel -> (SigV4) function URL -> SQS -> worker -> S3.
 *
 * Replaces a synchronous 8192-token Claude call that ran inside a single HTTP
 * request. The browser now gets a job id immediately and polls for the result.
 */
export class TailorStack extends Stack {
  /** Exposed so the ops stack can alarm on them. */
  public readonly dlq: Queue;
  public readonly enqueueFn: NodejsFunction;
  public readonly workerFn: NodejsFunction;

  constructor(scope: Construct, id: string, props: TailorStackProps) {
    super(scope, id, props);
    const { table } = props;

    // --- artifact storage ---------------------------------------------------

    const artifacts = new Bucket(this, 'Artifacts', {
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      encryption: BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      // Tailored resumes are disposable output, regenerable by re-running a
      // job. 30 days keeps storage near zero; the UI says so explicitly.
      lifecycleRules: [{ expiration: Duration.days(30) }],
      removalPolicy: RemovalPolicy.RETAIN,
      // The browser fetches the presigned URL directly, so S3 must answer the
      // cross-origin read. Without this it serves the object with a 200 but no
      // Access-Control-Allow-Origin, and the browser discards it — the request
      // looks successful everywhere except in the page.
      //
      // This does NOT grant access: BLOCK_ALL still applies and every request
      // needs a valid presigned signature. CORS only decides which origins may
      // *read the response* of a request that was already authorized.
      cors: [
        {
          allowedMethods: [HttpMethods.GET, HttpMethods.HEAD],
          allowedOrigins: props.artifactOrigins,
          // Presigned GETs carry their auth in the query string, so no custom
          // request headers are needed.
          allowedHeaders: ['*'],
          maxAge: 3000,
        },
      ],
    });

    // --- queues -------------------------------------------------------------

    const dlq = new Queue(this, 'TailorDlq', { retentionPeriod: Duration.days(14) });

    // Generous: a cold start plus a slow Claude completion. The worker's own
    // 240s request timeout fires well before this.
    const workerTimeout = Duration.seconds(300);

    const queue = new Queue(this, 'TailorQueue', {
      // Must exceed the worker timeout, or SQS redelivers a job that is still
      // running and two workers race on the same quota.
      visibilityTimeout: Duration.seconds(workerTimeout.toSeconds() * 6),
      deadLetterQueue: { queue: dlq, maxReceiveCount: 3 },
    });

    // --- bundling -----------------------------------------------------------

    const bundling = {
      format: 'esm' as const,
      target: 'node24',
      externalModules: [],
      loader: { '.json': 'json' as const },
      banner:
        "import{createRequire}from'module';const require=createRequire(import.meta.url);",
    };

    const common = {
      runtime: Runtime.NODEJS_24_X,
      architecture: Architecture.ARM_64,
      logRetention: RetentionDays.ONE_WEEK,
      bundling,
      projectRoot: REPO_ROOT,
      depsLockFilePath: path.join(REPO_ROOT, 'pnpm-lock.yaml'),
      environment: {
        TABLE_NAME: table.tableName,
        NODE_OPTIONS: '--enable-source-maps',
      },
    };

    // --- enqueue ------------------------------------------------------------

    const enqueue = new NodejsFunction(this, 'Enqueue', {
      ...common,
      entry: path.join(SERVICES, 'enqueue.ts'),
      handler: 'handler',
      memorySize: 256,
      // Verifies a JWT and writes two items. The only slow part is a cold JWKS
      // fetch, which is cached thereafter.
      timeout: Duration.seconds(10),
      environment: {
        ...common.environment,
        TAILOR_QUEUE_URL: queue.queueUrl,
        FIREBASE_PROJECT_ID: props.firebaseProjectId,
      },
    });

    // IAM auth, not NONE.
    //
    // Both /api/tailor and /api/tailor/status are Vercel route handlers, so the
    // browser never calls this URL directly. authType NONE plus a CORS
    // allowlist would defend against a caller that does not exist — CORS is a
    // browser convention, not a server-side control, and does nothing against
    // curl. AWS_IAM rejects unsigned requests before any code runs.
    const enqueueUrl = enqueue.addFunctionUrl({
      authType: FunctionUrlAuthType.AWS_IAM,
    });

    // --- worker -------------------------------------------------------------

    const worker = new NodejsFunction(this, 'Worker', {
      ...common,
      entry: path.join(SERVICES, 'worker.ts'),
      handler: 'handler',
      // Network-bound on Claude; extra memory buys CPU a blocked socket cannot
      // use. Raise only if LaTeX validation proves heavy on large resumes.
      memorySize: 512,
      timeout: workerTimeout,
      environment: {
        ...common.environment,
        ARTIFACT_BUCKET: artifacts.bucketName,
      },
    });

    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1 }));

    // --- permissions --------------------------------------------------------

    queue.grantSendMessages(enqueue);
    table.grantReadWriteData(enqueue);
    table.grantReadWriteData(worker);
    artifacts.grantPut(worker);

    // The worker fetches this SecureString itself at cold start.
    //
    // CloudFormation refuses to resolve an SSM secure reference into a Lambda
    // environment variable ("SSM Secure reference is not supported in:
    // [AWS::Lambda::Function/Properties/Environment/Variables/...]") — env vars
    // are visible in the function config, so they are not a secret store. The
    // runtime fetch is therefore the only correct option, not merely the
    // tidier one. See getAnthropicKey() in services/tailor/tailorLatex.ts.
    const anthropicKey = StringParameter.fromSecureStringParameterAttributes(
      this,
      'AnthropicKey',
      { parameterName: props.anthropicKeyParameterName },
    );
    anthropicKey.grantRead(worker);
    worker.addEnvironment('ANTHROPIC_KEY_PARAM', props.anthropicKeyParameterName);

    if (props.vercelRole) {
      // Lets the Vercel functions SigV4-sign requests to the function URL.
      enqueueUrl.grantInvokeUrl(props.vercelRole);

      // The status route reads the job item and presigns the artifact directly
      // rather than going through another Lambda — that would add a hop and a
      // cold start to relocate two SDK calls Vercel can already make.
      // Presigning requires the signer to actually hold s3:GetObject.
      props.vercelRole.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ['s3:GetObject'],
          resources: [`${artifacts.bucketArn}/jobs/*`],
        }),
      );
      props.vercelRole.addToPrincipalPolicy(
        new PolicyStatement({
          actions: ['dynamodb:GetItem'],
          resources: [table.tableArn],
        }),
      );
    }

    // --- outputs ------------------------------------------------------------

    this.dlq = dlq;
    this.enqueueFn = enqueue;
    this.workerFn = worker;

    new CfnOutput(this, 'EnqueueFunctionUrl', {
      value: enqueueUrl.url,
      description: 'Set as TAILOR_ENQUEUE_URL in Vercel',
    });
    new CfnOutput(this, 'ArtifactBucketName', { value: artifacts.bucketName });
    new CfnOutput(this, 'TailorQueueUrl', { value: queue.queueUrl });
    new CfnOutput(this, 'TailorDlqUrl', { value: dlq.queueUrl });
  }
}
