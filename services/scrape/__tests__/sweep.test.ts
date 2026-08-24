import { describe, it, expect } from 'vitest';
import { decideSweep, SWEEP_GRACE_RUNS } from '../sweep.js';
import type { ActiveListingRow } from '../ddb.js';

const FRESH = Date.UTC(2026, 7, 1); // 2026-08-01
const NOW = Date.UTC(2026, 7, 14); // 2026-08-14

/**
 * Newest first, as the dispatcher records them.
 *
 * One entry WIDER than the grace window, so `LAPSED` sits just outside it — the
 * boundary this suite exercises. Sized from SWEEP_GRACE_RUNS because the window
 * counts runs, not days, and so tracks the schedule.
 */
const RUNS = Array.from(
  { length: SWEEP_GRACE_RUNS + 1 },
  (_, i) => `run-${SWEEP_GRACE_RUNS - i}`,
);
const NEWEST = RUNS[0];
const LAPSED = RUNS[RUNS.length - 1];

const row = (over: Partial<ActiveListingRow> = {}): ActiveListingRow => ({
  id: 'abc123',
  dateMs: FRESH,
  lastSeenRun: NEWEST,
  appUrl: 'https://example.com/job/1',
  ...over,
});

describe('decideSweep', () => {
  describe('source absence', () => {
    it('keeps a listing seen in the current run', () => {
      const d = decideSweep(row({ lastSeenRun: 'run-3' }), RUNS, NOW);
      expect(d.deactivate).toBe(false);
    });

    it('keeps a listing seen within the grace window', () => {
      // Missing for 2 runs is still inside a 3-run grace.
      const d = decideSweep(row({ lastSeenRun: 'run-1' }), RUNS, NOW);
      expect(d.deactivate).toBe(false);
    });

    it('deactivates once absent for the full grace window', () => {
      const d = decideSweep(row({ lastSeenRun: LAPSED }), RUNS, NOW);
      expect(d.deactivate).toBe(true);
      expect(d.reason).toBe('absent-from-source');
    });

    it('deactivates a listing never seen in any recorded run', () => {
      const d = decideSweep(row({ lastSeenRun: undefined }), RUNS, NOW);
      expect(d.deactivate).toBe(true);
      expect(d.reason).toBe('absent-from-source');
    });
  });

  describe('insufficient history', () => {
    // Empty, one run, and one short of a full window — the last is the boundary.
    it.each([0, 1, SWEEP_GRACE_RUNS - 1])(
      'never deactivates with only %i recorded run(s)',
      (n) => {
        // The catastrophic failure mode: a fresh table with no history would
        // otherwise deactivate the entire corpus on the first sweep.
        const d = decideSweep(row({ lastSeenRun: undefined }), RUNS.slice(0, n), NOW);
        expect(d.deactivate).toBe(false);
      },
    );

    it('starts deactivating exactly at the grace threshold', () => {
      // Derived from the constant rather than hardcoded: the window is sized to
      // the schedule (runs, not days), so it changes whenever the cron does.
      const justEnough = Array.from({ length: SWEEP_GRACE_RUNS }, (_, i) => `r${i}`);
      const d = decideSweep(row({ lastSeenRun: 'older' }), justEnough, NOW);
      expect(d.deactivate).toBe(true);
    });

    it('never deactivates one run short of the threshold', () => {
      const oneShort = Array.from({ length: SWEEP_GRACE_RUNS - 1 }, (_, i) => `r${i}`);
      const d = decideSweep(row({ lastSeenRun: 'older' }), oneShort, NOW);
      expect(d.deactivate).toBe(false);
    });

    it('fits inside the run history that recordRun retains', async () => {
      // The sweep refuses to act on a partial window, so a grace window wider
      // than the retained history can NEVER fill — deactivation would silently
      // stop working, with no error anywhere. This invariant is the only thing
      // that catches it.
      const { default: fs } = await import('node:fs');
      const src = fs.readFileSync(new URL('../ddb.ts', import.meta.url), 'utf8');
      const keep = Number(/recordRun\([^)]*keep:\s*number\s*=\s*(\d+)/.exec(src)?.[1]);

      expect(keep, 'could not parse recordRun keep default').toBeGreaterThan(0);
      expect(keep).toBeGreaterThanOrEqual(SWEEP_GRACE_RUNS);
    });
  });

  describe('expiration', () => {
    it('deactivates a listing older than the expiry threshold even if still in source', () => {
      // Still present every run, but ~8 months old.
      const old = Date.UTC(2025, 11, 1);
      const d = decideSweep(row({ dateMs: old, lastSeenRun: 'run-3' }), RUNS, NOW);
      expect(d.deactivate).toBe(true);
      expect(d.reason).toBe('expired');
    });

    it('takes precedence over source presence', () => {
      const old = Date.UTC(2024, 0, 1);
      const d = decideSweep(row({ dateMs: old, lastSeenRun: 'run-3' }), RUNS, NOW);
      expect(d.reason).toBe('expired');
    });

    it('deactivates expired listings even with insufficient run history', () => {
      // Expiry does not depend on run history, so the grace guard must not
      // suppress it.
      const old = Date.UTC(2024, 0, 1);
      const d = decideSweep(row({ dateMs: old }), [], NOW);
      expect(d.deactivate).toBe(true);
      expect(d.reason).toBe('expired');
    });

    it('keeps a fresh listing', () => {
      const d = decideSweep(row({ dateMs: NOW - 86_400_000 }), RUNS, NOW);
      expect(d.deactivate).toBe(false);
    });
  });

  it('reports the id it decided on', () => {
    expect(decideSweep(row({ id: 'xyz' }), RUNS, NOW).id).toBe('xyz');
  });
});
