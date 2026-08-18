/**
 * Standing negative assertions.
 *
 * These encode the project's cost and security constraints as CI failures
 * rather than review comments. They synthesize the WHOLE app, so a forbidden
 * resource added to any future stack fails here without anyone remembering to
 * extend this file.
 *
 * The constraint is NOT "always free" — that was wrong. DynamoDB's 25 WCU/RCU
 * allowance is provisioned-mode only, and this table is on-demand, so there is
 * a real per-request cost. The constraint is: no service carrying a standing
 * hourly or monthly charge, and total spend under $1/month.
 *
 * Note there is deliberately NO assertion on billing mode. Billing mode is a
 * cost decision governed by the budget alarm, not a structural one.
 */

import { describe, it, expect } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { ScrapeStack } from '../scrape-stack.js';
import { VercelAccessStack } from '../vercel-access-stack.js';

/**
 * Resource types that must never appear.
 *
 * Each carries either a standing charge that blows the budget on its own, or
 * (for the IAM entries) reintroduces the static credentials the OIDC setup
 * exists to eliminate.
 */
const FORBIDDEN: Array<[type: string, why: string]> = [
  ['AWS::EC2::NatGateway', 'standing hourly charge, ~$32/month'],
  ['AWS::RDS::DBInstance', 'standing hourly charge; no RDS'],
  ['AWS::RDS::DBCluster', 'standing hourly charge; no Aurora'],
  ['AWS::EC2::EIP', 'charged when unattached'],
  ['AWS::ApiGateway::RestApi', 'excluded; Lambda function URLs instead'],
  ['AWS::ApiGatewayV2::Api', 'excluded; Lambda function URLs instead'],
  ['AWS::AppSync::GraphQLApi', 'excluded by the constraints'],
  ['AWS::SecretsManager::Secret', 'per-secret monthly charge; SSM Parameter Store Standard instead'],
  ['AWS::Budgets::Budget', 'budget is created by hand so cdk destroy cannot remove the cost guardrail'],
  ['AWS::IAM::User', 'no IAM users; GitHub and Vercel authenticate via OIDC'],
  ['AWS::IAM::AccessKey', 'no static credentials, anywhere, ever'],
  ['AWS::ElasticLoadBalancingV2::LoadBalancer', 'standing hourly charge'],
  ['AWS::EC2::Instance', 'standing hourly charge'],
  ['AWS::ECS::Cluster', 'not part of this architecture'],
  ['AWS::EFS::FileSystem', 'standing monthly charge'],
];

/** Every stack in the app, synthesized once. */
function synthesizeAll(): Array<{ name: string; template: Template }> {
  const app = new App();
  const env = { account: '123456789012', region: 'us-west-2' };

  // Every stack in the app must appear here, so a forbidden resource added to
  // any of them fails CI without anyone remembering to extend this file.
  const data = new DataStack(app, 'ConstraintsData', { env });
  const stacks = [
    data,
    new ScrapeStack(app, 'ConstraintsScrape', { env, table: data.table }),
    new VercelAccessStack(app, 'ConstraintsVercel', {
      env,
      table: data.table,
      vercelTeamSlug: 'safwan-hasans-projects',
      vercelProjectName: 'intern-tool',
    }),
  ];

  return stacks.map((s) => ({ name: s.stackName, template: Template.fromStack(s) }));
}

describe('free-tier and security constraints', () => {
  const synthesized = synthesizeAll();

  it('synthesizes at least one stack (guards against this suite passing vacuously)', () => {
    // Without this, deleting every stack would make the whole file green.
    expect(synthesized.length).toBeGreaterThan(0);
  });

  describe.each(synthesized)('$name', ({ template }) => {
    it.each(FORBIDDEN)('contains no %s (%s)', (type) => {
      template.resourceCountIs(type, 0);
    });

    it('attaches no Lambda to a VPC', () => {
      // A VPC-attached Lambda needs a NAT Gateway to reach the internet, which
      // is the single largest cost risk in this architecture.
      const fns = template.findResources('AWS::Lambda::Function');
      for (const [id, fn] of Object.entries(fns)) {
        const vpcConfig = fn.Properties?.VpcConfig;
        expect(vpcConfig, `${id} must not declare VpcConfig`).toBeUndefined();
      }
    });

    it('creates no VPC', () => {
      template.resourceCountIs('AWS::EC2::VPC', 0);
    });

    it('grants no wildcard-resource admin policy', () => {
      // Catches an AdministratorAccess-shaped inline policy sneaking in.
      const policies = {
        ...template.findResources('AWS::IAM::Policy'),
        ...template.findResources('AWS::IAM::ManagedPolicy'),
      };

      for (const [id, policy] of Object.entries(policies)) {
        const statements = policy.Properties?.PolicyDocument?.Statement ?? [];
        for (const stmt of statements) {
          if (stmt.Effect !== 'Allow') continue;
          const actions = [stmt.Action].flat().filter(Boolean);
          const resources = [stmt.Resource].flat().filter(Boolean);
          const wildcardAction = actions.includes('*');
          const wildcardResource = resources.includes('*');
          expect(
            wildcardAction && wildcardResource,
            `${id} grants Action:* on Resource:*`,
          ).toBe(false);
        }
      }
    });
  });
});

describe('log retention', () => {
  // Log groups default to "never expire", which accrues storage cost forever.
  // No functions exist yet in Sprint 0; this asserts the rule holds as soon as
  // any appear, rather than being remembered later.
  const synthesized = synthesizeAll();

  describe.each(synthesized)('$name', ({ template }) => {
    it('sets an explicit retention on every log group', () => {
      const groups = template.findResources('AWS::Logs::LogGroup');
      for (const [id, group] of Object.entries(groups)) {
        expect(
          group.Properties?.RetentionInDays,
          `${id} must set RetentionInDays`,
        ).toBeDefined();
      }
    });
  });
});
