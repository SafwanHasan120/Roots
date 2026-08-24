import { Stack, StackProps, Duration, CfnOutput } from 'aws-cdk-lib';
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
  Metric,
  Dashboard,
  GraphWidget,
  SingleValueWidget,
  MathExpression,
} from 'aws-cdk-lib/aws-cloudwatch';
import { SnsAction } from 'aws-cdk-lib/aws-cloudwatch-actions';
import { Topic } from 'aws-cdk-lib/aws-sns';
import { EmailSubscription } from 'aws-cdk-lib/aws-sns-subscriptions';
import type { Queue } from 'aws-cdk-lib/aws-sqs';
import type { IFunction } from 'aws-cdk-lib/aws-lambda';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface OpsStackProps extends StackProps {
  table: TableV2;
  scrapeDlq: Queue;
  tailorDlq: Queue;
  dispatcher: IFunction;
  scrapeWorker: IFunction;
  tailorEnqueue: IFunction;
  tailorWorker: IFunction;
  /** Where alarm notifications go. */
  alertEmail: string;
}

/**
 * Alarms and a dashboard.
 *
 * Deliberately contains NO budget. The $1 budget is created by hand in the
 * console, because this stack's rollback is `cdk destroy` — which would
 * otherwise delete the cost guardrail at exactly the moment something had gone
 * wrong enough to warrant a rollback. A guardrail whose lifecycle is coupled to
 * the thing it guards is not a guardrail. constraints.test.ts asserts no
 * AWS::Budgets::Budget appears in any template.
 *
 * Observation-only: nothing in the data path depends on this stack.
 */
