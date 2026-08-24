import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { ScrapeStack } from '../scrape-stack.js';

/**
 * The two Lambdas this stack owns.
 *
 * CDK's log-retention helper is also an AWS::Lambda::Function with
 * Handler: index.handler, so filtering on the handler alone picks it up and
 * makes assertions about "our" functions fail confusingly.
 */
function ourFunctions(template: Template): Array<[string, Record<string, any>]> {
  return Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, f]) => f.Properties?.Environment?.Variables?.TABLE_NAME !== undefined,
  );
}

describe('ScrapeStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-west-2' };
    const data = new DataStack(app, 'TestData', { env });
    const scrape = new ScrapeStack(app, 'TestScrape', { env, table: data.table });
    template = Template.fromStack(scrape);
  });

  describe('queues', () => {
    it('creates a work queue and a DLQ', () => {
      template.resourceCountIs('AWS::SQS::Queue', 2);
    });

    it('dead-letters after exactly 3 receives', () => {
      // 3 deliveries total, then DLQ. Not 4 — there is no fourth attempt.
      template.hasResourceProperties('AWS::SQS::Queue', {
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      });
    });

    it('sets a visibility timeout well above the worker timeout', () => {
      // Too low and SQS redelivers a message still being processed, producing
      // duplicate work and a DLQ entry for a job that actually succeeded.
      const queues = template.findResources('AWS::SQS::Queue');
      const work = Object.values(queues).find((q) => q.Properties?.RedrivePolicy);

      // Assert the RELATIONSHIP, not a literal. Pinning the number meant every
      // worker-timeout change broke this test for no reason, which invites
      // updating the constant without rechecking the invariant.
      //
      // Select the worker by its event-source mapping rather than by taking the
      // max Timeout across functions — CDK's own bundling custom resource is a
      // Lambda too, and it has a longer timeout than anything we declare.
      const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
      const workerRef = Object.values(mappings)[0]?.Properties?.FunctionName?.Ref;
      const fns = template.findResources('AWS::Lambda::Function');
      const workerTimeout = Number(fns[workerRef]?.Properties?.Timeout ?? 0);
      expect(workerTimeout, 'could not locate the worker function').toBeGreaterThan(0);

      expect(work?.Properties.VisibilityTimeout).toBe(workerTimeout * 6);
      // SQS hard cap; exceeding it fails the deploy, not the test.
      expect(work?.Properties.VisibilityTimeout).toBeLessThanOrEqual(43200);
    });
  });

  describe('functions', () => {
    it('creates the dispatcher and the worker', () => {
      expect(ourFunctions(template)).toHaveLength(2);
    });

    it('runs everything on ARM64', () => {
      const ours = ourFunctions(template);
      for (const [id, fn] of ours) {
        expect(fn.Properties.Architectures, `${id} must be arm64`).toEqual(['arm64']);
      }
    });

    it('uses a runtime AWS still allows creating', () => {
      // nodejs20.x was deprecated 2026-04-30 and creation is disabled from
      // 2027-02-01 — a stack pinned to it eventually fails to deploy at all.
      const deprecated = ['nodejs16.x', 'nodejs18.x', 'nodejs20.x'];
      for (const [id, fn] of ourFunctions(template)) {
        expect(deprecated, `${id} uses a deprecated runtime`).not.toContain(
          fn.Properties.Runtime,
        );
      }
    });

    it('reserves no concurrency', () => {
      // The account's total concurrency limit is 10 (default for new accounts),
      // and Lambda rejects any reservation that drops unreserved capacity below
      // 10 — so any value here fails the deploy outright. Concurrency is
      // bounded by the fan-out instead: one message per source, batchSize 1.
      for (const [id, fn] of ourFunctions(template)) {
        expect(
          fn.Properties.ReservedConcurrentExecutions,
          `${id} must not reserve concurrency on a 10-limit account`,
        ).toBeUndefined();
      }
    });

    it('passes the table name to both functions', () => {
      const ours = ourFunctions(template);
      for (const [id, fn] of ours) {
        expect(
          fn.Properties.Environment?.Variables?.TABLE_NAME,
          `${id} needs TABLE_NAME`,
        ).toBeDefined();
      }
    });
  });

  describe('event source', () => {
    it('maps the queue to the worker one message at a time', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', {
        BatchSize: 1,
      });
    });

    it('does not set partial batch response', () => {
      // Meaningless at batchSize 1; setting it implies a guarantee the handler
      // does not actually provide.
      const mappings = template.findResources('AWS::Lambda::EventSourceMapping');
      for (const [id, m] of Object.entries(mappings)) {
        expect(
          m.Properties?.FunctionResponseTypes,
          `${id} should not declare FunctionResponseTypes`,
        ).toBeUndefined();
      }
    });
  });

  describe('schedules', () => {
    it('creates a scrape schedule and a sweep schedule', () => {
      template.resourceCountIs('AWS::Scheduler::Schedule', 2);
    });

    it('runs the scrape every 6 hours, including 13:00 UTC', () => {
      template.hasResourceProperties('AWS::Scheduler::Schedule', {
        ScheduleExpression: 'cron(0 1,7,13,19 * * ? *)',
        ScheduleExpressionTimezone: 'UTC',
        FlexibleTimeWindow: { Mode: 'OFF' },
      });
    });

    it('runs the sweep 15 minutes after each scrape, on the same hours', () => {
      // The offset assumes the queue drains first; the sweep deactivates based
      // on what the workers recorded. Measured drain is ~20s.
      const schedules = template.findResources('AWS::Scheduler::Schedule');
      const exprs = Object.values(schedules).map(
        (s) => s.Properties.ScheduleExpression as string,
      );

      const scrape = exprs.find((e) => e.startsWith('cron(0 '));
      const sweep = exprs.find((e) => e.startsWith('cron(15 '));
      expect(sweep).toBeDefined();

      // Same hour field: a sweep that runs on hours the scrape does not would
      // evaluate a run that never happened and age listings out early.
      const hoursOf = (e: string) => e.split(' ')[1];
      expect(hoursOf(sweep!)).toBe(hoursOf(scrape!));
    });

    it('invokes the dispatcher in the right mode from each schedule', () => {
      const schedules = template.findResources('AWS::Scheduler::Schedule');
      const inputs = Object.values(schedules).map((s) => s.Properties.Target.Input);
      expect(inputs).toContain('{"mode":"scrape"}');
      expect(inputs).toContain('{"mode":"sweep"}');
    });
  });

  describe('observability', () => {
    it('sets a one-week log retention', () => {
      // Log groups default to never-expire, which accrues storage cost forever.
      template.hasResourceProperties('Custom::LogRetention', {
        RetentionInDays: 7,
      });
    });
  });

  it('has no VPC configuration anywhere', () => {
    // A VPC-attached Lambda needs a NAT Gateway to reach GitHub — the single
    // largest cost risk in this architecture.
    const fns = template.findResources('AWS::Lambda::Function');
    for (const [id, fn] of Object.entries(fns)) {
      expect(fn.Properties?.VpcConfig, `${id} must not be VPC-attached`).toBeUndefined();
    }
  });
});
