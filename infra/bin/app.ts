#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { ScrapeStack } from '../lib/scrape-stack.js';
import { VercelAccessStack } from '../lib/vercel-access-stack.js';

const app = new App();

// Region is pinned rather than taken from the ambient CLI profile: a stack
// deployed to the wrong region would silently create a second, empty table.
// Account is left to the environment so CI and a laptop can both deploy.
const env = {
  account: process.env.CDK_DEFAULT_ACCOUNT,
  region: 'us-west-2',
};

const data = new DataStack(app, 'InternToolData', {
  env,
  description: 'Single-table DynamoDB store for listings, tailor jobs and rate limits',
});

const scrape = new ScrapeStack(app, 'InternToolScrape', {
  env,
  description: 'Scheduled scrape fan-out: EventBridge -> dispatcher -> SQS -> worker -> DynamoDB',
  table: data.table,
  // Optional. Set GITHUB_TOKEN_PARAM to an existing SSM SecureString to lift
  // the unauthenticated GitHub API rate limit.
  githubTokenParameterName: process.env.GITHUB_TOKEN_PARAM,
});

// Read access for the Vercel frontend, via OIDC federation. No IAM user, no
// access key — Vercel mints a token per invocation and trades it for temporary
// credentials scoped to this role.
const vercel = new VercelAccessStack(app, 'InternToolVercelAccess', {
  env,
  description: 'OIDC role letting Vercel functions read listings from DynamoDB',
  table: data.table,
  vercelTeamSlug: 'safwan-hasans-projects',
  vercelProjectName: 'intern-tool',
  // Production only: a preview branch should not reach production data.
  environments: ['production'],
});

// Applied app-wide so every resource is attributable in Cost Explorer, which
// is how the $1/month budget gets verified against something other than a
// whole-account total.
Tags.of(app).add('project', 'intern-tool');
Tags.of(app).add('managedBy', 'cdk');

export { data, scrape, vercel };
