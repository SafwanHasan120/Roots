import { readActiveListings } from '@/lib/listingsSource';
import { rankInternships } from '@/lib/ranker';
import HomeContent from '@/components/HomeContent';
import type { Internship } from '@/lib/types';

export const revalidate = 3600;

// Render on request, not at build time.
//
// The page reads DynamoDB, which is unreachable during a Vercel build (no
// runtime IAM role, and DDB_TABLE_NAME need not exist in the build
// environment). Prerendering would fail the build outright. `revalidate` still
// applies, so the first request populates the ISR cache and subsequent ones are
// served from it for an hour — the caching behaviour is unchanged, only the
// timing of the first render moves.
export const dynamic = 'force-dynamic';

export default async function Home() {
  // Reads from DynamoDB (or Firestore, per LISTINGS_SOURCE) instead of scraping
  // on render. The scrape now runs on a schedule in AWS, so this request path
  // no longer makes three network hops per source before it can draw anything.
  //
  // readActiveListings throws on an empty result rather than returning []. That
  // is deliberate: an empty table means the scrape broke, and throwing lets ISR
  // keep serving the last good render instead of caching an empty page.
  const all = await readActiveListings();
  const internships: Internship[] = rankInternships(all);

  return <HomeContent internships={internships} />;
}
