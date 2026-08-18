import { describe, it, expect, vi, beforeEach } from 'vitest';

const send = vi.fn();
vi.mock('../ddbClient', async () => {
  const actual = await vi.importActual<typeof import('../ddbClient')>('../ddbClient');
  return {
    ...actual,
    TABLE_NAME: 'test-table',
    getDocClient: () => ({ send }),
  };
});

import { queryRecent, getListingById, allActiveShardKeys } from '../listingsRepo';
import { CredentialError, EmptyResultError } from '../ddbClient';

const row = (over: Record<string, unknown> = {}) => ({
  id: 'abc',
  company: 'Acme',
  role: 'SWE Intern',
  location: 'Remote',
  appUrl: 'https://example.com/job/1',
  datePosted: 'Aug 01',
  dateMs: 1_700_000_000_000,
  prestigeScore: 0.5,
  source: 'owner/repo',
  ...over,
});

/** Respond per shard key, so tests can control distribution across shards. */
function respondByShard(byShard: Record<string, unknown[]>) {
  send.mockImplementation(async (cmd: { input: Record<string, any> }) => {
    const pk = cmd.input.ExpressionAttributeValues?.[':pk'];
    return { Items: byShard[pk] ?? [] };
  });
}

describe('listingsRepo', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('key design', () => {
    it('enumerates exactly the four shard keys the writer uses', () => {
      // Must match activeShard() in infra/lib/keys.ts. A mismatch means the
      // read path queries partitions the worker never writes to, and the site
      // silently shows a fraction of the listings.
      expect(allActiveShardKeys()).toEqual(['ACTIVE#0', 'ACTIVE#1', 'ACTIVE#2', 'ACTIVE#3']);
    });

    it('queries the recency index by name', () => {
      respondByShard({ 'ACTIVE#0': [row()] });
      return queryRecent().then(() => {
        expect(send.mock.calls[0][0].input.IndexName).toBe('GSI1v2');
      });
    });
  });

  describe('shard merge', () => {
    it('queries every shard in parallel', async () => {
      respondByShard({ 'ACTIVE#0': [row()] });
      await queryRecent();
      expect(send).toHaveBeenCalledTimes(4);
    });

    it('returns a strictly descending merge across shards', async () => {
      // Interleaved dates: a naive concat would return them shard-by-shard.
      respondByShard({
        'ACTIVE#0': [row({ id: 'a', dateMs: 100 }), row({ id: 'e', dateMs: 20 })],
        'ACTIVE#1': [row({ id: 'b', dateMs: 80 })],
        'ACTIVE#2': [row({ id: 'c', dateMs: 60 }), row({ id: 'f', dateMs: 10 })],
        'ACTIVE#3': [row({ id: 'd', dateMs: 40 })],
      });

      const result = await queryRecent();

      expect(result.map((r) => r.id)).toEqual(['a', 'b', 'c', 'd', 'e', 'f']);
      const dates = result.map((r) => r.dateMs);
      expect([...dates].sort((x, y) => y - x)).toEqual(dates);
    });

    it('returns the correct top-N when one shard holds most of it', async () => {
      // Each shard is queried for the FULL limit precisely so an unbalanced
      // distribution cannot drop newer listings.
      respondByShard({
        'ACTIVE#0': [
          row({ id: 'n1', dateMs: 100 }),
          row({ id: 'n2', dateMs: 99 }),
          row({ id: 'n3', dateMs: 98 }),
        ],
        'ACTIVE#1': [row({ id: 'old', dateMs: 1 })],
      });

      const result = await queryRecent({ limit: 3 });

      expect(result.map((r) => r.id)).toEqual(['n1', 'n2', 'n3']);
    });

    it('asks each shard for the full limit, not limit/shardCount', async () => {
      respondByShard({ 'ACTIVE#0': [row()] });
      await queryRecent({ limit: 40 });
      for (const call of send.mock.calls) {
        expect(call[0].input.Limit).toBe(40);
      }
    });

    it('fails the whole read when a single shard errors', async () => {
      // A partial set silently hides listings, which is worse than an error.
      send.mockImplementation(async (cmd: { input: Record<string, any> }) => {
        if (cmd.input.ExpressionAttributeValues[':pk'] === 'ACTIVE#2') {
          throw new Error('shard unavailable');
        }
        return { Items: [row()] };
      });

      await expect(queryRecent()).rejects.toThrow('shard unavailable');
    });
  });

  describe('pagination', () => {
    it('follows LastEvaluatedKey until the limit is met', async () => {
      let page = 0;
      send.mockImplementation(async (cmd: { input: Record<string, any> }) => {
        if (cmd.input.ExpressionAttributeValues[':pk'] !== 'ACTIVE#0') return { Items: [] };
        page++;
        return page < 3
          ? { Items: [row({ id: `p${page}`, dateMs: 100 - page })], LastEvaluatedKey: { n: page } }
          : { Items: [row({ id: 'last', dateMs: 1 })] };
      });

      const result = await queryRecent({ limit: 100 });

      expect(result.map((r) => r.id)).toEqual(['p1', 'p2', 'last']);
    });

    it('stops at the page ceiling rather than looping forever', async () => {
      // A shard that always returns a cursor must not hang the render.
      send.mockImplementation(async (cmd: { input: Record<string, any> }) =>
        cmd.input.ExpressionAttributeValues[':pk'] === 'ACTIVE#0'
          ? { Items: [row()], LastEvaluatedKey: { n: 1 } }
          : { Items: [] },
      );

      await queryRecent({ limit: 10_000 });

      // 10 pages on the looping shard + 1 each on the other three.
      expect(send).toHaveBeenCalledTimes(13);
    });
  });

  describe('item validation', () => {
    it('drops rows missing fields ranker.ts requires', async () => {
      // ranker.ts is frozen, so it must never receive a malformed object.
      respondByShard({
        'ACTIVE#0': [
          row({ id: 'good' }),
          { id: 'no-company', appUrl: 'https://e.com/1', role: 'X', dateMs: 5 },
          { id: 'no-date', company: 'C', role: 'R', appUrl: 'https://e.com/2' },
        ],
      });

      const result = await queryRecent();

      expect(result.map((r) => r.id)).toEqual(['good']);
    });

    it('supplies defaults for optional fields', async () => {
      respondByShard({
        'ACTIVE#0': [
          {
            company: 'Acme',
            role: 'SWE',
            appUrl: 'https://e.com/1',
            dateMs: 5,
          },
        ],
      });

      const [only] = await queryRecent();

      expect(only.location).toBe('—');
      expect(only.datePosted).toBe('—');
      expect(only.prestigeScore).toBe(0);
      expect(only.id).toBe('https://e.com/1');
    });
  });

  describe('failure modes', () => {
    it('throws EmptyResultError rather than returning an empty list', async () => {
      // An empty table means the scrape broke. Throwing lets ISR keep the last
      // good render instead of caching an empty page.
      respondByShard({});
      await expect(queryRecent()).rejects.toBeInstanceOf(EmptyResultError);
    });

    it('returns [] on empty when the caller opts out of throwing', async () => {
      respondByShard({});
      await expect(queryRecent({ throwOnEmpty: false })).resolves.toEqual([]);
    });

    it('classifies credential failures distinctly', async () => {
      // Surfaced as a 503 with its own message so a missing IAM role does not
      // read like a code bug.
      send.mockRejectedValue(
        Object.assign(new Error('nope'), { name: 'CredentialsProviderError' }),
      );
      await expect(queryRecent()).rejects.toBeInstanceOf(CredentialError);
    });

    it('classifies an expired session token as a credential failure', async () => {
      send.mockRejectedValue(
        Object.assign(new Error('The security token included is expired'), {
          name: 'ExpiredTokenException',
        }),
      );
      await expect(queryRecent()).rejects.toBeInstanceOf(CredentialError);
    });
  });

  describe('getListingById', () => {
    it('reads the base table by surrogate id', async () => {
      send.mockResolvedValue({ Item: row({ id: 'xyz' }) });

      const result = await getListingById('xyz');

      expect(result?.id).toBe('xyz');
      expect(send.mock.calls[0][0].input.Key).toEqual({
        PK: 'LISTING#xyz',
        SK: 'LISTING#xyz',
      });
    });

    it('returns null for a missing item', async () => {
      send.mockResolvedValue({});
      await expect(getListingById('nope')).resolves.toBeNull();
    });

    it('returns null for blank input without querying', async () => {
      await expect(getListingById('  ')).resolves.toBeNull();
      expect(send).not.toHaveBeenCalled();
    });
  });
});
