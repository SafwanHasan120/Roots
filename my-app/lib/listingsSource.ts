import type { Internship } from './types';
import { queryRecent } from './listingsRepo';
import { readListingsFromFirestore } from './firestore';

/**
 * Read-source indirection for the DynamoDB cutover.
 *
 * LISTINGS_SOURCE selects the backend at runtime:
 *   ddb        - DynamoDB (the target)
 *   firestore  - the pre-migration path
 *
 * This exists so reverting a bad cutover is a Vercel environment change and a
 * redeploy, not a code revert — the scrape path keeps writing DynamoDB either
 * way, and the Vercel cron keeps Firestore current until 2b removes it.
 *
 * Both branches and this whole module are deleted in Sprint 2b once the
 * DynamoDB path has run in production for a full day.
 */

export type ListingsSource = 'ddb' | 'firestore';

export function getListingsSource(): ListingsSource {
  return process.env.LISTINGS_SOURCE === 'firestore' ? 'firestore' : 'ddb';
}

export interface ReadOptions {
  limit?: number;
  /** See queryRecent: the metrics route reports an empty table rather than failing on it. */
  throwOnEmpty?: boolean;
}

/**
 * Read active listings from whichever backend is configured.
 *
 * Returns them unranked and unfiltered. Callers pass the result to
 * rankInternships() themselves, so ranking stays identical across both
 * backends — ranker.ts is frozen and must see the same input shape either way.
 */
export async function readActiveListings(options: ReadOptions = {}): Promise<Internship[]> {
  if (getListingsSource() === 'firestore') {
    const listings = await readListingsFromFirestore();
    // readListingsFromFirestore swallows its own errors and returns [], so an
    // empty result here is indistinguishable from a failure. Apply the same
    // empty-is-an-error rule the DynamoDB path uses.
    if (listings.length === 0 && (options.throwOnEmpty ?? true)) {
      throw new Error('No active listings found in Firestore — the scrape may have failed');
    }
    return listings;
  }

  return queryRecent(options);
}
