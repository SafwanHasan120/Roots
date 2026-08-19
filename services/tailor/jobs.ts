/**
 * Tailor job records.
 *
 * A job is the unit the client polls. It carries status, the S3 key of the
 * finished artifact, and a user-safe error message — never a raw exception,
 * which can leak URLs, prompts, or stack frames to the browser.
 */

import { PutCommand, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE } from '../scrape/ddb.js';
import { jobKey } from '@infra/keys';

/**
 * NEEDS_JD is a settled state, not an error: automatic extraction found no
 * usable description (common on client-rendered boards like Workday), so the
 * user is asked to paste it. The quota reservation is released, and the client
 * resubmits with `manualJd`.
 */
export type JobStatus = 'QUEUED' | 'RUNNING' | 'DONE' | 'FAILED' | 'NEEDS_JD';

export interface JobRecord {
  jobId: string;
  uid: string;
  internshipId: string;
  status: JobStatus;
  createdAt: number;
  updatedAt: number;
  /** S3 key of the tailored .tex, once DONE. */
  artifactKey?: string;
  coverageBefore?: number;
  coverageAfter?: number;
  degraded?: boolean;
  /** User-safe failure message. */
  error?: string;
  errorCode?: string;
}

/** Jobs expire after 30 days, matching the S3 lifecycle rule on the artifact. */
const JOB_TTL_DAYS = 30;

export async function createJob(input: {
  jobId: string;
  uid: string;
  internshipId: string;
  now?: number;
}): Promise<JobRecord> {
  const now = input.now ?? Date.now();
  const record: JobRecord = {
    jobId: input.jobId,
    uid: input.uid,
    internshipId: input.internshipId,
    status: 'QUEUED',
    createdAt: now,
    updatedAt: now,
  };

  await doc.send(
    new PutCommand({
      TableName: TABLE,
      Item: {
        ...jobKey(input.jobId),
        ...record,
        ttl: Math.floor(now / 1000) + JOB_TTL_DAYS * 86400,
      },
      // A duplicate jobId would silently overwrite another user's job.
      ConditionExpression: 'attribute_not_exists(PK)',
    }),
  );

  return record;
}

export async function getJob(jobId: string): Promise<JobRecord | null> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: jobKey(jobId) }));
  if (!res.Item) return null;
  const { PK: _pk, SK: _sk, ttl: _ttl, ...record } = res.Item;
  return record as JobRecord;
}

export async function markRunning(jobId: string, now: number = Date.now()): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: jobKey(jobId),
      UpdateExpression: 'SET #status = :running, updatedAt = :now',
      // Only from QUEUED: a redelivered message whose first attempt already
      // finished must not drag a DONE job back to RUNNING.
      ConditionExpression: 'attribute_exists(PK) AND #status = :queued',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: { ':running': 'RUNNING', ':queued': 'QUEUED', ':now': now },
    }),
  );
}

export async function markDone(
  jobId: string,
  result: {
    artifactKey: string;
    coverageBefore?: number;
    coverageAfter?: number;
    degraded?: boolean;
  },
  now: number = Date.now(),
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: jobKey(jobId),
      UpdateExpression:
        'SET #status = :done, artifactKey = :key, updatedAt = :now, ' +
        'coverageBefore = :before, coverageAfter = :after, degraded = :degraded',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status' },
      ExpressionAttributeValues: {
        ':done': 'DONE',
        ':key': result.artifactKey,
        ':before': result.coverageBefore ?? null,
        ':after': result.coverageAfter ?? null,
        ':degraded': result.degraded ?? false,
        ':now': now,
      },
    }),
  );
}

/**
 * Settle a job as needing a pasted job description.
 *
 * Separate from markFailed so failure-rate alarms are not polluted by an
 * outcome that is expected on client-rendered job boards, and so the client can
 * show an input box rather than a retry button.
 */
export async function markNeedsJd(
  jobId: string,
  errorCode: string,
  clientMessage: string,
  now: number = Date.now(),
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: jobKey(jobId),
      UpdateExpression:
        'SET #status = :needs, #error = :msg, errorCode = :code, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: {
        ':needs': 'NEEDS_JD',
        ':msg': clientMessage,
        ':code': errorCode,
        ':now': now,
      },
    }),
  );
}

export async function markFailed(
  jobId: string,
  errorCode: string,
  clientMessage: string,
  now: number = Date.now(),
): Promise<void> {
  await doc.send(
    new UpdateCommand({
      TableName: TABLE,
      Key: jobKey(jobId),
      UpdateExpression:
        'SET #status = :failed, #error = :msg, errorCode = :code, updatedAt = :now',
      ConditionExpression: 'attribute_exists(PK)',
      ExpressionAttributeNames: { '#status': 'status', '#error': 'error' },
      ExpressionAttributeValues: {
        ':failed': 'FAILED',
        ':msg': clientMessage,
        ':code': errorCode,
        ':now': now,
      },
    }),
  );
}
