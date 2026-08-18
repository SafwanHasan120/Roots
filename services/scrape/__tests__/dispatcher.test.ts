import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const sqsSend = vi.fn();
vi.mock('@aws-sdk/client-sqs', () => ({
  SQSClient: class {
    send = sqsSend;
  },
  SendMessageBatchCommand: class {
    constructor(public input: Record<string, unknown>) {}
  },
}));

const recordRun = vi.fn();
vi.mock('../ddb.js', () => ({ recordRun: (...a: unknown[]) => recordRun(...a) }));

const runSweep = vi.fn();
vi.mock('../sweep.js', () => ({ runSweep: (...a: unknown[]) => runSweep(...a) }));

const loadSources = vi.fn();
vi.mock('@app/scraper', () => ({
  loadSources: () => loadSources(),
  repoSlug: (u: string) => {
    const m = u.match(/githubusercontent\.com\/([^/]+)\/([^/]+)\//);
    return m ? `${m[1]}/${m[2]}` : u;
  },
}));

const { handler, makeRunId } = await import('../dispatcher.js');

const SOURCES = [
  'https://raw.githubusercontent.com/owner/repo-a/main/README.md',
  'https://raw.githubusercontent.com/owner/repo-b/main/README.md',
];

describe('dispatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.QUEUE_URL = 'https://sqs.us-west-2.amazonaws.com/1/scrape';
    loadSources.mockReturnValue(SOURCES);
    sqsSend.mockResolvedValue({ Successful: SOURCES.map((_, i) => ({ Id: String(i) })) });
    recordRun.mockResolvedValue(['run-1']);
  });

  afterEach(() => {
    delete process.env.QUEUE_URL;
  });

  describe('scrape mode', () => {
    it('enqueues one message per enabled source', async () => {
      const res = await handler({ mode: 'scrape', runId: 'run-1' });

      expect(res.enqueued).toBe(2);
      expect(sqsSend).toHaveBeenCalledTimes(1);

      const entries = sqsSend.mock.calls[0][0].input.Entries;
      expect(entries).toHaveLength(2);

      const bodies = entries.map((e: { MessageBody: string }) => JSON.parse(e.MessageBody));
      expect(bodies.map((b: { slug: string }) => b.slug)).toEqual([
        'owner/repo-a',
        'owner/repo-b',
      ]);
      expect(bodies.every((b: { runId: string }) => b.runId === 'run-1')).toBe(true);
    });

    it('defaults to scrape mode', async () => {
      const res = await handler({});
      expect(res.mode).toBe('scrape');
      expect(sqsSend).toHaveBeenCalled();
    });

    it('records the run before enqueueing', async () => {
      // Order matters: the sweep measures its grace window in run ids. A run
      // that enqueued work without being recorded would let the window slide
      // while listings were never marked seen.
      const order: string[] = [];
      recordRun.mockImplementation(async () => void order.push('record'));
      sqsSend.mockImplementation(async () => {
        order.push('send');
        return { Successful: [{ Id: '0' }, { Id: '1' }] };
      });

      await handler({ runId: 'run-1' });
      expect(order).toEqual(['record', 'send']);
    });

    it('refuses to dispatch when no sources are enabled', async () => {
      // An empty source list means sources.json is broken. Proceeding would let
      // the sweep deactivate the entire corpus for absence.
      loadSources.mockReturnValue([]);
      await expect(handler({ runId: 'run-1' })).rejects.toThrow(/no enabled sources/i);
      expect(sqsSend).not.toHaveBeenCalled();
    });

    it('throws when the queue url is missing', async () => {
      delete process.env.QUEUE_URL;
      await expect(handler({ runId: 'run-1' })).rejects.toThrow(/QUEUE_URL/);
    });

    it('throws when SQS reports partial failure', async () => {
      sqsSend.mockResolvedValue({
        Successful: [{ Id: '0' }],
        Failed: [{ Id: '1', Message: 'throttled' }],
      });
      await expect(handler({ runId: 'run-1' })).rejects.toThrow(/Failed to enqueue/);
    });

    it('chunks into batches of 10', async () => {
      loadSources.mockReturnValue(
        Array.from({ length: 23 }, (_, i) => `https://raw.githubusercontent.com/o/r${i}/main/README.md`),
      );
      sqsSend.mockImplementation(async (cmd: { input: { Entries: unknown[] } }) => ({
        Successful: cmd.input.Entries.map((_, i) => ({ Id: String(i) })),
      }));

      const res = await handler({ runId: 'run-1' });

      expect(sqsSend).toHaveBeenCalledTimes(3); // 10 + 10 + 3
      expect(res.enqueued).toBe(23);
    });
  });

  describe('sweep mode', () => {
    it('runs the sweep and enqueues nothing', async () => {
      runSweep.mockResolvedValue({ scanned: 5, deactivated: 1, byReason: {} });

      const res = await handler({ mode: 'sweep', runId: 'run-1' });

      expect(runSweep).toHaveBeenCalledWith('run-1');
      expect(res.swept).toMatchObject({ scanned: 5, deactivated: 1 });
      expect(sqsSend).not.toHaveBeenCalled();
    });

    it('does not record a new run', async () => {
      // The sweep evaluates the window the scrape established; recording again
      // would age every listing by an extra run.
      runSweep.mockResolvedValue({ scanned: 0, deactivated: 0, byReason: {} });
      await handler({ mode: 'sweep', runId: 'run-1' });
      expect(recordRun).not.toHaveBeenCalled();
    });
  });
});

describe('makeRunId', () => {
  it('is derived from the timestamp and sorts lexicographically', () => {
    const earlier = makeRunId(Date.UTC(2026, 7, 14, 13, 0, 0));
    const later = makeRunId(Date.UTC(2026, 7, 15, 13, 0, 0));
    expect(earlier < later).toBe(true);
  });

  it('contains no characters that complicate keys or logs', () => {
    expect(makeRunId(Date.UTC(2026, 7, 14, 13, 0, 0))).not.toMatch(/[:.]/);
  });
});
