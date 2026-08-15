import { describe, it, expect } from 'vitest';
import {
  listingId,
  activeShard,
  allActiveShardKeys,
  listingKey,
  activeIndexKey,
  companyIndexKey,
  scrapeStateKey,
  jobKey,
  rateLimitKey,
  sortableDate,
  ACTIVE_SHARD_COUNT,
} from '../keys.js';

describe('listingId', () => {
  it('is deterministic for the same URL', () => {
    const url = 'https://boards.greenhouse.io/acme/jobs/12345';
    expect(listingId(url)).toBe(listingId(url));
  });

  it('differs for different URLs', () => {
    expect(listingId('https://a.example/1')).not.toBe(listingId('https://a.example/2'));
  });

  it('is 32 lowercase hex chars', () => {
    expect(listingId('https://example.com/job')).toMatch(/^[0-9a-f]{32}$/);
  });

  it('does not depend on company name', () => {
    // The point of the surrogate id: if companyNormalizer changes its output,
    // the listing keeps its key. Only the URL feeds the id.
    const url = 'https://jobs.example.com/posting/9';
    const before = listingId(url);
    const after = listingId(url);
    expect(after).toBe(before);
  });
});

describe('activeShard', () => {
  it('is stable for a given id', () => {
    const id = listingId('https://example.com/x');
    expect(activeShard(id)).toBe(activeShard(id));
  });

  it('always returns a valid shard index', () => {
    for (let i = 0; i < 500; i++) {
      const shard = activeShard(listingId(`https://example.com/job/${i}`));
      expect(shard).toBeGreaterThanOrEqual(0);
      expect(shard).toBeLessThan(ACTIVE_SHARD_COUNT);
    }
  });

  it('distributes roughly evenly across shards', () => {
    // Uneven distribution would concentrate reads on one partition and make
    // the parallel fan-out pointless.
    const counts = new Array(ACTIVE_SHARD_COUNT).fill(0);
    const n = 4000;
    for (let i = 0; i < n; i++) {
      counts[activeShard(listingId(`https://example.com/job/${i}`))]++;
    }

    const expected = n / ACTIVE_SHARD_COUNT;
    for (const count of counts) {
      // Generous bound; sha256 will land far inside this.
      expect(count).toBeGreaterThan(expected * 0.8);
      expect(count).toBeLessThan(expected * 1.2);
    }
  });

  it('enumerates every shard key for the read fan-out', () => {
    expect(allActiveShardKeys()).toEqual(['ACTIVE#0', 'ACTIVE#1', 'ACTIVE#2', 'ACTIVE#3']);
  });
});

describe('sortableDate', () => {
  it('pads so lexicographic order matches numeric order', () => {
    // DynamoDB sorts string sort keys bytewise. Unpadded, "9999" sorts after
    // "10000" and the whole recency index is silently wrong.
    const older = sortableDate(9_999);
    const newer = sortableDate(10_000);
    expect(older < newer).toBe(true);
  });

  it('orders real epoch timestamps correctly', () => {
    const dates = [1_700_000_000_000, 1_600_000_000_000, 1_800_000_000_000];
    const sorted = [...dates].sort((a, b) => a - b).map(sortableDate);
    const lexSorted = dates.map(sortableDate).sort();
    expect(lexSorted).toEqual(sorted);
  });
});

describe('key builders', () => {
  const id = listingId('https://example.com/job/1');

  it('builds a listing key with matching PK and SK', () => {
    expect(listingKey(id)).toEqual({ PK: `LISTING#${id}`, SK: `LISTING#${id}` });
  });

  it('builds recency index attributes', () => {
    const key = activeIndexKey(id, 1_700_000_000_000);
    expect(key.GSI1PK).toBe(`ACTIVE#${activeShard(id)}`);
    expect(key.GSI1SK).toBe(`${sortableDate(1_700_000_000_000)}#${id}`);
  });

  it('builds company index attributes', () => {
    const key = companyIndexKey('acme corp', id, 1_700_000_000_000);
    expect(key.GSI2PK).toBe('COMPANY#acme corp');
    expect(key.GSI2SK).toBe(`${sortableDate(1_700_000_000_000)}#${id}`);
  });

  it('builds scrape state, job and rate-limit keys', () => {
    expect(scrapeStateKey('vanshb03/Summer2027-Internships')).toEqual({
      PK: 'META#SCRAPE',
      SK: 'SOURCE#vanshb03/Summer2027-Internships',
    });
    expect(jobKey('abc-123')).toEqual({ PK: 'JOB#abc-123', SK: 'JOB#abc-123' });
    expect(rateLimitKey('uid1', '2026-08-13')).toEqual({
      PK: 'RATE#uid1',
      SK: 'DAY#2026-08-13',
    });
  });

  it('keeps item types in disjoint key spaces', () => {
    // Everything shares one table, so a prefix collision would let one item
    // type overwrite another.
    const prefixes = [
      listingKey(id).PK,
      scrapeStateKey('s').PK,
      jobKey('j').PK,
      rateLimitKey('u', '2026-08-13').PK,
    ].map((pk) => pk.split('#')[0]);

    expect(new Set(prefixes).size).toBe(prefixes.length);
  });
});
