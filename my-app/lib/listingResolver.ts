import { scrapeAllRepos } from './scraper';
import { getInternshipById } from './firestore';
import type { Internship } from './types';

// The homepage renders listings straight from scrapeAllRepos(), while the
// Firestore `listings` collection is only populated by the cron-guarded
// /api/scrape/refresh. Resolving the tailor target from Firestore alone made
// every listing that had not yet been persisted 404 even though the user could
// see it on screen. Resolve against the scrape first so the two cannot drift,
// and keep Firestore as a fallback for records the scrape no longer returns.

interface CachedIndex {
  byId: Map<string, Internship>;
  cachedAt: number;
}

// Short TTL: long enough that a burst of tailor clicks costs one scrape, short
// enough that a listing appearing upstream shows up without a redeploy. The
// homepage revalidates hourly, so anything longer would lag what the user sees.
const INDEX_TTL_MS = 10 * 60 * 1000;

let cachedIndex: CachedIndex | null = null;

// Mirrors normalizeListingId + listingDocId in lib/firestore.ts so a listing
// resolves the same whether it arrives as a raw appUrl or a Firestore doc id.
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
    // Index under every form the client might send: the raw id, the appUrl,
    // and the normalized doc-id form.
    if (listing.id) byId.set(listing.id, listing);
    if (listing.appUrl) byId.set(listing.appUrl, listing);
    const normalized = normalizeKey(listing.appUrl || listing.id);
    if (normalized) byId.set(normalized, listing);
  }
  return byId;
}

async function getIndex(): Promise<Map<string, Internship>> {
  if (cachedIndex && Date.now() - cachedIndex.cachedAt < INDEX_TTL_MS) {
    return cachedIndex.byId;
  }

  const listings = await scrapeAllRepos();
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

  let index: Map<string, Internship>;
  try {
    index = await getIndex();
  } catch (e) {
    // A failed scrape must not make tailoring impossible for listings that
    // were persisted previously.
    console.error('Listing scrape failed during resolve, falling back to Firestore:', e);
    return getInternshipById(internshipId);
  }

  const direct = index.get(internshipId) || index.get(normalizeKey(internshipId));
  if (direct) return direct;

  // Not in the current scrape: the listing may have aged out upstream but
  // still exist in Firestore from an earlier refresh.
  return getInternshipById(internshipId);
}

export function clearListingIndexCache(): void {
  cachedIndex = null;
}
