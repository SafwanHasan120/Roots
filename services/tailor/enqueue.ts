/**
 * Tailor enqueue handler, behind an IAM-authed Lambda function URL.
 *
 * Verifies the caller's Firebase token, claims a quota slot, creates a job, and
 * returns 202 with a job id. No Claude call happens on this path — that is the
 * whole point of the sprint: an 8192-token completion cannot fit in a request
 * the browser is willing to wait for.
 *
 * Two independent gates, both required:
 *   IAM (function URL)  proves the caller is our Vercel deployment
 *   Firebase ID token   proves which user is asking
 *
 * The uid comes from the verified token, never from the request body — the
 * pre-migration route trusted a body field, so any caller could spend another
 * user's quota.
 */

import { randomUUID } from 'node:crypto';
import { SQSClient, SendMessageCommand } from '@aws-sdk/client-sqs';
import { verifyFirebaseToken, bearerFrom, AuthError } from './auth.js';
import { reserve, release, RateLimitedError, DAILY_LIMIT } from './rateLimit.js';
import { createJob } from './jobs.js';

const sqs = new SQSClient({ maxAttempts: 3 });

interface FunctionUrlEvent {
  body?: string;
  isBase64Encoded?: boolean;
  headers?: Record<string, string | undefined>;
  requestContext?: { http?: { method?: string } };
}

interface EnqueueBody {
  internshipId?: string;
  latex?: string;
}

function json(statusCode: number, body: unknown) {
  return {
    statusCode,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  };
}

/** Cap request size so one caller cannot push a multi-megabyte prompt. */
const MAX_LATEX_BYTES = 200_000;

export async function handler(event: FunctionUrlEvent) {
  const method = event.requestContext?.http?.method ?? 'POST';
  if (method !== 'POST') {
    return json(405, { error: 'method_not_allowed' });
  }

  // --- authenticate -------------------------------------------------------

  let uid: string;
  try {
    const token = bearerFrom(event.headers ?? {});
    if (!token) throw new AuthError('No bearer token');
    const user = await verifyFirebaseToken(token, requireEnv('FIREBASE_PROJECT_ID'));
    uid = user.uid;
  } catch (err) {
    if (err instanceof AuthError) {
      // Log the real reason, return the generic one.
      console.warn(JSON.stringify({ msg: 'auth rejected', reason: err.message }));
      return json(401, { error: 'unauthorized', message: err.clientMessage });
    }
    console.error(JSON.stringify({ msg: 'auth error', error: String(err) }));
    return json(401, { error: 'unauthorized', message: 'Unauthorized' });
  }

  // --- validate -----------------------------------------------------------

  let body: EnqueueBody;
  try {
    const raw = event.isBase64Encoded
      ? Buffer.from(event.body ?? '', 'base64').toString('utf8')
      : (event.body ?? '');
    body = JSON.parse(raw) as EnqueueBody;
  } catch {
    return json(400, { error: 'validation_failed', message: 'Malformed JSON body' });
  }

  const internshipId = body.internshipId?.trim();
  const latex = body.latex;

  if (!internshipId || !latex?.trim()) {
    return json(400, {
      error: 'validation_failed',
      message: 'internshipId and latex are required',
    });
  }
  if (Buffer.byteLength(latex, 'utf8') > MAX_LATEX_BYTES) {
    return json(413, {
      error: 'payload_too_large',
      message: 'Resume exceeds the maximum supported size',
    });
  }

  // --- claim quota --------------------------------------------------------
  //
  // Reserved before the job exists so a burst of concurrent requests cannot all
  // pass the check. This is a claim, not a charge: the worker converts it to
  // `consumed` only on a validated result, and releases it on failure.

  try {
    await reserve(uid);
  } catch (err) {
    if (err instanceof RateLimitedError) {
      return json(429, {
        error: 'rate_limited',
        message: `Daily limit of ${DAILY_LIMIT} tailored resumes reached`,
        used: err.used,
        limit: err.limit,
        resetsAt: err.resets,
      });
    }
    throw err;
  }

  // --- create job and enqueue ---------------------------------------------

  const jobId = randomUUID();

  try {
    await createJob({ jobId, uid, internshipId });

    await sqs.send(
      new SendMessageCommand({
        QueueUrl: requireEnv('TAILOR_QUEUE_URL'),
        MessageBody: JSON.stringify({ jobId, uid, internshipId, latex }),
      }),
    );
  } catch (err) {
    // The reservation must not outlive a job that never made it onto the queue,
    // or the user loses quota to work that will never run.
    await release(uid).catch((e) =>
      console.error(JSON.stringify({ msg: 'failed to release reservation', uid, error: String(e) })),
    );
    throw err;
  }

  console.log(JSON.stringify({ msg: 'enqueued', jobId, uid, internshipId }));

  return json(202, { jobId, status: 'QUEUED' });
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
