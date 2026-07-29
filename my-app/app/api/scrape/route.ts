import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { rankInternships } from '@/lib/ranker';
import { readListingsFromFirestore } from '@/lib/firestore';

export async function GET(request: NextRequest) {
  const { searchParams } = new URL(request.url);
  const location = searchParams.get('location') ?? '';

  const all = await readListingsFromFirestore();
  const internships = rankInternships(all, location);

  return NextResponse.json(
    { internships, total: internships.length },
    {
      headers: {
        'Cache-Control': 'public, s-maxage=60, stale-while-revalidate=300',
      },
    }
  );
}
