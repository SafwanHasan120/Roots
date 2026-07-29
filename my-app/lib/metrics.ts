// Metrics collection and monitoring

import type { Internship } from './types';
import type { LinkHealth } from './urlValidator';

export interface AgeDistribution {
  '0-1mo': number;
  '1-3mo': number;
  '3-6mo': number;
  '6mo+': number;
  'no-date': number;
}

export interface SourceMetrics {
  id: string;
  name: string;
  rowsFetched: number;
  parseSuccessRate: number;
  validationRate: number;
  lastScraped?: number;
  failCount?: number;
  enabled: boolean;
}

export interface ScraperMetrics {
  scrapedAt: number;
  scrapeDurationMs: number;
  totalFetched: number;
  totalParsed: number;
  totalValidated: number;
  validUrlRate: number;
  avgPrestige: number;
  ageDistribution: AgeDistribution;
  expiredCount: number;
  failedUrls: number;
  sourceMetrics: SourceMetrics[];
  linkHealthDistribution: Record<LinkHealth, number>;
}

export class MetricsCollector {
  private startTime = Date.now();
  private totalFetched = 0;
  private totalParsed = 0;
  private validatedUrls = 0;
  private totalUrls = 0;
  private prestigeScores: number[] = [];
  private dateMs: number[] = [];
  private expiredCount = 0;
  private linkHealthCounts: Record<LinkHealth, number> = {
    healthy: 0,
    'not-found': 0,
    'server-error': 0,
    timeout: 0,
    unknown: 0,
  };
  private sourceMetrics: Map<string, SourceMetrics> = new Map();

  recordFetch(count: number): void {
    this.totalFetched += count;
  }

  recordParsed(internships: Internship[]): void {
    this.totalParsed += internships.length;
    internships.forEach((i) => {
      this.totalUrls++;
      if (i.appUrl) {
        this.validatedUrls++;
      }
      this.prestigeScores.push(i.prestigeScore);
      if (i.dateMs > 0) {
        this.dateMs.push(i.dateMs);
      }
    });
  }

  recordLinkHealth(health: LinkHealth, count: number = 1): void {
    this.linkHealthCounts[health] = (this.linkHealthCounts[health] ?? 0) + count;
  }

  recordExpired(count: number): void {
    this.expiredCount += count;
  }

  recordSourceMetrics(id: string, metrics: SourceMetrics): void {
    this.sourceMetrics.set(id, metrics);
  }

  private calculateAgeDistribution(): AgeDistribution {
    const now = Date.now();
    const oneMonthMs = 30 * 24 * 60 * 60 * 1000;
    const dist: AgeDistribution = {
      '0-1mo': 0,
      '1-3mo': 0,
      '3-6mo': 0,
      '6mo+': 0,
      'no-date': 0,
    };

    this.dateMs.forEach((dateMs) => {
      const ageMs = now - dateMs;
      if (ageMs < oneMonthMs) {
        dist['0-1mo']++;
      } else if (ageMs < 3 * oneMonthMs) {
        dist['1-3mo']++;
      } else if (ageMs < 6 * oneMonthMs) {
        dist['3-6mo']++;
      } else {
        dist['6mo+']++;
      }
    });

    dist['no-date'] = this.totalParsed - this.dateMs.length;
    return dist;
  }

  build(): ScraperMetrics {
    const avgPrestige =
      this.prestigeScores.length > 0
        ? this.prestigeScores.reduce((a, b) => a + b, 0) / this.prestigeScores.length
        : 0;

    const validUrlRate = this.totalUrls > 0 ? this.validatedUrls / this.totalUrls : 0;

    return {
      scrapedAt: Date.now(),
      scrapeDurationMs: Date.now() - this.startTime,
      totalFetched: this.totalFetched,
      totalParsed: this.totalParsed,
      totalValidated: this.validatedUrls,
      validUrlRate: Math.round(validUrlRate * 10000) / 10000,
      avgPrestige: Math.round(avgPrestige * 100) / 100,
      ageDistribution: this.calculateAgeDistribution(),
      expiredCount: this.expiredCount,
      failedUrls: this.totalUrls - this.validatedUrls,
      sourceMetrics: Array.from(this.sourceMetrics.values()),
      linkHealthDistribution: this.linkHealthCounts,
    };
  }

  logMetrics(): void {
    const metrics = this.build();
    console.log(JSON.stringify({ type: 'scraper-metrics', ...metrics }, null, 2));
  }
}

// Alert thresholds
export const ALERT_THRESHOLDS = {
  minValidUrlRate: 0.85, // Alert if < 85% of URLs are valid
  maxSourceFailCount: 3, // Alert if source fails > 3 times
  maxScrapeDurationMs: 60000, // Alert if scrape takes > 60s
  maxExpiredRatio: 0.3, // Alert if > 30% of listings are expired
};

export function checkAlerts(metrics: ScraperMetrics): string[] {
  const alerts: string[] = [];

  if (metrics.validUrlRate < ALERT_THRESHOLDS.minValidUrlRate) {
    alerts.push(
      `URL validation rate low: ${(metrics.validUrlRate * 100).toFixed(1)}% (threshold: ${(ALERT_THRESHOLDS.minValidUrlRate * 100).toFixed(1)}%)`
    );
  }

  if (metrics.scrapeDurationMs > ALERT_THRESHOLDS.maxScrapeDurationMs) {
    alerts.push(
      `Scrape duration high: ${metrics.scrapeDurationMs}ms (threshold: ${ALERT_THRESHOLDS.maxScrapeDurationMs}ms)`
    );
  }

  const expiredRatio =
    metrics.totalParsed > 0 ? metrics.expiredCount / metrics.totalParsed : 0;
  if (expiredRatio > ALERT_THRESHOLDS.maxExpiredRatio) {
    alerts.push(
      `High expiration ratio: ${(expiredRatio * 100).toFixed(1)}% (threshold: ${(ALERT_THRESHOLDS.maxExpiredRatio * 100).toFixed(1)}%)`
    );
  }

  metrics.sourceMetrics.forEach((source) => {
    if (source.failCount !== undefined && source.failCount > ALERT_THRESHOLDS.maxSourceFailCount) {
      alerts.push(`Source ${source.id} has ${source.failCount} consecutive failures`);
    }
  });

  return alerts;
}
