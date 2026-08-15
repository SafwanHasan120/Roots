import { describe, it, expect, beforeAll } from 'vitest';
import { App } from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { DataStack } from '../data-stack.js';
import { ATTR, INDEX } from '../keys.js';

describe('DataStack', () => {
  let template: Template;

  beforeAll(() => {
    const app = new App();
    const stack = new DataStack(app, 'TestData', {
      env: { account: '123456789012', region: 'us-west-2' },
    });
    template = Template.fromStack(stack);
  });

  it('creates exactly one table', () => {
    template.resourceCountIs('AWS::DynamoDB::GlobalTable', 1);
  });

  it('keys the table on PK/SK as strings', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      KeySchema: [
        { AttributeName: ATTR.pk, KeyType: 'HASH' },
        { AttributeName: ATTR.sk, KeyType: 'RANGE' },
      ],
    });
  });

  it('retains the table when the stack is destroyed', () => {
    // The whole point of putting the table in its own stack. If this flips to
    // Delete, a cdk destroy takes every listing with it.
    template.hasResource('AWS::DynamoDB::GlobalTable', {
      DeletionPolicy: 'Retain',
      UpdateReplacePolicy: 'Retain',
    });
  });

  it('enables TTL on the ttl attribute', () => {
    template.hasResourceProperties('AWS::DynamoDB::GlobalTable', {
      Replicas: Match.arrayWith([
        Match.objectLike({
          // TTL is replica-level config in the GlobalTable shape.
          Region: 'us-west-2',
        }),
      ]),
    });

    const tables = template.findResources('AWS::DynamoDB::GlobalTable');
    const props = Object.values(tables)[0].Properties;
    expect(props.TimeToLiveSpecification).toEqual({
      AttributeName: 'ttl',
      Enabled: true,
    });
  });

  describe('indexes', () => {
    it('defines exactly two GSIs, named GSI1 and GSI2', () => {
      const tables = template.findResources('AWS::DynamoDB::GlobalTable');
      const gsis = Object.values(tables)[0].Properties.GlobalSecondaryIndexes;

      expect(gsis).toHaveLength(2);
      expect(gsis.map((g: { IndexName: string }) => g.IndexName)).toEqual([
        INDEX.recency,
        INDEX.company,
      ]);
    });

    it('keys GSI1 for sharded recency', () => {
      const tables = template.findResources('AWS::DynamoDB::GlobalTable');
      const gsi1 = Object.values(tables)[0].Properties.GlobalSecondaryIndexes.find(
        (g: { IndexName: string }) => g.IndexName === INDEX.recency,
      );

      expect(gsi1.KeySchema).toEqual([
        { AttributeName: ATTR.gsi1pk, KeyType: 'HASH' },
        { AttributeName: ATTR.gsi1sk, KeyType: 'RANGE' },
      ]);
      expect(gsi1.Projection.ProjectionType).toBe('INCLUDE');
    });

    it('keys GSI2 for company lookup', () => {
      const tables = template.findResources('AWS::DynamoDB::GlobalTable');
      const gsi2 = Object.values(tables)[0].Properties.GlobalSecondaryIndexes.find(
        (g: { IndexName: string }) => g.IndexName === INDEX.company,
      );

      expect(gsi2.KeySchema).toEqual([
        { AttributeName: ATTR.gsi2pk, KeyType: 'HASH' },
        { AttributeName: ATTR.gsi2sk, KeyType: 'RANGE' },
      ]);
    });

    it('projects the fields the homepage renders, so reads need no base-table fetch', () => {
      const tables = template.findResources('AWS::DynamoDB::GlobalTable');
      const gsi1 = Object.values(tables)[0].Properties.GlobalSecondaryIndexes.find(
        (g: { IndexName: string }) => g.IndexName === INDEX.recency,
      );

      // These are what ranker.ts consumes. Dropping one silently forces the
      // read path into N base-table GetItems.
      for (const attr of ['company', 'role', 'location', 'appUrl', 'dateMs', 'prestigeScore']) {
        expect(gsi1.Projection.NonKeyAttributes).toContain(attr);
      }
    });
  });

  it('does not enable point-in-time recovery', () => {
    // PITR bills per GB-month. Deliberately off; flag it if it turns on.
    const tables = template.findResources('AWS::DynamoDB::GlobalTable');
    const props = Object.values(tables)[0].Properties;
    const replica = props.Replicas?.[0];
    const pitr = replica?.PointInTimeRecoverySpecification;
    expect(pitr?.PointInTimeRecoveryEnabled ?? false).toBe(false);
  });

  it('exports the table name and ARN for other stacks', () => {
    template.hasOutput('TableName', {});
    template.hasOutput('TableArn', {});
  });
});
