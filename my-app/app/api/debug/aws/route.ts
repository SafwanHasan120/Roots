import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { STSClient, GetCallerIdentityCommand } from '@aws-sdk/client-sts';
import { AWS_REGION, resolveCredentials } from '@/lib/ddbClient';

export const dynamic = 'force-dynamic';

/**
 * Reports what the deployed runtime can actually see and do with AWS.
 *
 * Exists because "Could not load credentials from any providers" is the same
 * message for a missing role ARN, an absent OIDC token, and a rejected assume —
 * three different fixes, and no way to tell them apart from the outside.
 *
 * Guarded by METRICS_SECRET: it reports whether secrets are present, never
 * their values, but the assumed-role ARN is still infrastructure detail.
 *
 * Safe to delete once the credential path is confirmed working.
 */
export async function GET(request: NextRequest) {
  const expected = process.env.METRICS_SECRET;
  if (!expected) {
    return NextResponse.json(
      { error: 'METRICS_SECRET is not configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } },
    );
  }
  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided !== expected) {
    return NextResponse.json(
      { error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // Presence only — never the values.
  const env = {
    onVercel: Boolean(process.env.VERCEL),
    vercelEnv: process.env.VERCEL_ENV ?? null,
    AWS_ROLE_ARN: Boolean(process.env.AWS_ROLE_ARN),
    VERCEL_OIDC_TOKEN: Boolean(process.env.VERCEL_OIDC_TOKEN),
    AWS_REGION: process.env.AWS_REGION ?? null,
    DDB_TABLE_NAME: Boolean(process.env.DDB_TABLE_NAME),
    resolvedProvider: resolveCredentials() ? 'oidc' : 'default-chain',
  };

  // The real test: can we actually assume the role? Returns the assumed-role
  // ARN, which also confirms WHICH role and session.
  let identity: Record<string, unknown>;
  try {
    const sts = new STSClient({ region: AWS_REGION, credentials: resolveCredentials() });
    const res = await sts.send(new GetCallerIdentityCommand({}));
    identity = { ok: true, arn: res.Arn, account: res.Account };
  } catch (err) {
    identity = {
      ok: false,
      name: (err as Error).name,
      message: (err as Error).message,
      cause: (err as { cause?: Error }).cause?.message ?? null,
    };
  }

  return NextResponse.json(
    { env, identity },
    { status: 200, headers: { 'Cache-Control': 'no-store' } },
  );
}
