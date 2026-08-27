import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { ScrapeStack } from '../scrape-stack.js';
import { TailorStack } from '../tailor-stack.js';
import { OpsStack } from '../ops-stack.js';

describe('OpsStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-west-2' };
    const data = new DataStack(app, 'TestData', { env });
    const scrape = new ScrapeStack(app, 'TestScrape', { env, table: data.table });
    const tailor = new TailorStack(app, 'TestTailor', {
      env,
      table: data.table,
      anthropicKeyParameterName: '/intern-tool/anthropic-api-key',
      firebaseProjectId: 'intern-tool-4224a',
      artifactOrigins: ['https://roots-yye7.vercel.app'],
    });
    const ops = new OpsStack(app, 'TestOps', {
      env,
      table: data.table,
      scrapeDlq: scrape.dlq,
      tailorDlq: tailor.dlq,
      dispatcher: scrape.dispatcher,
      scrapeWorker: scrape.worker,
      tailorEnqueue: tailor.enqueueFn,
      tailorWorker: tailor.workerFn,
      alertEmail: 'alerts@example.com',
    });
    template = Template.fromStack(ops);
  });

  it('contains no budget', () => {
    // The $1 budget is created by hand in the console. This stack's rollback is
    // `cdk destroy`, which would otherwise delete the cost guardrail at exactly
    // the moment something had gone wrong enough to warrant a rollback.
    template.resourceCountIs('AWS::Budgets::Budget', 0);
  });

  describe('notifications', () => {
    it('routes alarms to an email subscription', () => {
      template.resourceCountIs('AWS::SNS::Topic', 1);
      template.hasResourceProperties('AWS::SNS::Subscription', {
        Protocol: 'email',
        Endpoint: 'alerts@example.com',
      });
    });

    it('wires every alarm to the topic', () => {
      // An alarm with no action fires silently, which is worse than no alarm —
      // it looks like coverage while notifying nobody.
      const alarms = template.findResources('AWS::CloudWatch::Alarm');
      expect(Object.keys(alarms).length).toBeGreaterThan(0);
      for (const [id, a] of Object.entries(alarms)) {
        expect(a.Properties.AlarmActions, `${id} has no alarm action`).toBeDefined();
        expect(a.Properties.AlarmActions.length).toBeGreaterThan(0);
      }
    });
  });

  describe('dead-letter alarms', () => {
    it('alarms on both DLQs at a single message', () => {
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      const dlqAlarms = alarms.filter(
        (a) => a.Properties.MetricName === 'ApproximateNumberOfMessagesVisible',
      );
      expect(dlqAlarms).toHaveLength(2);
      for (const a of dlqAlarms) {
        expect(a.Properties.Threshold).toBe(1);
      }
    });
  });

  describe('dispatcher alarm', () => {
    it('alarms on dispatcher errors', () => {
      // The dispatcher's failure is otherwise invisible: it enqueues nothing,
      // so no DLQ fills and no worker error is produced. Without this the only
      // signal is the 26-hour freshness alarm.
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      const errorAlarms = alarms.filter((a) => a.Properties.MetricName === 'Errors');
      expect(errorAlarms.length).toBeGreaterThanOrEqual(3); // dispatcher + 2 workers
    });
  });

  describe('freshness alarm', () => {
    it('fires when the scrape has not run in 8 hours', () => {
      // Sized to the 6-hourly schedule: one missed cycle plus margin. Left at
      // the old 26h (daily) this would tolerate three consecutive failed runs
      // before alerting.
      template.hasResourceProperties('AWS::CloudWatch::Alarm', {
        MetricName: 'Invocations',
        Period: 8 * 3600,
        Threshold: 1,
        ComparisonOperator: 'LessThanThreshold',
      });
    });

    it('treats missing data as breaching', () => {
      // No invocations at all IS the failure. NOT_BREACHING would make the
      // alarm stay green precisely when the schedule has stopped firing.
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      const freshness = alarms.find((a) => a.Properties.MetricName === 'Invocations');
      expect(freshness?.Properties.TreatMissingData).toBe('breaching');
    });
  });

  describe('throttle alarm', () => {
    it('watches all three functions', () => {
      // The account limit is 10 concurrent executions, so throttling is a real
      // constraint here rather than a theoretical one.
      const alarms = Object.values(template.findResources('AWS::CloudWatch::Alarm'));
      const throttle = alarms.find((a) =>
        JSON.stringify(a.Properties.Metrics ?? '').includes('Throttles'),
      );
      expect(throttle).toBeDefined();
    });
  });

  it('creates one dashboard', () => {
    template.resourceCountIs('AWS::CloudWatch::Dashboard', 1);
    template.hasResourceProperties('AWS::CloudWatch::Dashboard', {
      DashboardName: 'intern-tool',
    });
  });

  it('introduces no resource with a standing charge', () => {
    // Alarms are billed per-alarm-month at a rate this many alarms stays well
    // inside; dashboards are free up to three.
    for (const type of [
      'AWS::EC2::NatGateway',
      'AWS::RDS::DBInstance',
      'AWS::ElasticLoadBalancingV2::LoadBalancer',
    ]) {
      template.resourceCountIs(type, 0);
    }
  });
});
