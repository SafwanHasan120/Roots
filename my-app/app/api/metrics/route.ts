import { NextResponse } from 'next/server';
import type { NextRequest } from 'next/server';
import { rankInternships } from '@/lib/ranker';
import { readActiveListings } from '@/lib/listingsSource';
import { MetricsCollector, checkAlerts } from '@/lib/metrics';
import sourcesData from '@/lib/sources.json';

export const revalidate = 3600;

/**
 * Scraper metrics.
 *
 * Previously this triggered a FULL live scrape on every request, unauthenticated
 * — an unmetered way for anyone to make the app hammer GitHub. It now reports on
 * what the scheduled scrape actually stored, and requires a shared secret.
 */
export async function GET(request: NextRequest) {
  const startTime = Date.now();

  const expected = process.env.METRICS_SECRET;
  if (!expected) {
    // Fail closed. A missing secret must not silently reopen the endpoint.
    return NextResponse.json(
      { success: false, error: 'Metrics endpoint is not configured' },
      { status: 503, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '');
  if (provided !== expected) {
    return NextResponse.json(
      { success: false, error: 'Unauthorized' },
      { status: 401, headers: { 'Cache-Control': 'no-store' } }
    );
  }

  const collector = new MetricsCollector();

  try {
    // throwOnEmpty:false — an empty store is a fact worth reporting here, not a
    // failure. This endpoint exists precisely to surface that state.
    const all = await readActiveListings({ throwOnEmpty: false });
    collector.recordFetch(all.length);

    const ranked = rankInternships(all);
    collector.recordParsed(ranked);

    const expiredCount = ranked.filter((i) => i.isExpired).length;
    collector.recordExpired(expiredCount);

    // linkHealth is populated by the scrape worker, so this distribution is
    // finally meaningful — nothing wrote the field before the migration.
    ranked.forEach((i) => {
      if (i.linkHealth) {
        collector.recordLinkHealth(i.linkHealth);
      }
    });

    try {
      const sources = sourcesData.sources || [];
      sources.forEach((source) => {
        const sourceInternships = ranked.filter((i) => i.source.includes(source.id));
        const validCount = sourceInternships.filter((i) => i.appUrl).length;
        const parseSuccessRate =
          sourceInternships.length > 0 ? validCount / sourceInternships.length : 0;

        collector.recordSourceMetrics(source.id, {
          id: source.id,
          name: source.name,
          rowsFetched: sourceInternships.length,
          parseSuccessRate: Math.round(parseSuccessRate * 10000) / 10000,
          validationRate: Math.round(parseSuccessRate * 10000) / 10000,
          enabled: source.enabled,
        });
      });
    } catch (error) {
      console.error('Failed to record source metrics:', error);
    }

    const metrics = collector.build();
    const alerts = checkAlerts(metrics);
    if (alerts.length > 0) {
      console.warn('Scraper alerts:', alerts);
    }

    return NextResponse.json(
      { metrics, alerts, success: true },
      {
        headers: {
          'Cache-Control': 'private, s-maxage=3600, stale-while-revalidate=86400',
        },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      { success: false, error: msg, duration: Date.now() - startTime },
      { status: 500, headers: { 'Cache-Control': 'no-store' } }
    );
  }
}
