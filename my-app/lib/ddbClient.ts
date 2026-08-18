import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

/**
 * Shared DynamoDB client for the read path.
 *
 * Module-scoped so a warm Vercel function reuses the connection pool across
 * requests rather than paying TLS setup per render.
 *
 * Credentials are NOT configured here. On Vercel the function assumes an IAM
 * role via OIDC and the SDK's default provider chain picks it up from the
 * ambient environment; locally it comes from the usual AWS profile. There is no
 * access key anywhere in this codebase.
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

export function getDocClient(): DynamoDBDocumentClient {
  if (cached) return cached;

  const client = new DynamoDBClient({
    region: AWS_REGION,
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
