import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { awsCredentialsProvider } from '@vercel/functions/oidc';

/**
 * Shared DynamoDB client for the read path.
 *
 * Module-scoped so a warm Vercel function reuses the connection pool across
 * requests rather than paying TLS setup per render.
 *
 * Credentials come from Vercel's OIDC token, exchanged for a short-lived role
 * session. There is no access key anywhere in this codebase.
 *
 * The SDK's DEFAULT provider chain does not find that token — it looks for
 * env vars, a shared config file, and IMDS, none of which exist on Vercel, and
 * fails with "Could not load credentials from any providers". The web-identity
 * provider below is what actually reads it. Locally the token is absent, so we
 * fall through to the usual AWS profile instead.
 */

export const TABLE_NAME = process.env.DDB_TABLE_NAME ?? '';
export const AWS_REGION = process.env.AWS_REGION ?? 'us-west-2';

/** Thrown when AWS credentials are missing or rejected. */
export class CredentialError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'CredentialError';
  }
}

/** Thrown when the table is reachable but returns nothing. */
export class EmptyResultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'EmptyResultError';
  }
}

let cached: DynamoDBDocumentClient | null = null;

/** The role Vercel assumes. Absent locally, where the AWS profile is used. */
export const AWS_ROLE_ARN = process.env.AWS_ROLE_ARN;

/**
 * Credentials for the current environment.
 *
 * On Vercel: exchange the OIDC token for a role session.
 * Locally: return undefined so the SDK falls back to the shared AWS profile.
 *
 * Two things this must NOT do, both of which broke it before:
 *
 * 1. Read VERCEL_OIDC_TOKEN at module scope. Vercel injects that token per
 *    invocation, so at import time it is absent — a module-level check
 *    permanently disables OIDC on a warm function.
 * 2. Gate on the token's presence at all. `awsCredentialsProvider` reads it
 *    itself, lazily, at the moment credentials are needed. Checking first only
 *    creates a window where we silently fall through to a provider chain that
 *    cannot work on Vercel, producing "Could not load credentials from any
 *    providers" with no hint that OIDC was skipped.
 *
 * Deciding purely on AWS_ROLE_ARN means: role configured -> use OIDC and let it
 * surface its own errors; no role -> local development.
 */
export function resolveCredentials() {
  if (!AWS_ROLE_ARN) return undefined;
  return awsCredentialsProvider({ roleArn: AWS_ROLE_ARN });
}

export function getDocClient(): DynamoDBDocumentClient {
  if (cached) return cached;

  const client = new DynamoDBClient({
    region: AWS_REGION,
    credentials: resolveCredentials(),
    // Bounded so a slow AWS call fails fast rather than hanging a render until
    // the Vercel function timeout. These are per-request, not per-page.
    maxAttempts: 3,
    requestHandler: {
      requestTimeout: 3000,
      connectionTimeout: 2000,
    },
  });

  cached = DynamoDBDocumentClient.from(client, {
    marshallOptions: { removeUndefinedValues: true },
  });
  return cached;
}

/** Test seam: drops the memoized client so config changes take effect. */
export function resetDocClient(): void {
  cached = null;
}

/**
 * Classify an AWS SDK error so the caller can distinguish "we are misconfigured"
 * from "the query failed".
 *
 * Credential problems surface as a distinct 503 rather than a generic 500 —
 * otherwise a missing role reads like a code bug and costs an afternoon.
 */
export function isCredentialError(err: unknown): boolean {
  const name = (err as { name?: string })?.name ?? '';
  const message = (err as { message?: string })?.message ?? '';
  return (
    name === 'CredentialsProviderError' ||
    name === 'UnrecognizedClientException' ||
    name === 'InvalidSignatureException' ||
    name === 'ExpiredTokenException' ||
    name === 'AccessDeniedException' ||
    /credential|security token|not authorized/i.test(message)
  );
}
