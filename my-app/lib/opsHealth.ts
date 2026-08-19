import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { SQSClient, GetQueueAttributesCommand } from '@aws-sdk/client-sqs';
import { getDocClient, TABLE_NAME, AWS_REGION } from './ddbClient';

/**
 * Operational health, for the metrics endpoint.
 *
 * Answers the questions CloudWatch alarms also watch, but in one place a human
 * can curl: is anything dead-lettered, when did the scrape last run, and are
 * any tailor quota reservations leaked?
 *
 * Every field degrades to null rather than throwing. This endpoint exists to
 * report on the health of other things; it must not itself be the thing that
 * breaks.
 */

const sqs = new SQSClient({ region: AWS_REGION, maxAttempts: 2 });

export interface OpsHealth {
  scrape: {
    lastRunId: string | null;
    lastRunAt: string | null;
    hoursSinceLastRun: number | null;
    /** The scrape runs daily; past 26h something is wrong with the schedule. */
    stale: boolean | null;
  };
  deadLetters: {
    scrape: number | null;
    tailor: number | null;
  };
  /**
   * Quota reservations left dangling by workers killed mid-flight (timeout,
   * OOM). These self-clear at the item's end-of-day TTL, but a nonzero count
   * means some users are under-quota right now. This is the known cost of
   * charging quota on completion rather than at enqueue.
   */
  leakedReservations: number | null;
}

const STALE_AFTER_HOURS = 26;

async function queueDepth(url: string | undefined): Promise<number | null> {
  if (!url) return null;
  try {
    const res = await sqs.send(
      new GetQueueAttributesCommand({
        QueueUrl: url,
        AttributeNames: ['ApproximateNumberOfMessages'],
      }),
    );
    const n = Number(res.Attributes?.ApproximateNumberOfMessages);
    return Number.isFinite(n) ? n : null;
  } catch (err) {
    console.error('Failed to read queue depth:', err);
    return null;
  }
}

async function scrapeFreshness(now: number): Promise<OpsHealth['scrape']> {
  const empty = { lastRunId: null, lastRunAt: null, hoursSinceLastRun: null, stale: null };
  if (!TABLE_NAME) return empty;

  try {
    const res = await getDocClient().send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: 'META#RUNS', SK: 'HISTORY' },
      }),
    );

    const runIds = (res.Item?.runIds as string[] | undefined) ?? [];
    const lastRunId = runIds[0] ?? null;
    if (!lastRunId) return empty;

    // Run ids are ISO timestamps with : and . replaced by -, e.g.
    // 2026-08-19T01-23-45-678Z. Rebuild the parseable form.
    const iso = lastRunId.replace(
      /^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/,
      '$1T$2:$3:$4.$5Z',
    );
    const ranAt = Date.parse(iso);
    if (Number.isNaN(ranAt)) {
      return { lastRunId, lastRunAt: null, hoursSinceLastRun: null, stale: null };
    }

    const hours = (now - ranAt) / 3_600_000;
    return {
      lastRunId,
      lastRunAt: new Date(ranAt).toISOString(),
      hoursSinceLastRun: Math.round(hours * 10) / 10,
      stale: hours > STALE_AFTER_HOURS,
    };
  } catch (err) {
    console.error('Failed to read scrape freshness:', err);
    return empty;
  }
}

export async function getOpsHealth(now: number = Date.now()): Promise<OpsHealth> {
  const [scrape, scrapeDlq, tailorDlq] = await Promise.all([
    scrapeFreshness(now),
    queueDepth(process.env.SCRAPE_DLQ_URL),
    queueDepth(process.env.TAILOR_DLQ_URL),
  ]);

  return {
    scrape,
    deadLetters: { scrape: scrapeDlq, tailor: tailorDlq },
    // Detecting leaked reservations needs a scan of RATE# items, which is more
    // expensive than this endpoint should be. The runbook documents how to
    // check on demand; the alarm on worker errors is the live signal.
    leakedReservations: null,
  };
}
