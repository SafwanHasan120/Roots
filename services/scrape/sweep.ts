/**
 * Inactive sweep.
 *
 * Deactivates a listing when EITHER:
 *   - it has been absent from every source for SWEEP_GRACE_RUNS consecutive
 *     runs, or
 *   - expirationDetector.isExpiredOrOld() says its posting date has aged out.
 *
 * Deactivation evicts the item from GSI1 (see ddb.deactivateListing) rather
 * than deleting it, so detail links and per-company history keep working and a
 * listing that reappears is restored by the normal upsert.
 */

import { isExpiredOrOld } from '@app/expirationDetector';
import {
  queryAllActive,
  getRunHistory,
  deactivateListing,
  type ActiveListingRow,
} from './ddb.js';

/**
 * Consecutive runs a listing may be missing before deactivation.
 *
 * Runs are daily, so 3 means a vanished listing stays visible ~3 days. The
 * grace absorbs one transient GitHub failure plus one circuit-breaker trip
 * without hiding live postings.
 */
export const SWEEP_GRACE_RUNS = 3;

export type DeactivationReason = 'absent-from-source' | 'expired';

export interface SweepDecision {
  id: string;
  deactivate: boolean;
  reason?: DeactivationReason;
}

/**
 * Pure decision function, separated from I/O so it can be tested exhaustively.
 *
 * recentRuns is newest-first and includes the current run.
 */
export function decideSweep(
  row: ActiveListingRow,
  recentRuns: string[],
  now: number = Date.now(),
): SweepDecision {
  // Expiry is independent of source presence: a listing still published but six
  // months old should not stay on the front page.
  if (isExpiredOrOld(row.dateMs, false, now)) {
    return { id: row.id, deactivate: true, reason: 'expired' };
  }

  const graceWindow = recentRuns.slice(0, SWEEP_GRACE_RUNS);

  // Not enough history yet (fresh table, or the first runs after deploy). Cannot
  // conclude absence, so leave it alone — the failure mode of guessing here is
  // deactivating the whole corpus.
  if (graceWindow.length < SWEEP_GRACE_RUNS) {
    return { id: row.id, deactivate: false };
  }

  // Never seen at all: treat as absent only once the window is full, which the
  // check above guarantees.
  if (!row.lastSeenRun) {
    return { id: row.id, deactivate: true, reason: 'absent-from-source' };
  }

  const seenRecently = graceWindow.includes(row.lastSeenRun);
  return seenRecently
    ? { id: row.id, deactivate: false }
    : { id: row.id, deactivate: true, reason: 'absent-from-source' };
}

export interface SweepSummary {
  scanned: number;
  deactivated: number;
  byReason: Record<DeactivationReason, number>;
}

/**
 * @param currentRunId - the sweep's own id. Used for logging only; it is
 *   deliberately NOT added to the grace window (see below).
 */
export async function runSweep(
  currentRunId: string,
  now: number = Date.now(),
): Promise<SweepSummary> {
  const [rows, history] = await Promise.all([queryAllActive(), getRunHistory()]);

  // Evaluate against the recorded SCRAPE history exactly as stored.
  //
  // The sweep runs under its own run id, which is never a scrape run id and so
  // matches no listing's lastSeenRun. Prepending it would both shift a real run
  // out of the grace window and fill a slot nothing can match — which
  // deactivated the entire corpus the first time this ran. currentRunId is used
  // only for logging and timestamps.
  const recentRuns = history;

  const summary: SweepSummary = {
    scanned: rows.length,
    deactivated: 0,
    byReason: { 'absent-from-source': 0, expired: 0 },
  };

  const decisions = rows
    .map((row) => decideSweep(row, recentRuns, now))
    .filter((d) => d.deactivate);

  // Circuit breaker. Deactivating essentially everything is never a legitimate
  // outcome of a daily scrape — it means the input is wrong, not that the whole
  // corpus vanished. This exact scenario happened once already: `lastSeenRun`
  // was missing from the GSI1 projection, so every row read as never-seen and a
  // single sweep took down all 419 listings.
  //
  // Expiry is exempt: a genuine backlog of old postings can legitimately be a
  // large share of the corpus.
  const absent = decisions.filter((d) => d.reason === 'absent-from-source');
  const ABSENT_RATIO_LIMIT = 0.5;
  if (rows.length >= 10 && absent.length > rows.length * ABSENT_RATIO_LIMIT) {
    throw new Error(
      `Sweep aborted: ${absent.length}/${rows.length} listings looked absent from source ` +
        `(limit ${ABSENT_RATIO_LIMIT * 100}%). Likely causes, in order: a single large source ` +
        `failed for ${SWEEP_GRACE_RUNS} consecutive runs (one source now dominates the corpus, ` +
        `so its outage alone can exceed this limit); lastSeenRun is missing from the GSI1 ` +
        `projection; or the run history is corrupt. It does not mean the corpus disappeared — ` +
        `check per-source worker logs before overriding.`,
    );
  }

  // Bounded concurrency: the corpus is small, but an unbounded Promise.all over
  // thousands of UpdateItems would throttle.
  const CONCURRENCY = 10;
  for (let i = 0; i < decisions.length; i += CONCURRENCY) {
    const batch = decisions.slice(i, i + CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((d) => deactivateListing(d.id, d.reason!, now)),
    );

    results.forEach((res, j) => {
      const decision = batch[j];
      if (res.status === 'fulfilled') {
        summary.deactivated++;
        summary.byReason[decision.reason!]++;
        return;
      }
      // Already deactivated by a concurrent/previous sweep — the condition
      // failing is the idempotency guard working, not an error.
      if ((res.reason as { name?: string })?.name === 'ConditionalCheckFailedException') {
        return;
      }
      console.error(
        JSON.stringify({ msg: 'deactivation failed', id: decision.id, error: String(res.reason) }),
      );
    });
  }

  return summary;
}
