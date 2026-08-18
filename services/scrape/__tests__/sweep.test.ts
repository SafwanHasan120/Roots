import { describe, it, expect } from 'vitest';
import { decideSweep, SWEEP_GRACE_RUNS } from '../sweep.js';
import type { ActiveListingRow } from '../ddb.js';

const FRESH = Date.UTC(2026, 7, 1); // 2026-08-01
const NOW = Date.UTC(2026, 7, 14); // 2026-08-14

const row = (over: Partial<ActiveListingRow> = {}): ActiveListingRow => ({
  id: 'abc123',
  dateMs: FRESH,
  lastSeenRun: 'run-3',
  appUrl: 'https://example.com/job/1',
  ...over,
});

// Newest first, as the dispatcher records them.
const RUNS = ['run-3', 'run-2', 'run-1', 'run-0'];

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
      const d = decideSweep(row({ lastSeenRun: 'run-0' }), RUNS, NOW);
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
    it.each([[[]], [['run-1']], [['run-2', 'run-1']]])(
      'never deactivates with only %s recorded runs',
      (runs) => {
        // The catastrophic failure mode: a fresh table with no history would
        // otherwise deactivate the entire corpus on the first sweep.
        const d = decideSweep(row({ lastSeenRun: undefined }), runs as string[], NOW);
        expect(d.deactivate).toBe(false);
      },
    );

    it('starts deactivating exactly at the grace threshold', () => {
      const justEnough = ['r3', 'r2', 'r1'];
      expect(justEnough).toHaveLength(SWEEP_GRACE_RUNS);
      const d = decideSweep(row({ lastSeenRun: 'older' }), justEnough, NOW);
      expect(d.deactivate).toBe(true);
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
