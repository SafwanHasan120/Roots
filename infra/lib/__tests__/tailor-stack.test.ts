import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { TailorStack } from '../tailor-stack.js';

/** The two Lambdas this stack owns, excluding CDK's log-retention helper. */
function ourFunctions(template: Template): Array<[string, Record<string, any>]> {
  return Object.entries(template.findResources('AWS::Lambda::Function')).filter(
    ([, f]) => f.Properties?.Environment?.Variables?.TABLE_NAME !== undefined,
  );
}

describe('TailorStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const env = { account: '123456789012', region: 'us-west-2' };
    const data = new DataStack(app, 'TestData', { env });
    const tailor = new TailorStack(app, 'TestTailor', {
      env,
      table: data.table,
      anthropicKeyParameterName: '/intern-tool/anthropic-api-key',
      firebaseProjectId: 'intern-tool-4224a',
    });
    template = Template.fromStack(tailor);
  });

  describe('function URL', () => {
    it('requires IAM auth', () => {
      // NONE plus a CORS allowlist would defend against a caller that does not
      // exist: the browser never touches this URL, and CORS is a browser
      // convention that does nothing against curl.
      template.hasResourceProperties('AWS::Lambda::Url', {
        AuthType: 'AWS_IAM',
      });
    });

    it('declares no CORS policy', () => {
      const urls = template.findResources('AWS::Lambda::Url');
      for (const [id, url] of Object.entries(urls)) {
        expect(url.Properties?.Cors, `${id} should not configure CORS`).toBeUndefined();
      }
    });

    it('exposes exactly one URL', () => {
      // The worker must never be publicly invocable.
      template.resourceCountIs('AWS::Lambda::Url', 1);
    });
  });

  describe('artifact bucket', () => {
    it('blocks all public access', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        PublicAccessBlockConfiguration: {
          BlockPublicAcls: true,
          BlockPublicPolicy: true,
          IgnorePublicAcls: true,
          RestrictPublicBuckets: true,
        },
      });
    });

    it('encrypts objects at rest', () => {
      template.hasResourceProperties('AWS::S3::Bucket', {
        BucketEncryption: Match.objectLike({
          ServerSideEncryptionConfiguration: Match.anyValue(),
        }),
      });
    });

    it('expires artifacts after 30 days', () => {
      // Tailored resumes are regenerable output; keeping them forever would
      // grow storage cost for no benefit. The UI states the expiry.
      template.hasResourceProperties('AWS::S3::Bucket', {
        LifecycleConfiguration: {
          Rules: Match.arrayWith([
            Match.objectLike({ ExpirationInDays: 30, Status: 'Enabled' }),
          ]),
        },
      });
    });

    it('survives a stack teardown', () => {
      template.hasResource('AWS::S3::Bucket', { DeletionPolicy: 'Retain' });
    });
  });

  describe('queues', () => {
    it('creates a work queue and a DLQ', () => {
      template.resourceCountIs('AWS::SQS::Queue', 2);
    });

    it('dead-letters after exactly 3 receives', () => {
      template.hasResourceProperties('AWS::SQS::Queue', {
        RedrivePolicy: Match.objectLike({ maxReceiveCount: 3 }),
      });
    });

    it('sets a visibility timeout above the worker timeout', () => {
      // Too low and SQS redelivers a job that is still running, so two workers
      // race on the same quota reservation.
      const queues = template.findResources('AWS::SQS::Queue');
      const work = Object.values(queues).find((q) => q.Properties?.RedrivePolicy);
      expect(work?.Properties.VisibilityTimeout).toBe(1800); // 300s * 6
    });
  });

  describe('functions', () => {
    it('creates the enqueue and worker functions', () => {
      expect(ourFunctions(template)).toHaveLength(2);
    });

    it('runs on ARM64 with a supported runtime', () => {
      for (const [id, fn] of ourFunctions(template)) {
        expect(fn.Properties.Architectures, `${id} must be arm64`).toEqual(['arm64']);
        expect(
          ['nodejs16.x', 'nodejs18.x', 'nodejs20.x'],
          `${id} uses a deprecated runtime`,
        ).not.toContain(fn.Properties.Runtime);
      }
    });

    it('gives the worker room for a slow Claude completion', () => {
      const worker = ourFunctions(template).find(
        ([, f]) => f.Properties.Environment?.Variables?.ARTIFACT_BUCKET !== undefined,
      );
      expect(worker?.[1].Properties.Timeout).toBe(300);
    });

    it('keeps the enqueue path fast', () => {
      // It verifies a JWT and writes two items; nothing here should take long.
      const enqueue = ourFunctions(template).find(
        ([, f]) => f.Properties.Environment?.Variables?.TAILOR_QUEUE_URL !== undefined,
      );
      expect(enqueue?.[1].Properties.Timeout).toBe(10);
    });

    it('tells the worker which SSM parameter holds the Anthropic key', () => {
      // The worker fetches this itself at cold start. CloudFormation rejects an
      // SSM secure reference in a Lambda env var, so injecting the value at
      // deploy time is not possible — the runtime fetch is required, not
      // merely preferred.
      const worker = ourFunctions(template).find(
        ([, f]) => f.Properties.Environment?.Variables?.ARTIFACT_BUCKET !== undefined,
      );
      expect(worker?.[1].Properties.Environment.Variables.ANTHROPIC_KEY_PARAM).toBe(
        '/intern-tool/anthropic-api-key',
      );
    });

    it('never puts a resolved secret into an environment variable', () => {
      // A literal key in the function config is readable by anyone with
      // lambda:GetFunctionConfiguration, and CloudFormation refuses to deploy
      // an ssm-secure dynamic reference there anyway.
      for (const [id, fn] of ourFunctions(template)) {
        const vars = fn.Properties.Environment?.Variables ?? {};
        expect(vars.ANTHROPIC_API_KEY, `${id} must not inline the API key`).toBeUndefined();
        expect(JSON.stringify(vars)).not.toContain('ssm-secure');
      }
    });

    it('passes the Firebase project id to the enqueue function', () => {
      // A wrong value rejects every token with an indistinguishable 401.
      const enqueue = ourFunctions(template).find(
        ([, f]) => f.Properties.Environment?.Variables?.TAILOR_QUEUE_URL !== undefined,
      );
      expect(enqueue?.[1].Properties.Environment.Variables.FIREBASE_PROJECT_ID).toBe(
        'intern-tool-4224a',
      );
    });

    it('processes one job per invocation', () => {
      template.hasResourceProperties('AWS::Lambda::EventSourceMapping', { BatchSize: 1 });
    });

    it('reserves no concurrency', () => {
      // The account limit is 10 and Lambda rejects any reservation that drops
      // unreserved capacity below it.
      for (const [id, fn] of ourFunctions(template)) {
        expect(
          fn.Properties.ReservedConcurrentExecutions,
          `${id} must not reserve concurrency`,
        ).toBeUndefined();
      }
    });
  });

  it('never attaches a function to a VPC', () => {
    for (const [id, fn] of Object.entries(template.findResources('AWS::Lambda::Function'))) {
      expect(fn.Properties?.VpcConfig, `${id} must not be VPC-attached`).toBeUndefined();
    }
  });

  it('sets a one-week log retention', () => {
    template.hasResourceProperties('Custom::LogRetention', { RetentionInDays: 7 });
  });
});
