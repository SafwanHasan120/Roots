import { Stack, StackProps, RemovalPolicy, CfnOutput } from 'aws-cdk-lib';
import {
  TableV2,
  AttributeType,
  Billing,
  ProjectionType,
} from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';
import { ATTR, INDEX } from './keys.js';

/**
 * The single DynamoDB table every other stack attaches to.
 *
 * Deliberately its own stack: it holds all the state, and separating it means
 * `cdk destroy` on a compute stack can never take the data with it. Removal
 * policy is RETAIN for the same reason.
 */
export class DataStack extends Stack {
  public readonly table: TableV2;

  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    this.table = new TableV2(this, 'AppTable', {
      partitionKey: { name: ATTR.pk, type: AttributeType.STRING },
      sortKey: { name: ATTR.sk, type: AttributeType.STRING },

      // On-demand. The 25 WCU/RCU free allowance is provisioned-mode only, so
      // this is not free — but at this volume it is fractions of a cent, and
      // provisioned mode would trade that for capacity management the project
      // does not need. The $1 budget alarm is the guard. See
      // docs/aws-migration.md.
      billing: Billing.onDemand(),

      // Deleting the stack must not delete the listings.
      removalPolicy: RemovalPolicy.RETAIN,

      // TTL drives expiry of tailor jobs and rate-limit buckets. Listings do
      // not set this attribute and so are never auto-deleted.
      timeToLiveAttribute: 'ttl',

      // Point-in-time recovery bills per GB-month; off deliberately.
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false },

      globalSecondaryIndexes: [
        {
          // Recency across all active listings, sharded on a hash of the
          // listing id. Inactive listings omit GSI1PK entirely and so fall out
          // of this index rather than needing to be filtered from every read.
          indexName: INDEX.recency,
          partitionKey: { name: ATTR.gsi1pk, type: AttributeType.STRING },
          sortKey: { name: ATTR.gsi1sk, type: AttributeType.STRING },
          // The homepage renders straight from these fields; projecting them
          // avoids a base-table read per row. Anything not listed here (e.g.
          // the hash used for idempotent upserts) is intentionally excluded —
          // projected attributes are billed as a second copy of the data.
          projectionType: ProjectionType.INCLUDE,
          nonKeyAttributes: [
            'id',
            'company',
            'companyUrl',
            'role',
            'location',
            'appUrl',
            'datePosted',
            'dateMs',
            'prestigeScore',
            'source',
            'linkHealth',
            'isExpired',
            'expirationReason',
          ],
        },
        {
          // Per-company lookup. Company lives here rather than on the base
          // table so that a change in companyNormalizer output rewrites an
          // index entry instead of orphaning the item under a stale key.
          indexName: INDEX.company,
          partitionKey: { name: ATTR.gsi2pk, type: AttributeType.STRING },
          sortKey: { name: ATTR.gsi2sk, type: AttributeType.STRING },
          projectionType: ProjectionType.INCLUDE,
          nonKeyAttributes: [
            'id',
            'company',
            'role',
            'location',
            'appUrl',
            'datePosted',
            'dateMs',
            'active',
          ],
        },
      ],
    });

    new CfnOutput(this, 'TableName', {
      value: this.table.tableName,
      description: 'Single-table store for listings, jobs and rate limits',
      exportName: `${this.stackName}-TableName`,
    });

    new CfnOutput(this, 'TableArn', {
      value: this.table.tableArn,
      exportName: `${this.stackName}-TableArn`,
    });
  }
}
