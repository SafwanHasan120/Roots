import { NextRequest, NextResponse } from 'next/server';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { S3Client, GetObjectCommand } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { getDocClient, TABLE_NAME, AWS_REGION } from '@/lib/ddbClient';
import { verifyIdToken } from '@/lib/verifyFirebaseToken';

/**
 * Poll a tailor job and, once DONE, hand back a presigned URL for the artifact.
 *
 * Reads DynamoDB and presigns S3 directly rather than calling another Lambda: a
 * status Lambda would add a hop and a cold start to relocate two SDK calls this
 * function can already make. Presigning requires the signer to hold
 * s3:GetObject, which the Vercel OIDC role is granted for `jobs/*` only.
 */

const s3 = new S3Client({ region: AWS_REGION, maxAttempts: 3 });

/** Short-lived: long enough to download, short enough that a leaked link dies quickly. */
const URL_TTL_SECONDS = 15 * 60;

export async function GET(request: NextRequest) {
  const jobId = request.nextUrl.searchParams.get('jobId');
  if (!jobId?.trim()) {
    return NextResponse.json(
      { error: 'validation_failed', message: 'jobId is required' },
      { status: 400, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  // This endpoint hands out access to a user's private artifact, so it verifies
  // the token itself rather than trusting a uid from the query string.
  const token = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  let uid: string;
  try {
    if (!token) throw new Error('missing token');
    uid = (await verifyIdToken(token)).uid;
  } catch (err) {
    console.warn('Status request rejected:', err);
    return NextResponse.json(
      { error: 'unauthorized', message: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } },
    );
  }

  const headers = { 'Cache-Control': 'no-store' };

  try {
    const res = await getDocClient().send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `JOB#${jobId}`, SK: `JOB#${jobId}` },
      }),
    );

    if (!res.Item) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
    }

    // Ownership check. Job ids are UUIDs, but a 404 for someone else's job is
    // still the right answer — never confirm that another user's job exists.
    if (res.Item.uid !== uid) {
      return NextResponse.json({ error: 'not_found' }, { status: 404, headers });
    }

    const status = res.Item.status as string;

    if (status !== 'DONE') {
      // NEEDS_JD carries a message too: the client turns it into a paste box
      // rather than an error, so the copy matters as much as the code.
      return NextResponse.json(
        {
          jobId,
          status,
          ...(status === 'FAILED' || status === 'NEEDS_JD'
            ? { error: res.Item.errorCode, message: res.Item.error }
            : {}),
        },
        { status: 200, headers },
      );
    }

    const downloadUrl = await getSignedUrl(
      s3,
      new GetObjectCommand({
        Bucket: process.env.TAILOR_ARTIFACT_BUCKET,
        Key: res.Item.artifactKey as string,
      }),
      { expiresIn: URL_TTL_SECONDS },
    );

    return NextResponse.json(
      {
        jobId,
        status,
        downloadUrl,
        expiresIn: URL_TTL_SECONDS,
        coverageBefore: res.Item.coverageBefore ?? undefined,
        coverageAfter: res.Item.coverageAfter ?? undefined,
        degraded: res.Item.degraded ?? false,
      },
      { status: 200, headers },
    );
  } catch (err) {
    console.error('Failed to read job status:', err);
    return NextResponse.json(
      { error: 'internal_error', message: 'Could not read job status' },
      { status: 500, headers },
    );
  }
}
