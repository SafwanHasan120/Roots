import { NextRequest, NextResponse } from 'next/server';
import { signedFetch } from '@/lib/awsSign';

/**
 * Enqueue a tailor job.
 *
 * This route used to run the whole pipeline inline — JD extraction plus two
 * Claude calls, up to 8192 tokens, inside one HTTP request. That is now an
 * async job on AWS; this handler only forwards the request and returns a job id
 * for the client to poll.
 *
 * Two auth layers, both required:
 *   - This route signs with SigV4 using Vercel's OIDC role, so Lambda's
 *     AWS_IAM function URL accepts the call at all.
 *   - The user's Firebase ID token rides through in the Authorization header
 *     and is verified inside the Lambda, which is where `uid` comes from.
 *
 * The previous version read `uid` from the request body, so any caller could
 * spend another user's quota. The client no longer sends it.
 */
export async function POST(request: NextRequest) {
  const enqueueUrl = process.env.TAILOR_ENQUEUE_URL;
  if (!enqueueUrl) {
    console.error('TAILOR_ENQUEUE_URL is not configured');
    return NextResponse.json(
      { error: 'not_configured', message: 'Tailoring is unavailable.' },
      { status: 503 },
    );
  }

  // Pass the caller's token straight through; this route never inspects it.
  // Verification belongs in the Lambda, where the uid is actually used.
  const authorization = request.headers.get('authorization');
  if (!authorization) {
    return NextResponse.json(
      { error: 'unauthorized', message: 'Sign in to tailor a resume.' },
      { status: 401 },
    );
  }

  const body = await request.text();

  try {
    const upstream = await signedFetch(enqueueUrl, {
      method: 'POST',
      body,
      headers: { authorization },
    });

    const text = await upstream.text();
    return new NextResponse(text, {
      status: upstream.status,
      headers: {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
      },
    });
  } catch (err) {
    console.error('Failed to reach the tailor service:', err);
    return NextResponse.json(
      { error: 'upstream_unavailable', message: 'Tailoring is temporarily unavailable.' },
      { status: 502, headers: { 'Cache-Control': 'no-store' } },
    );
  }
}
