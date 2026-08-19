import { Stack, StackProps, CfnOutput, Duration } from 'aws-cdk-lib';
import {
  OpenIdConnectProvider,
  Role,
  WebIdentityPrincipal,
  PolicyStatement,
} from 'aws-cdk-lib/aws-iam';
import type { TableV2 } from 'aws-cdk-lib/aws-dynamodb';
import { Construct } from 'constructs';

export interface VercelAccessStackProps extends StackProps {
  table: TableV2;
  /** Vercel team slug, e.g. "safwans-projects". */
  vercelTeamSlug: string;
  /** Vercel project name, e.g. "intern-tool". */
  vercelProjectName: string;
  /**
   * Which Vercel environments may assume the role.
   * Defaults to production only — a preview deploy should not read production
   * data by default.
   */
  environments?: string[];
}

/**
 * Lets Vercel functions read DynamoDB without any stored AWS credential.
 *
 * Vercel mints an OIDC token per invocation; AWS trades it for temporary STS
 * credentials scoped to this role. There is no IAM user and no access key —
 * nothing to rotate, nothing to leak, nothing to paste into an environment
 * variable.
 *
 * Enable OIDC for the project first: Vercel dashboard -> Project -> Settings ->
 * Security -> Secure Backend Access (OIDC Federation). The issuer URL below
 * must match what Vercel shows there.
 */
export class VercelAccessStack extends Stack {
  /** Exposed so other stacks can grant this role narrow, specific permissions. */
  public readonly role: Role;

  constructor(scope: Construct, id: string, props: VercelAccessStackProps) {
    super(scope, id, props);

    const { table, vercelTeamSlug, vercelProjectName } = props;
    const environments = props.environments ?? ['production'];

    const issuerUrl = `https://oidc.vercel.com/${vercelTeamSlug}`;

    const provider = new OpenIdConnectProvider(this, 'VercelOidcProvider', {
      url: issuerUrl,
      // Vercel's documented audience is the team-scoped issuer host.
      clientIds: [`https://vercel.com/${vercelTeamSlug}`],
      // No thumbprint list: IAM validates against the root CA. A pinned leaf
      // thumbprint goes stale on certificate rotation and fails much later as
      // an opaque auth error.
    });

    // Exact-match subs, one per environment. StringLike with a wildcard here
    // would let any project in the team assume the role.
    const subs = environments.map(
      (env) => `owner:${vercelTeamSlug}:project:${vercelProjectName}:environment:${env}`,
    );

    const role = new Role(this, 'VercelReadRole', {
      roleName: 'vercel-intern-tool-read',
      assumedBy: new WebIdentityPrincipal(provider.openIdConnectProviderArn, {
        StringEquals: {
          [`oidc.vercel.com/${vercelTeamSlug}:aud`]: `https://vercel.com/${vercelTeamSlug}`,
          [`oidc.vercel.com/${vercelTeamSlug}:sub`]: subs,
        },
      }),
      maxSessionDuration: Duration.hours(1),
      description: `Read-only DynamoDB access for ${vercelProjectName} (${environments.join(', ')})`,
    });

    // Read-only, and only this table. The scrape path writes; the website reads.
    role.addToPolicy(
      new PolicyStatement({
        actions: ['dynamodb:Query', 'dynamodb:GetItem', 'dynamodb:BatchGetItem'],
        resources: [table.tableArn, `${table.tableArn}/index/*`],
      }),
    );

    this.role = role;

    new CfnOutput(this, 'VercelRoleArn', {
      value: role.roleArn,
      description: 'Set as AWS_ROLE_ARN in the Vercel project environment',
    });

    new CfnOutput(this, 'VercelOidcIssuer', { value: issuerUrl });
  }
}
