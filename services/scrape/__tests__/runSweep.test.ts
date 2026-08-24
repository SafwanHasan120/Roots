import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ActiveListingRow } from '../ddb.js';

const queryAllActive = vi.fn();
const getRunHistory = vi.fn();
const deactivateListing = vi.fn();

vi.mock('../ddb.js', () => ({
  queryAllActive: () => queryAllActive(),
  getRunHistory: () => getRunHistory(),
  deactivateListing: (...a: unknown[]) => deactivateListing(...a),
}));

const { runSweep, SWEEP_GRACE_RUNS } = await import('../sweep.js');

/**
 * A full grace window, newest first: ['scrape-N', ..., 'scrape-1'].
 *
 * Derived from SWEEP_GRACE_RUNS rather than hardcoded — the window is sized to
 * the schedule (it counts runs, not days), so it changes whenever the cron
 * does. `FULL_HISTORY[0]` is the newest run and `LAPSED_RUN` is old enough to
 * sit outside the window regardless of its width.
 */
const FULL_HISTORY = Array.from(
  { length: SWEEP_GRACE_RUNS },
  (_, i) => `scrape-${SWEEP_GRACE_RUNS - i}`,
);
const NEWEST_RUN = FULL_HISTORY[0];
const LAPSED_RUN = 'scrape-0';

const NOW = Date.UTC(2026, 7, 16);
const FRESH = Date.UTC(2026, 7, 10);

const rows = (...lastSeenRuns: Array<string | undefined>): ActiveListingRow[] =>
  lastSeenRuns.map((lastSeenRun, i) => ({
    id: `id-${i}`,
    dateMs: FRESH,
    lastSeenRun,
    appUrl: `https://example.com/job/${i}`,
  }));

describe('runSweep', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    deactivateListing.mockResolvedValue(undefined);
  });

  it('does not deactivate listings seen in the most recent scrape', async () => {
    // Regression: the sweep runs under its own run id, which is never a scrape
    // run id. Prepending it to the history both pushed a real run out of the
    // grace window and occupied a slot no listing could ever match — which
    // deactivated the entire corpus (419/419) on the first live run.
    getRunHistory.mockResolvedValue(FULL_HISTORY);
    queryAllActive.mockResolvedValue(rows(NEWEST_RUN, NEWEST_RUN, FULL_HISTORY[1]));

    const summary = await runSweep('sweep-run-id-not-in-history', NOW);

    expect(summary.scanned).toBe(3);
    expect(summary.deactivated).toBe(0);
    expect(deactivateListing).not.toHaveBeenCalled();
  });

  it('evaluates against the stored history unmodified', async () => {
    // The oldest run must stay inside the window; anything older falls out.
    getRunHistory.mockResolvedValue(FULL_HISTORY);
    queryAllActive.mockResolvedValue(rows(FULL_HISTORY[FULL_HISTORY.length - 1], LAPSED_RUN));

    const summary = await runSweep('sweep-id', NOW);

    // The oldest in-window run still counts; anything older does not.
    expect(summary.deactivated).toBe(1);
    expect(deactivateListing).toHaveBeenCalledTimes(1);
    expect(deactivateListing.mock.calls[0][0]).toBe('id-1');
  });

  it('deactivates nothing until the grace window is full', async () => {
    // Protects a fresh table and the first runs after a deploy, when history is
    // short and every listing would otherwise look never-seen.
    getRunHistory.mockResolvedValue(FULL_HISTORY.slice(0, SWEEP_GRACE_RUNS - 1));
    queryAllActive.mockResolvedValue(rows(undefined, undefined));

    const summary = await runSweep('sweep-id', NOW);

    expect(summary.deactivated).toBe(0);
  });

  it('counts deactivations by reason', async () => {
    getRunHistory.mockResolvedValue(FULL_HISTORY);
    queryAllActive.mockResolvedValue([
      { id: 'gone', dateMs: FRESH, lastSeenRun: 'ancient', appUrl: 'https://e.com/1' },
      {
        id: 'old',
        dateMs: Date.UTC(2024, 0, 1),
        lastSeenRun: NEWEST_RUN,
        appUrl: 'https://e.com/2',
      },
    ]);

    const summary = await runSweep('sweep-id', NOW);

    expect(summary.byReason['absent-from-source']).toBe(1);
    expect(summary.byReason.expired).toBe(1);
  });

  it('treats an already-deactivated item as a no-op, not a failure', async () => {
    getRunHistory.mockResolvedValue(FULL_HISTORY);
    queryAllActive.mockResolvedValue(rows('ancient'));
    deactivateListing.mockRejectedValue(
      Object.assign(new Error('conditional failed'), {
        name: 'ConditionalCheckFailedException',
      }),
    );

    const summary = await runSweep('sweep-id', NOW);

    // The condition failing is the idempotency guard working.
    expect(summary.deactivated).toBe(0);
  });

  describe('mass-deactivation circuit breaker', () => {
    it('aborts rather than deactivating most of the corpus for absence', async () => {
      // The real incident: lastSeenRun was missing from the GSI1 projection, so
      // every row read as never-seen and one sweep deactivated all 419.
      getRunHistory.mockResolvedValue(FULL_HISTORY);
      queryAllActive.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          id: `id-${i}`,
          dateMs: FRESH,
          lastSeenRun: undefined, // as if the attribute were not projected
          appUrl: `https://e.com/${i}`,
        })),
      );

      await expect(runSweep('sweep-id', NOW)).rejects.toThrow(/Sweep aborted/);
      expect(deactivateListing).not.toHaveBeenCalled();
    });

    it('still allows a large expiry-driven sweep', async () => {
      // A backlog of genuinely old postings is legitimate, so expiry is exempt.
      getRunHistory.mockResolvedValue(FULL_HISTORY);
      queryAllActive.mockResolvedValue(
        Array.from({ length: 20 }, (_, i) => ({
          id: `id-${i}`,
          dateMs: Date.UTC(2024, 0, 1),
          lastSeenRun: NEWEST_RUN,
          appUrl: `https://e.com/${i}`,
        })),
      );

      const summary = await runSweep('sweep-id', NOW);
      expect(summary.deactivated).toBe(20);
      expect(summary.byReason.expired).toBe(20);
    });

    it('does not trip on a small table', async () => {
      // Below the row threshold, a high ratio is not meaningful.
      getRunHistory.mockResolvedValue(FULL_HISTORY);
      queryAllActive.mockResolvedValue(rows('ancient', 'ancient'));

      const summary = await runSweep('sweep-id', NOW);
      expect(summary.deactivated).toBe(2);
    });
  });

  it('handles an empty table', async () => {
    getRunHistory.mockResolvedValue(FULL_HISTORY);
    queryAllActive.mockResolvedValue([]);

    const summary = await runSweep('sweep-id', NOW);

    expect(summary).toMatchObject({ scanned: 0, deactivated: 0 });
  });
});
