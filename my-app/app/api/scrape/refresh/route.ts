import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { scrapeAllReposWithState } from '@/lib/scraper';
import { getScrapeState, writeListings } from '@/lib/firestore';
import { doc, setDoc } from 'firebase/firestore';
import { db } from '@/lib/firebase';

// Vercel Cron issues GET requests, so this route must never be statically
// optimized — otherwise the cron receives a build-time cached response.
export const dynamic = 'force-dynamic';

async function handleRefresh(request: NextRequest) {
  // Guard with CRON_SECRET
  const authHeader = request.headers.get('authorization');
  if (authHeader !== `Bearer ${process.env.CRON_SECRET}`) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 });
  }

  try {
    const scrapeState = await getScrapeState();
    const { listings, perSource } = await scrapeAllReposWithState(scrapeState || undefined, true);

    const result = await writeListings(listings, scrapeState || undefined);

    // Update scrapeState with latest per-source metadata
    const newState = {
      lastRunAt: Date.now(),
      perSource,
    };

    await setDoc(doc(db, 'meta', 'scrapeState'), newState, { merge: true });

    // Per-source parse counts make a stale source visible in the cron logs.
    const countsBySource = listings.reduce<Record<string, number>>((acc, l) => {
      acc[l.source] = (acc[l.source] || 0) + 1;
      return acc;
    }, {});

    return NextResponse.json({
      status: 'ok',
      written: result.written,
      skipped: result.skipped,
      total: listings.length,
      countsBySource,
    });
  } catch (e) {
    console.error('Refresh failed:', e);
    return NextResponse.json(
      { error: 'Refresh failed', details: String(e) },
      { status: 500 }
    );
  }
}

// Cron hits GET; POST is kept for manual triggering. Both require CRON_SECRET.
export const GET = handleRefresh;
export const POST = handleRefresh;
