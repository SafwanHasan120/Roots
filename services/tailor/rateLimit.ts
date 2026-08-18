/**
 * Per-user daily tailor quota, as a two-counter token bucket.
 *
 *   reserved  incremented at enqueue, under a conditional write. Bounds
 *             in-flight work so one user cannot queue hundreds of jobs.
 *   consumed  the user-facing daily count. Incremented ONLY when a job
 *             completes with a validated result.
 *
 * Charging on completion rather than at enqueue means a failed job costs the
 * user nothing. The cost is a leak: a worker killed mid-flight (Lambda timeout,
 * OOM) leaves `reserved` elevated until the item's end-of-day TTL, so that user
 * is under-quota for the rest of the day. That is deliberate and observable —
 * see docs/aws-migration.md — rather than silently overcharging.
 *
 * Both counters live on one item so every transition is a single conditional
 * UpdateItem. A read-then-write would race two concurrent requests at the limit
 * boundary and let both through.
 */

import { UpdateCommand, GetCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE } from '../scrape/ddb.js';
import { rateLimitKey } from '@infra/keys';

export const DAILY_LIMIT = Number(process.env.TAILOR_DAILY_LIMIT ?? 5);

/** UTC day key. Matches the pre-migration Firestore limiter's reset boundary. */
export function dayKey(now: number = Date.now()): string {
  return new Date(now).toISOString().slice(0, 10);
}

/** Epoch seconds at the next UTC midnight — when the bucket resets and expires. */
export function resetsAt(now: number = Date.now()): number {
  const d = new Date(now);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1) / 1000;
}

export class RateLimitedError extends Error {
  constructor(
    readonly used: number,
    readonly limit: number,
    readonly resets: number,
  ) {
    super('Daily tailor limit reached');
    this.name = 'RateLimitedError';
  }
}

export interface QuotaStatus {
  used: number;
  reserved: number;
  limit: number;
  resetsAt: number;
}

export async function getQuota(uid: string, now: number = Date.now()): Promise<QuotaStatus> {
  const res = await doc.send(
    new GetCommand({ TableName: TABLE, Key: rateLimitKey(uid, dayKey(now)) }),
  );
  return {
    used: (res.Item?.consumed as number) ?? 0,
    reserved: (res.Item?.reserved as number) ?? 0,
    limit: DAILY_LIMIT,
    resetsAt: resetsAt(now),
  };
}

/**
 * Claim a slot before enqueueing.
 *
 * The condition counts consumed + reserved together: a user with 4 consumed and
 * 1 in flight is at the limit, even though neither counter alone has reached it.
 *
 * Throws RateLimitedError when the bucket is full. The caller must NOT enqueue.
 */
export async function reserve(uid: string, now: number = Date.now()): Promise<void> {
  const ttl = resetsAt(now);

  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: rateLimitKey(uid, dayKey(now)),
        UpdateExpression:
          'SET #reserved = if_not_exists(#reserved, :zero) + :one, ' +
          '#consumed = if_not_exists(#consumed, :zero), ' +
          '#ttl = :ttl, updatedAt = :now',
        ConditionExpression:
          'attribute_not_exists(PK) OR ' +
          'if_not_exists(#consumed, :zero) + if_not_exists(#reserved, :zero) < :limit',
        ExpressionAttributeNames: {
          '#reserved': 'reserved',
          '#consumed': 'consumed',
          '#ttl': 'ttl',
        },
        ExpressionAttributeValues: {
          ':one': 1,
          ':zero': 0,
          ':limit': DAILY_LIMIT,
          ':ttl': ttl,
          ':now': now,
        },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      const quota = await getQuota(uid, now);
      throw new RateLimitedError(quota.used + quota.reserved, DAILY_LIMIT, ttl);
    }
    throw err;
  }
}

/**
 * Convert a reservation into a charge. Called only on a validated result.
 *
 * Guarded on `reserved > 0` so a retried worker cannot double-charge: SQS may
 * redeliver a message whose first attempt already succeeded.
 */
export async function consume(uid: string, now: number = Date.now()): Promise<void> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: rateLimitKey(uid, dayKey(now)),
        UpdateExpression:
          'SET #consumed = if_not_exists(#consumed, :zero) + :one, ' +
          '#reserved = #reserved - :one, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND #reserved > :zero',
        ExpressionAttributeNames: { '#reserved': 'reserved', '#consumed': 'consumed' },
        ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': now },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      // Already settled — a duplicate delivery. Not an error.
      console.warn(JSON.stringify({ msg: 'consume skipped, no reservation held', uid }));
      return;
    }
    throw err;
  }
}

/**
 * Return a reservation without charging. Called on failure and DLQ arrival.
 *
 * Same idempotency guard as consume: releasing twice must not drive `reserved`
 * negative, which would hand the user free quota.
 */
export async function release(uid: string, now: number = Date.now()): Promise<void> {
  try {
    await doc.send(
      new UpdateCommand({
        TableName: TABLE,
        Key: rateLimitKey(uid, dayKey(now)),
        UpdateExpression: 'SET #reserved = #reserved - :one, updatedAt = :now',
        ConditionExpression: 'attribute_exists(PK) AND #reserved > :zero',
        ExpressionAttributeNames: { '#reserved': 'reserved' },
        ExpressionAttributeValues: { ':one': 1, ':zero': 0, ':now': now },
      }),
    );
  } catch (err) {
    if ((err as { name?: string }).name === 'ConditionalCheckFailedException') {
      console.warn(JSON.stringify({ msg: 'release skipped, no reservation held', uid }));
      return;
    }
    throw err;
  }
}
