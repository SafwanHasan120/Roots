import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { rankInternships } from '@/lib/ranker';
import { readActiveListings } from '@/lib/listingsSource';
import { CredentialError, EmptyResultError } from '@/lib/ddbClient';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const location = searchParams.get('location') ?? '';

  try {
    const all = await readActiveListings();
    const internships = rankInternships(all, location);

    return NextResponse.json(
      { internships, total: internships.length },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
        },
      }
    );
  } catch (err) {
    // Never cache a failure. Without no-store an empty or errored response gets
    // served from the edge for the full s-maxage window, turning a transient
    // outage into a sticky one.
    const headers = { 'Cache-Control': 'no-store' };

    if (err instanceof CredentialError) {
      // Distinct from a generic 500 so a missing IAM role is diagnosable at a
      // glance rather than looking like a code bug.
      console.error('AWS credential failure on read path:', err);
      return NextResponse.json(
        { error: 'Listing store unavailable: credentials rejected', internships: [], total: 0 },
        { status: 503, headers }
      );
    }

    if (err instanceof EmptyResultError) {
      console.error('Listing store returned no active listings:', err);
      return NextResponse.json(
        { error: 'No listings available', internships: [], total: 0 },
        { status: 503, headers }
      );
    }

    console.error('Failed to read listings:', err);
    return NextResponse.json(
      { error: 'Failed to read listings', internships: [], total: 0 },
      { status: 500, headers }
    );
  }
}
