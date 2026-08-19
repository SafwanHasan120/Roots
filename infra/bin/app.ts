#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';
import { ScrapeStack } from '../lib/scrape-stack.js';
import { VercelAccessStack } from '../lib/vercel-access-stack.js';
import { TailorStack } from '../lib/tailor-stack.js';
import { OpsStack } from '../lib/ops-stack.js';

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

// Async tailor path. Depends on the Vercel role so the function URL can be
// IAM-authed: only our Vercel deployment may invoke it.
const tailor = new TailorStack(app, 'InternToolTailor', {
  env,
  description: 'Async resume tailoring: function URL -> SQS -> worker -> S3',
  table: data.table,
  anthropicKeyParameterName:
    process.env.ANTHROPIC_KEY_PARAM ?? '/intern-tool/anthropic-api-key',
  // Must match NEXT_PUBLIC_FIREBASE_PROJECT_ID in my-app/.env.local — it is the
  // expected `aud` and `iss` on every ID token, so a wrong value rejects all of
  // them with an indistinguishable 401.
  firebaseProjectId: process.env.FIREBASE_PROJECT_ID ?? 'intern-tool-4224a',
  vercelRole: vercel.role,
});

// Alarms and dashboard. Observation-only — nothing in the data path depends on
// it, so `cdk destroy` here is always safe. Contains no budget: that is created
// by hand precisely so a teardown cannot remove the cost guardrail.
const ops = new OpsStack(app, 'InternToolOps', {
  env,
  description: 'Alarms and dashboard for the scrape and tailor paths',
  table: data.table,
  scrapeDlq: scrape.dlq,
  tailorDlq: tailor.dlq,
  dispatcher: scrape.dispatcher,
  scrapeWorker: scrape.worker,
  tailorEnqueue: tailor.enqueueFn,
  tailorWorker: tailor.workerFn,
  alertEmail: process.env.ALERT_EMAIL ?? 'sh1041281@gmail.com',
});

// Applied app-wide so every resource is attributable in Cost Explorer, which
// is how the $1/month budget gets verified against something other than a
// whole-account total.
Tags.of(app).add('project', 'intern-tool');
Tags.of(app).add('managedBy', 'cdk');

export { data, scrape, vercel, tailor, ops };
