import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SQSEvent } from 'aws-lambda';
import type { Internship } from '@app/types';

const scrapeOneSource = vi.fn();
vi.mock('@app/scraper', () => ({
  scrapeOneSource: (...a: unknown[]) => scrapeOneSource(...a),
}));

const validateUrls = vi.fn();
vi.mock('@app/urlValidator', () => ({
  validateUrls: (...a: unknown[]) => validateUrls(...a),
}));

const upsertListing = vi.fn();
const getSourceState = vi.fn();
const putSourceState = vi.fn();
vi.mock('../ddb.js', () => ({
  upsertListing: (...a: unknown[]) => upsertListing(...a),
  getSourceState: (...a: unknown[]) => getSourceState(...a),
  putSourceState: (...a: unknown[]) => putSourceState(...a),
}));

const { handler } = await import('../worker.js');

const listing = (over: Partial<Internship> = {}): Internship => ({
  id: 'https://example.com/job/1',
  company: 'Acme',
  role: 'SWE Intern',
  location: 'Remote',
  appUrl: 'https://example.com/job/1',
  datePosted: 'Aug 01',
  dateMs: Date.UTC(2026, 7, 1),
  prestigeScore: 0,
  source: 'owner/repo',
  ...over,
});

const event = (body: unknown): SQSEvent =>
  ({ Records: [{ body: JSON.stringify(body) }] }) as SQSEvent;

const MSG = { url: 'https://raw.githubusercontent.com/owner/repo/main/README.md', slug: 'owner/repo', runId: 'run-1' };

describe('worker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    getSourceState.mockResolvedValue(undefined);
    putSourceState.mockResolvedValue(undefined);
    upsertListing.mockResolvedValue({ written: true, id: 'abc' });
    validateUrls.mockResolvedValue([]);
    scrapeOneSource.mockResolvedValue({
      listings: [listing()],
      state: { failCount: 0 },
      skipped: false,
      unchanged: false,
    });
  });

  it('scrapes the source named in the message and upserts each listing', async () => {
    scrapeOneSource.mockResolvedValue({
      listings: [listing({ appUrl: 'https://a.example/1' }), listing({ appUrl: 'https://b.example/2' })],
      state: { failCount: 0 },
      skipped: false,
      unchanged: false,
    });

    await handler(event(MSG));

    expect(scrapeOneSource).toHaveBeenCalledWith(MSG.url, undefined);
    expect(upsertListing).toHaveBeenCalledTimes(2);
    expect(upsertListing.mock.calls[0][1]).toBe('run-1');
  });

  it('passes prior source state so etag/sha short-circuiting works', async () => {
    const prior = { etag: 'W/"abc"', sha: 'deadbeef', failCount: 0 };
    getSourceState.mockResolvedValue(prior);

    await handler(event(MSG));

    expect(scrapeOneSource).toHaveBeenCalledWith(MSG.url, prior);
  });

  it('persists updated source state after a successful scrape', async () => {
    const state = { etag: 'W/"new"', failCount: 0, lastOk: 123 };
    scrapeOneSource.mockResolvedValue({ listings: [], state, skipped: false, unchanged: true });

    await handler(event(MSG));

    expect(putSourceState).toHaveBeenCalledWith('owner/repo', state);
  });

  it('writes nothing when the circuit breaker is open', async () => {
    scrapeOneSource.mockResolvedValue({
      listings: [],
      state: { failCount: 3, circuitBreakerUntil: Date.now() + 60_000 },
      skipped: true,
      unchanged: false,
    });

    await handler(event(MSG));

    expect(upsertListing).not.toHaveBeenCalled();
  });

  describe('failure handling', () => {
    it('rethrows so SQS can redeliver', async () => {
      // No in-process retry: the retry unit is the whole message.
      scrapeOneSource.mockRejectedValue(new Error('GitHub 503'));
      await expect(handler(event(MSG))).rejects.toThrow('GitHub 503');
    });

    it('persists the circuit-breaker state before rethrowing', async () => {
      // Otherwise the breaker resets on every redelivery and never trips.
      const err = Object.assign(new Error('GitHub 503'), {
        sourceState: { failCount: 3, circuitBreakerUntil: 999 },
      });
      scrapeOneSource.mockRejectedValue(err);

      await expect(handler(event(MSG))).rejects.toThrow();
      expect(putSourceState).toHaveBeenCalledWith('owner/repo', {
        failCount: 3,
        circuitBreakerUntil: 999,
      });
    });
  });

  describe('link health', () => {
    it('attaches probe results to the matching listing', async () => {
      scrapeOneSource.mockResolvedValue({
        listings: [listing({ appUrl: 'https://a.example/1' })],
        state: { failCount: 0 },
        skipped: false,
        unchanged: false,
      });
      validateUrls.mockResolvedValue([
        { url: 'https://a.example/1', health: 'healthy', status: 200, checkedAt: 0, cacheHit: false },
      ]);

      await handler(event(MSG));

      expect(upsertListing.mock.calls[0][0].linkHealth).toBe('healthy');
    });

    it('still stores listings when probing throws', async () => {
      // Unknown link health is not a reason to lose a listing.
      validateUrls.mockRejectedValue(new Error('network down'));

      await handler(event(MSG));

      expect(upsertListing).toHaveBeenCalledTimes(1);
      expect(upsertListing.mock.calls[0][0].linkHealth).toBeUndefined();
    });

    it('leaves linkHealth unset for URLs the probe did not return', async () => {
      validateUrls.mockResolvedValue([
        { url: 'https://other.example/9', health: 'healthy', status: 200, checkedAt: 0, cacheHit: false },
      ]);

      await handler(event(MSG));

      expect(upsertListing.mock.calls[0][0].linkHealth).toBeUndefined();
    });
  });
});
