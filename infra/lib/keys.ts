/**
 * Single-table key design.
 *
 * This module is the one authority on how items are keyed. The scrape and
 * tailor services import it rather than rebuilding key strings by hand — a
 * writer and a reader that disagree by one character produce items nothing
 * can find, and that class of bug is invisible until a query returns empty.
 *
 * See docs/aws-migration.md for the design rationale and the thresholds at
 * which the shard count should be revisited.
 */

import { createHash } from 'node:crypto';

/**
 * Number of shards the ACTIVE recency index is spread across.
 *
 * Chosen to bound per-query result size, NOT to escape a hot partition — a
 * single DynamoDB partition sustains 3000 RCU / 1000 WCU, far beyond this
 * workload. The read path issues one query per shard in parallel and merges,
 * so this is also the parallel-query fan-out.
 *
 * Raising this is a migration, not a config change: it rewrites GSI1PK on
 * every existing item and needs a one-off backfill. See docs/aws-migration.md.
 */
export const ACTIVE_SHARD_COUNT = 4;

/** Attribute names. Kept as constants so expression builders can't typo them. */
export const ATTR = {
  pk: 'PK',
  sk: 'SK',
  gsi1pk: 'GSI1PK',
  gsi1sk: 'GSI1SK',
  gsi2pk: 'GSI2PK',
  gsi2sk: 'GSI2SK',
} as const;

export const INDEX = {
  /**
   * Recency across all active listings. Sharded; query all shards and merge.
   *
   * Named GSI1v2 because DynamoDB cannot alter an existing index's projection
   * ("Cannot update a GSI's KeySchema or Projection") — changing it requires a
   * new index name. The original GSI1 omitted `lastSeenRun`, which the sweep
   * reads to decide liveness; without it every row looked never-seen and one
   * sweep deactivated the entire corpus. The attribute names (GSI1PK/GSI1SK)
   * are unchanged, so no item needs rewriting.
   */
  recency: 'GSI1v2',
  /** Per-company lookup. */
  company: 'GSI2',
} as const;

/**
 * Stable surrogate id for a listing, derived from its application URL.
 *
 * The appUrl is already the dedup key in scraper.ts, so it is the listing's
 * real identity. Deriving the id from it means the key never moves — notably
 * not when companyNormalizer.ts changes its output for a company, which would
 * have orphaned every item under a stale key had company been the partition
 * key.
 *
 * Truncated to 32 hex chars: 128 bits of a sha256, which is far past the point
 * where collision is a practical concern for this corpus.
 */
export function listingId(appUrl: string): string {
  return createHash('sha256').update(appUrl).digest('hex').slice(0, 32);
}

/**
 * Assign a listing to a recency shard.
 *
 * Hash-based rather than time-based. A time-bucketed index (e.g. by posting
 * month) is lossy in both directions: keyed on posting date, a listing posted
 * in May and still open in August falls outside a "current + previous month"
 * read; keyed on the current month, every item needs a periodic rewrite. A
 * hash of the id is time-independent, so an item's index position never
 * depends on the calendar.
 *
 * Takes the listingId (not the URL) so the shard is stable for the lifetime of
 * the item, and derives from the leading 8 hex chars — the hash is uniformly
 * distributed, so any fixed slice is.
 */
export function activeShard(id: string): number {
  return parseInt(id.slice(0, 8), 16) % ACTIVE_SHARD_COUNT;
}

/** All shard partition values, for the read path's parallel fan-out. */
export function allActiveShardKeys(): string[] {
  return Array.from({ length: ACTIVE_SHARD_COUNT }, (_, i) => `ACTIVE#${i}`);
}

// --- key builders ------------------------------------------------------------

export const listingKey = (id: string) => ({
  [ATTR.pk]: `LISTING#${id}`,
  [ATTR.sk]: `LISTING#${id}`,
});

/**
 * Recency index attributes for an ACTIVE listing.
 *
 * Inactive listings must OMIT these attributes entirely rather than setting a
 * flag — a DynamoDB item with no GSI1PK is absent from GSI1, so deactivation
 * is an index eviction rather than something every read has to filter out.
 * The sweep does this by REMOVEing GSI1PK.
 */
export const activeIndexKey = (id: string, dateMs: number) => ({
  [ATTR.gsi1pk]: `ACTIVE#${activeShard(id)}`,
  [ATTR.gsi1sk]: `${String(dateMs).padStart(15, '0')}#${id}`,
});

/**
 * Company index attributes.
 *
 * normalizedCompany comes from the frozen companyNormalizer.ts. Because this
 * lives on a GSI rather than the base table, a change in normalization rewrites
 * one index entry instead of orphaning the item.
 */
export const companyIndexKey = (
  normalizedCompany: string,
  id: string,
  dateMs: number,
) => ({
  [ATTR.gsi2pk]: `COMPANY#${normalizedCompany}`,
  [ATTR.gsi2sk]: `${String(dateMs).padStart(15, '0')}#${id}`,
});

/** Per-source scrape state (etag, sha, circuit breaker), one item per source. */
export const scrapeStateKey = (sourceSlug: string) => ({
  [ATTR.pk]: 'META#SCRAPE',
  [ATTR.sk]: `SOURCE#${sourceSlug}`,
});

/** Async tailor job. Carries a ttl attribute; see docs. */
export const jobKey = (jobId: string) => ({
  [ATTR.pk]: `JOB#${jobId}`,
  [ATTR.sk]: `JOB#${jobId}`,
});

/**
 * Per-user daily rate-limit bucket.
 *
 * day is a UTC yyyy-mm-dd string. Holds `reserved` and `consumed` counters:
 * enqueue increments reserved, the worker moves it to consumed only on a
 * validated result, and failures release the reservation.
 */
export const rateLimitKey = (uid: string, day: string) => ({
  [ATTR.pk]: `RATE#${uid}`,
  [ATTR.sk]: `DAY#${day}`,
});

/**
 * Zero-padded so lexicographic sort matches numeric sort.
 *
 * DynamoDB sorts string sort keys bytewise, so an unpadded "9999" would sort
 * after "10000". 15 digits covers epoch-ms well past year 33000.
 */
export const sortableDate = (dateMs: number) => String(dateMs).padStart(15, '0');