export class OpsStack extends Stack {
  constructor(scope: Construct, id: string, props: OpsStackProps) {
    super(scope, id, props);

    const topic = new Topic(this, 'AlertTopic', {
      displayName: 'intern-tool alerts',
    });
    topic.addSubscription(new EmailSubscription(props.alertEmail));

    const alarm = (
      id: string,
      metric: Metric | MathExpression,
      opts: {
        threshold: number;
        evaluationPeriods?: number;
        description: string;
        comparisonOperator?: ComparisonOperator;
        treatMissingData?: TreatMissingData;
      },
    ) => {
      const a = new Alarm(this, id, {
        metric,
        threshold: opts.threshold,
        evaluationPeriods: opts.evaluationPeriods ?? 1,
        comparisonOperator:
          opts.comparisonOperator ?? ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        alarmDescription: opts.description,
        treatMissingData: opts.treatMissingData ?? TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(new SnsAction(topic));
      return a;
    };

    // --- dead letters -------------------------------------------------------
    //
    // Anything here is work that failed three deliveries and was given up on.
    // Always worth a human look.

    alarm(
      'ScrapeDlqAlarm',
      props.scrapeDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      { threshold: 1, description: 'A scrape message dead-lettered after 3 delivery attempts' },
    );

    alarm(
      'TailorDlqAlarm',
      props.tailorDlq.metricApproximateNumberOfMessagesVisible({
        period: Duration.minutes(5),
        statistic: 'Maximum',
      }),
      { threshold: 1, description: 'A tailor job dead-lettered after 3 delivery attempts' },
    );

    // --- dispatcher ---------------------------------------------------------
    //
    // The dispatcher is the one component whose failure is otherwise INVISIBLE:
    // it enqueues nothing when it fails, so no message is produced, no DLQ fills
    // and no worker errors. Without this alarm the only signal is the 26-hour
    // freshness alarm, which says data is stale but not which part broke.

    alarm(
      'DispatcherErrorAlarm',
      props.dispatcher.metricErrors({ period: Duration.minutes(5) }),
      {
        threshold: 1,
        description:
          'The scrape dispatcher failed. It enqueues nothing on failure, so no DLQ or worker alarm will fire — this is the only direct signal.',
      },
    );

    // --- workers ------------------------------------------------------------
    //
    // Both workers settle their own failures into a job/state record rather than
    // throwing, so a Lambda-level error here means something unexpected: an OOM,
    // a timeout, a bug outside the handled paths.

    alarm(
      'ScrapeWorkerErrorAlarm',
      props.scrapeWorker.metricErrors({ period: Duration.minutes(5) }),
      { threshold: 1, description: 'The scrape worker threw an unhandled error' },
    );

    alarm(
      'TailorWorkerErrorAlarm',
      props.tailorWorker.metricErrors({ period: Duration.minutes(5) }),
      { threshold: 1, description: 'The tailor worker threw an unhandled error' },
    );

    alarm(
      'TailorEnqueueErrorAlarm',
      props.tailorEnqueue.metricErrors({ period: Duration.minutes(5) }),
      {
        threshold: 3,
        description:
          'The tailor enqueue function is failing. Threshold is 3, not 1: rejected auth is a 401 response rather than an error, so genuine errors here are rare and a single blip is not worth waking anyone.',
      },
    );

    // --- freshness ----------------------------------------------------------
    //
    // The scrape runs every 6 hours (01/07/13/19 UTC), and the sweep fires 15
    // minutes after each, so the dispatcher is invoked 8 times a day. If it has
    // not been invoked in 8 hours, the schedule itself is broken — a case no
    // error metric covers, because nothing ran to produce an error.
    //
    // 8h = one missed cycle plus margin. Sized to the schedule, not fixed: at
    // the old daily cadence this was 26h, and leaving it there would have meant
    // three consecutive failed runs before anyone heard about it.

    alarm(
      'ScrapeFreshnessAlarm',
      props.dispatcher.metricInvocations({
        period: Duration.hours(8),
        statistic: 'Sum',
      }),
      {
        threshold: 1,
        comparisonOperator: ComparisonOperator.LESS_THAN_THRESHOLD,
        // Missing data IS the failure here: no invocations at all means the
        // schedule stopped firing.
        treatMissingData: TreatMissingData.BREACHING,
        description:
          'No scrape has run in 8 hours (expected every 6). The schedule may be disabled or the dispatcher unreachable.',
      },
    );

    // --- throttling ---------------------------------------------------------
    //
    // This account's Lambda concurrency limit is 10, far below the usual 1000,
    // so throttling is a realistic failure mode rather than a theoretical one.

    alarm(
      'LambdaThrottleAlarm',
      new MathExpression({
        expression: 'scrapeT + tailorT + enqueueT',
        usingMetrics: {
          scrapeT: props.scrapeWorker.metricThrottles({ period: Duration.minutes(5) }),
          tailorT: props.tailorWorker.metricThrottles({ period: Duration.minutes(5) }),
          enqueueT: props.tailorEnqueue.metricThrottles({ period: Duration.minutes(5) }),
        },
        period: Duration.minutes(5),
      }),
      {
        threshold: 1,
        description:
          'A Lambda was throttled. This account is limited to 10 concurrent executions, so this is a real constraint, not a theoretical one.',
      },
    );

    // --- dashboard ----------------------------------------------------------

    const dashboard = new Dashboard(this, 'Dashboard', {
      dashboardName: 'intern-tool',
    });

    dashboard.addWidgets(
      new SingleValueWidget({
        title: 'Dead letters (should be 0)',
        metrics: [
          props.scrapeDlq.metricApproximateNumberOfMessagesVisible({ label: 'scrape' }),
          props.tailorDlq.metricApproximateNumberOfMessagesVisible({ label: 'tailor' }),
        ],
        width: 12,
      }),
      new SingleValueWidget({
        title: 'Table item count',
        metrics: [
          new Metric({
            namespace: 'AWS/DynamoDB',
            metricName: 'ItemCount',
            dimensionsMap: { TableName: props.table.tableName },
            statistic: 'Maximum',
          }),
        ],
        width: 12,
      }),
    );

    dashboard.addWidgets(
      new GraphWidget({
        title: 'Scrape path',
        left: [
          props.dispatcher.metricInvocations({ label: 'dispatcher invocations' }),
          props.dispatcher.metricErrors({ label: 'dispatcher errors' }),
          props.scrapeWorker.metricErrors({ label: 'worker errors' }),
        ],
        width: 12,
      }),
      new GraphWidget({
        title: 'Tailor path',
        left: [
          props.tailorEnqueue.metricInvocations({ label: 'enqueued' }),
          props.tailorWorker.metricInvocations({ label: 'jobs run' }),
          props.tailorWorker.metricErrors({ label: 'worker errors' }),
        ],
        right: [props.tailorWorker.metricDuration({ label: 'job duration', statistic: 'p99' })],
        width: 12,
      }),
    );

    new CfnOutput(this, 'AlertTopicArn', { value: topic.topicArn });
    new CfnOutput(this, 'DashboardName', { value: 'intern-tool' });
  }
}
