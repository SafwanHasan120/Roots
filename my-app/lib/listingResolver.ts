import { createHash } from 'crypto';
import { queryRecent, getListingById } from './listingsRepo';
import type { Internship } from './types';

// Resolves the listing a tailor request refers to.
//
// Previously this ran a full scrape per cache miss, because the homepage
// rendered straight from scrapeAllRepos() and Firestore lagged behind it. Both
// now read the same DynamoDB table, so the drift that made scraping necessary
// is gone: resolve against the same store the user is looking at, and fall back
// to a direct point lookup for listings the recency index no longer carries
// (deactivated ones, which stay in the base table).

interface CachedIndex {
  byId: Map<string, Internship>;
  cachedAt: number;
}

// Long enough that a burst of tailor clicks costs one query, short enough that a
// newly scraped listing resolves without a redeploy.
const INDEX_TTL_MS = 10 * 60 * 1000;

let cachedIndex: CachedIndex | null = null;

/**
 * Surrogate listing id: sha256 of the appUrl, truncated to 32 hex chars.
 *
 * Must stay identical to listingId() in infra/lib/keys.ts — the scrape worker
 * writes items under this id, and a mismatch makes every point lookup miss.
 * lib/__tests__/listingResolver.test.ts asserts the two agree.
 */
export function listingIdFor(appUrl: string): string {
  return createHash('sha256').update(appUrl).digest('hex').slice(0, 32);
}

// Legacy Firestore doc-id form. Firestore is gone, but a client may still hold
// an id minted in that shape (a bookmarked link, cached state), so the index is
// keyed under it too.
function normalizeKey(value: string): string {
  if (!value) return '';
  try {
    const parsed = new URL(value);
    return (parsed.hostname.toLowerCase() + parsed.pathname).replace(/\//g, '_');
  } catch {
    return value;
  }
}

function indexListings(listings: Internship[]): Map<string, Internship> {
  const byId = new Map<string, Internship>();
  for (const listing of listings) {
    // Index under every form a client might send: the stored id, the raw
    // appUrl, the surrogate hash, and the legacy Firestore doc-id form.
    if (listing.id) byId.set(listing.id, listing);
    if (listing.appUrl) {
      byId.set(listing.appUrl, listing);
      byId.set(listingIdFor(listing.appUrl), listing);
    }
    const normalized = normalizeKey(listing.appUrl || listing.id);
    if (normalized) byId.set(normalized, listing);
  }
  return byId;
}

async function getIndex(): Promise<Map<string, Internship>> {
  if (cachedIndex && Date.now() - cachedIndex.cachedAt < INDEX_TTL_MS) {
    return cachedIndex.byId;
  }

  // throwOnEmpty:false — an empty store must not make tailoring impossible for
  // a listing that is still resolvable by point lookup below.
  const listings = await queryRecent({ throwOnEmpty: false });
  const byId = indexListings(listings);
  cachedIndex = { byId, cachedAt: Date.now() };
  return byId;
}

/**
 * Resolve an internship the client asked to tailor against.
 *
 * The caller supplies only an id; the appUrl comes from the resolved record,
 * never from the request body, so a client cannot point the tailor path at a
 * URL of its choosing.
 */
export async function resolveInternship(internshipId: string): Promise<Internship | null> {
  if (!internshipId?.trim()) return null;

  let index: Map<string, Internship> | null = null;
  try {
    index = await getIndex();
  } catch (e) {
    // A failed read must not make tailoring impossible for listings that can
    // still be resolved directly.
    console.error('Listing read failed during resolve, falling back to point lookup:', e);
  }

  if (index) {
    const direct = index.get(internshipId) || index.get(normalizeKey(internshipId));
    if (direct) return direct;
  }

  // Not in the active index: the listing may have been deactivated by the
  // sweep. It remains in the base table, so a point lookup still finds it.
  // Accept either the surrogate id directly, or an appUrl to hash.
  const byId = await getListingById(internshipId);
  if (byId) return byId;

  if (internshipId.startsWith('http')) {
    return getListingById(listingIdFor(internshipId));
  }

  return null;
}

export function clearListingIndexCache(): void {
  cachedIndex = null;
}
