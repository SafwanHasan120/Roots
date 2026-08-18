import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { VercelAccessStack } from '../vercel-access-stack.js';

const TEAM = 'safwan-hasans-projects';
const PROJECT = 'intern-tool';

function synth(environments?: string[]): Template {
  const app = new App();
  const env = { account: '123456789012', region: 'us-west-2' };
  const data = new DataStack(app, 'TestData', { env });
  const stack = new VercelAccessStack(app, 'TestVercel', {
    env,
    table: data.table,
    vercelTeamSlug: TEAM,
    vercelProjectName: PROJECT,
    environments,
  });
  return Template.fromStack(stack);
}

/**
 * Trust conditions on the Vercel role specifically.
 *
 * CDK's OpenIdConnectProvider construct is backed by a custom resource with its
 * own Lambda service role, so "the first IAM::Role" is not ours. Select by the
 * federated principal instead.
 */
function trustConditions(template: Template): Record<string, Record<string, unknown>> {
  const roles = template.findResources('AWS::IAM::Role');
  const federated = Object.values(roles).filter((r) =>
    r.Properties.AssumeRolePolicyDocument.Statement.some(
      (s: { Principal?: Record<string, unknown> }) => s.Principal?.Federated !== undefined,
    ),
  );

  expect(federated, 'expected exactly one web-identity role').toHaveLength(1);

  const statement = federated[0].Properties.AssumeRolePolicyDocument.Statement.find(
    (s: { Principal?: Record<string, unknown> }) => s.Principal?.Federated !== undefined,
  );
  return statement.Condition;
}

/** Inline policies attached to the Vercel role, excluding CDK's own machinery. */
function vercelPolicyStatements(template: Template): Array<Record<string, unknown>> {
  const policies = template.findResources('AWS::IAM::Policy');
  return Object.values(policies)
    .flatMap((p) => p.Properties.PolicyDocument.Statement)
    .filter((s: { Action: string | string[] }) =>
      [s.Action].flat().some((a) => String(a).startsWith('dynamodb:')),
    );
}

describe('VercelAccessStack', () => {
  let template: Template;

  beforeAll(() => {
    template = synth();
  });

  it('creates no IAM user and no access key', () => {
    // The entire point: nothing to rotate, nothing to leak, nothing to paste
    // into an environment variable.
    template.resourceCountIs('AWS::IAM::User', 0);
    template.resourceCountIs('AWS::IAM::AccessKey', 0);
  });

  it('registers the team-scoped Vercel OIDC issuer', () => {
    template.hasResourceProperties('Custom::AWSCDKOpenIdConnectProvider', {
      Url: `https://oidc.vercel.com/${TEAM}`,
      ClientIDList: [`https://vercel.com/${TEAM}`],
    });
  });

  it('pins no certificate thumbprint', () => {
    // IAM validates against the root CA. A pinned leaf thumbprint goes stale on
    // rotation and fails later as an opaque auth error.
    const providers = template.findResources('Custom::AWSCDKOpenIdConnectProvider');
    const props = Object.values(providers)[0].Properties;
    expect(props.ThumbprintList ?? []).toHaveLength(0);
  });

  describe('trust policy', () => {
    it('matches sub and aud exactly, never with a wildcard', () => {
      // StringLike with a wildcard would let any project in the team assume
      // this role — including one opened from a fork.
      const conditions = trustConditions(template);

      expect(conditions.StringEquals).toBeDefined();
      expect(conditions.StringLike).toBeUndefined();

      const serialized = JSON.stringify(conditions);
      expect(serialized).not.toContain('*');
    });

    it('scopes the sub to this exact team, project and environment', () => {
      const conditions = trustConditions(template);
      expect(conditions.StringEquals[`oidc.vercel.com/${TEAM}:sub`]).toEqual([
        `owner:${TEAM}:project:${PROJECT}:environment:production`,
      ]);
    });

    it('restricts the audience', () => {
      const conditions = trustConditions(template);
      expect(conditions.StringEquals[`oidc.vercel.com/${TEAM}:aud`]).toBe(
        `https://vercel.com/${TEAM}`,
      );
    });

    it('excludes preview deployments by default', () => {
      const subs = trustConditions(template).StringEquals[
        `oidc.vercel.com/${TEAM}:sub`
      ] as string[];
      expect(subs.some((s) => s.includes('preview'))).toBe(false);
    });

    it('can be widened to preview deliberately', () => {
      const subs = trustConditions(synth(['production', 'preview'])).StringEquals[
        `oidc.vercel.com/${TEAM}:sub`
      ] as string[];
      expect(subs).toHaveLength(2);
      expect(subs).toContain(`owner:${TEAM}:project:${PROJECT}:environment:preview`);
    });
  });

  describe('permissions', () => {
    it('grants read actions only', () => {
      // The website reads; the scrape path writes. A stray write action here
      // would let a frontend bug corrupt the corpus.
      const actions = vercelPolicyStatements(template).flatMap((s) =>
        [s.Action as string | string[]].flat(),
      );

      expect(actions.length).toBeGreaterThan(0);
      for (const action of actions) {
        expect(action).toMatch(/^dynamodb:(Query|GetItem|BatchGetItem)$/);
      }
    });

    it('grants no wildcard resource', () => {
      const resources = vercelPolicyStatements(template).flatMap((s) =>
        [s.Resource as unknown].flat(),
      );
      expect(resources.length).toBeGreaterThan(0);
      expect(resources).not.toContain('*');
    });

    it('caps the session at one hour', () => {
      template.hasResourceProperties('AWS::IAM::Role', { MaxSessionDuration: 3600 });
    });
  });

  it('outputs the role ARN for the Vercel environment', () => {
    template.hasOutput('VercelRoleArn', {});
  });
});
