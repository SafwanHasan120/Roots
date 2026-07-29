import { NextResponse } from 'next/server';
import { scrapeAllRepos } from '@/lib/scraper';
import { rankInternships } from '@/lib/ranker';
import { MetricsCollector, checkAlerts } from '@/lib/metrics';
import { isExpiredOrOld } from '@/lib/expirationDetector';
import sourcesData from '@/lib/sources.json';

export const revalidate = 3600;

export async function GET() {
  const startTime = Date.now();
  const collector = new MetricsCollector();

  try {
    // Scrape all sources
    const all = await scrapeAllRepos();
    collector.recordFetch(all.length);

    // Rank internships
    const ranked = rankInternships(all);
    collector.recordParsed(ranked);

    // Count expired listings
    const expiredCount = ranked.filter((i) => i.isExpired).length;
    collector.recordExpired(expiredCount);

    // Record link health distribution
    ranked.forEach((i) => {
      if (i.linkHealth) {
        collector.recordLinkHealth(i.linkHealth);
      }
    });

    // Record source metrics
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

    // Check for alerts
    const alerts = checkAlerts(metrics);
    if (alerts.length > 0) {
      console.warn('Scraper alerts:', alerts);
    }

    return NextResponse.json(
      { metrics, alerts, success: true },
      {
        headers: {
          'Cache-Control': 'public, s-maxage=3600, stale-while-revalidate=86400',
        },
      }
    );
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    return NextResponse.json(
      {
        success: false,
        error: msg,
        duration: Date.now() - startTime,
      },
      { status: 500 }
    );
  }
}
