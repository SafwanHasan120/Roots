#!/usr/bin/env node
import { App, Tags } from 'aws-cdk-lib';
import { DataStack } from '../lib/data-stack.js';

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

// Applied app-wide so every resource is attributable in Cost Explorer, which
// is how the $1/month budget gets verified against something other than a
// whole-account total.
Tags.of(app).add('project', 'intern-tool');
Tags.of(app).add('managedBy', 'cdk');

export { data };
