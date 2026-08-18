import type { Internship } from './types';
import { prestigeOf } from './companies';
import { normalizeCompanyName } from './companyNormalizer';
import { detectExpiration } from './expirationDetector';
import { fetchWithRetry } from './retryManager';
import { initRateLimiter, rateLimitedFetch } from './rateLimiter';
import sourcesData from './sources.json';

// Initialize rate limiter on module load
initRateLimiter({
  maxConcurrentGlobal: 30,
  maxConcurrentPerHost: 5,
  minDelayBetweenRequestsMs: 100,
});

// Legacy fallback if sources.json fails to load
const FALLBACK_REPOS = [
  'https://raw.githubusercontent.com/vanshb03/Summer2027-Internships/main/README.md',
  'https://raw.githubusercontent.com/sndsh404/summer-2027-internships/main/README.md',
];

// Exported for the AWS scrape dispatcher, which enumerates sources to fan out
// one SQS message per source. Behavior is unchanged for existing callers.
export function loadSources() {
  try {
    const sources = sourcesData.sources || [];
    return sources.filter((s) => s.enabled).map((s) => s.url);
  } catch {
    console.warn('Failed to load sources.json, using fallback repos');
    return FALLBACK_REPOS;
  }
}

// Derive a short repo slug ("owner/repo") from a raw GitHub URL for the `source` field.
// Exported so the worker can key per-source scrape state identically.
export function repoSlug(url: string): string {
  const m = url.match(/githubusercontent\.com\/([^/]+)\/([^/]+)\//);
  return m ? `${m[1]}/${m[2]}` : url;
}

// Remove supplementary unicode planes (emoji, flags) + variation selectors / ZWJ.
export function stripEmoji(str: string): string {
  return str
    .replace(/[\u{10000}-\u{10FFFF}]/gu, '')
    .replace(/[\u{2600}-\u{27BF}\u{FE0F}\u{200D}\u{2B00}-\u{2BFF}]/gu, '')
    .trim();
}

// { text, url } from a markdown [text](url) or <a href="url">text</a>, else { text: cell, url: '' }
export function extractMarkdownLink(cell: string): { text: string; url: string } {
  const raw = cell.trim();

  // Markdown link: [text](url) — text may itself contain an <img> badge.
  const md = raw.match(/\[([^\]]*)\]\(([^)\s]+)[^)]*\)/);
  if (md) {
    let text = md[1].replace(/<[^>]+>/g, '').trim();
    if (!text) {
      // Badge-only link (e.g. [<img ...>](url)); fall back to alt text or empty.
      const alt = md[1].match(/alt=["']([^"']+)["']/);
      text = alt ? alt[1].trim() : '';
    }
    return { text: stripEmoji(text), url: md[2].trim() };
  }

  // HTML anchor: <a href="url">text</a>
  const a = raw.match(/<a\s+[^>]*href=["']([^"']+)["'][^>]*>(.*?)<\/a>/i);
  if (a) {
    const text = a[2].replace(/<[^>]+>/g, '').trim();
    return { text: stripEmoji(text), url: a[1].trim() };
  }

  return { text: stripEmoji(raw.replace(/<[^>]+>/g, '').trim()), url: '' };
}

// Try native Date parse, then a "Jul 2025" / "Jul 01" style fallback. Returns epoch ms, 0 on failure.
export function parseDate(str: string): number {
  const s = stripEmoji(str).trim();
  if (!s) return 0;

  const native = new Date(s);
  if (!isNaN(native.getTime())) return native.getTime();

  const MONTHS: Record<string, number> = {
    jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
    jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
  };
  const m = s.toLowerCase().match(/([a-z]{3})[a-z]*\.?\s+(\d{1,4})/);
  if (m && m[1] in MONTHS) {
    const month = MONTHS[m[1]];
    const num = parseInt(m[2], 10);
    // "Jul 2025" → year; "Jul 01" → day of current year.
    let date: Date;
    if (num > 31) {
      date = new Date(num, month, 1);
    } else {
      date = new Date(new Date().getFullYear(), month, num);
      // If date is more than 30 days in future, subtract a year (New Year edge case)
      if (date.getTime() - Date.now() > 30 * 24 * 60 * 60 * 1000) {
        date = new Date(date.getFullYear() - 1, month, num);
      }
    }
    return date.getTime();
  }

  return 0;
}

// Format a date from epoch ms to "Month Day" format (e.g., "January 15", "December 8")
export function formatDateToMonthDay(dateMs: number): string {
  if (dateMs === 0) return '—';
  const date = new Date(dateMs);
  return date.toLocaleDateString('en-US', { month: 'long', day: 'numeric' });
}

// Split a markdown table row into trimmed cells, dropping the leading/trailing pipe delimiters.
export function splitRow(line: string): string[] {
  // Split on unescaped pipes.
  const cells = line.split(/(?<!\\)\|/).map((c) => c.replace(/\\\|/g, '|').trim());
  // Drop empty leading/trailing cells produced by edge pipes.
  if (cells.length && cells[0] === '') cells.shift();
  if (cells.length && cells[cells.length - 1] === '') cells.pop();
  return cells;
}

export function isSeparatorRow(line: string): boolean {
  return /^\s*\|?[\s:|-]*-[\s:|-]*\|?\s*$/.test(line) && line.includes('-');
}

interface ColMap {
  company: number;
  role: number;
  location: number;
  appUrl: number;
  date: number;
}

export function detectColumns(header: string[]): ColMap | null {
  const map: ColMap = { company: -1, role: -1, location: -1, appUrl: -1, date: -1 };
  header.forEach((h, i) => {
    const k = h.toLowerCase();
    if (map.company < 0 && /compan|organi/.test(k)) map.company = i;
    if (map.role < 0 && /role|position|title|job/.test(k)) map.role = i;
    if (map.location < 0 && /location|loc/.test(k)) map.location = i;
    if (map.appUrl < 0 && /application|link|apply|url/.test(k)) map.appUrl = i;
    if (map.date < 0 && /date|added|posted/.test(k)) map.date = i;
  });
  // Need at least a company + role to be a usable internship table.
  if (map.company < 0 || map.role < 0) return null;
  return map;
}

export function normalizeAppUrl(url: string): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    // lowercase host, strip utm_*/gh_src/ref/source query params, trailing slash
    parsed.hostname = parsed.hostname.toLowerCase();
    const params = new URLSearchParams(parsed.search);
    params.delete('utm_source');
    params.delete('utm_medium');
    params.delete('utm_campaign');
    params.delete('utm_content');
    params.delete('utm_term');
    params.delete('gh_src');
    params.delete('ref');
    params.delete('source');
    parsed.search = params.toString();
    parsed.pathname = parsed.pathname.replace(/\/$/, '');
    return parsed.toString();
  } catch {
    return url;
  }
}

function parseMarkdown(md: string, source: string): Internship[] {
  const out: Internship[] = [];
  const lines = md.split(/\r?\n/);
  let cols: ColMap | null = null;
  let lastCompany = '';
  let lastCompanyUrl = '';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const isTableRow = line.trim().startsWith('|');

    if (!isTableRow) {
      cols = null; // table block ended
      continue;
    }

    // Possible header: this row + next row is a separator.
    if (!cols && i + 1 < lines.length && isSeparatorRow(lines[i + 1])) {
      cols = detectColumns(splitRow(line));
      if (cols) {
        lastCompany = '';
        lastCompanyUrl = '';
        i++; // skip separator
      }
      continue;
    }

    if (isSeparatorRow(line)) continue;
    if (!cols) continue;

    const cells = splitRow(line);
    const cell = (idx: number) => (idx >= 0 && idx < cells.length ? cells[idx] : '');

    // Skip closed positions.
    if (line.includes('🔒')) continue;

    const companyCell = cell(cols.company);
    const companyLink = extractMarkdownLink(companyCell);
    let company = companyLink.text;
    let companyUrl = companyLink.url;

    // Carry forward company for "↳" / blank continuation rows (repeated company, new role).
    if (!company || company === '↳' || company === '⤷') {
      company = lastCompany;
      companyUrl = lastCompanyUrl;
    } else {
      lastCompany = company;
      lastCompanyUrl = companyUrl;
    }
    if (!company) continue;

    const role = extractMarkdownLink(cell(cols.role)).text;

    // Location: replace <br> with ", " then strip emoji.
    const locRaw = cell(cols.location).replace(/<br\s*\/?>/gi, ', ');
    const location = stripEmoji(locRaw.replace(/<[^>]+>/g, '').trim())
      .replace(/\s*,\s*/g, ', ')
      .replace(/(,\s*)+$/, '')
      .trim();

    const appLink = extractMarkdownLink(cell(cols.appUrl));
    const appUrl = normalizeAppUrl(appLink.url);

    const dateRaw = stripEmoji(cell(cols.date).replace(/<[^>]+>/g, '')).trim();
    const dateMs = parseDate(dateRaw);

    if (!role && !appUrl) continue;

    const id = appUrl || `${source}:${company}:${role}:${location}`;

    out.push({
      id,
      company,
      companyUrl: companyUrl || undefined,
      role: role || '—',
      location: location || '—',
      appUrl,
      datePosted: dateRaw || '—',
      dateMs,
      prestigeScore: prestigeOf(company),
      source,
    });
  }

  return out;
}

async function scrapeRepo(url: string, scrapeState?: any, useNoStore: boolean = false): Promise<{ listings: Internship[]; etag?: string; sha?: string }> {
  const slug = repoSlug(url);
  const state = scrapeState?.perSource?.[slug] || {};
  const headers: Record<string, string> = {};

  // Conditional request with etag
  if (state.etag) {
    headers['If-None-Match'] = state.etag;
  }

  let md = '';
  let etag: string | undefined;
  let sha: string | undefined;

  // For GitHub sources, check commit SHA first
  if (url.includes('raw.githubusercontent.com')) {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)|githubusercontent\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      const owner = match[1] || match[3];
      const repo = match[2] || match[4];
      try {
        const commitRes = await rateLimitedFetch(
          `https://api.github.com/repos/${owner}/${repo}/commits?path=README.md&per_page=1`,
          () =>
            fetchWithRetry(
              `https://api.github.com/repos/${owner}/${repo}/commits?path=README.md&per_page=1`,
              {
                headers: process.env.GITHUB_TOKEN
                  ? { Authorization: `token ${process.env.GITHUB_TOKEN}` }
                  : {},
                maxRetries: 2,
                timeoutMs: 5000,
              }
            )
        );
        if (commitRes.ok) {
          const commits = await commitRes.json();
          if (commits[0]) {
            const headSha = commits[0].sha;
            if (state.sha === headSha) {
              return { listings: [], sha: headSha, etag };
            }
            sha = headSha;
          }
        }
      } catch (e) {
        // API check failed; fall through to unconditional fetch
      }
    }
  }

  const res = await rateLimitedFetch(url, () =>
    fetchWithRetry(url, {
      headers,
      maxRetries: 3,
      timeoutMs: 10000,
      ...(useNoStore && { cache: 'no-store' }),
    })
  );

  if (res.status === 304) {
    return { listings: [], etag: state.etag, sha: state.sha };
  }

  if (!res.ok) throw new Error(`Failed to fetch ${url}: ${res.status}`);

  etag = res.headers.get('ETag') || undefined;
  md = await res.text();

  // Try .github/scripts/listings.json first
  let listings: Internship[] = [];
  if (url.includes('raw.githubusercontent.com')) {
    const match = url.match(/github\.com\/([^/]+)\/([^/]+)|githubusercontent\.com\/([^/]+)\/([^/]+)/);
    if (match) {
      const owner = match[1] || match[3];
      const repo = match[2] || match[4];
      try {
        const structRes = await rateLimitedFetch(
          `https://raw.githubusercontent.com/${owner}/${repo}/main/.github/scripts/listings.json`,
          () =>
            fetchWithRetry(
              `https://raw.githubusercontent.com/${owner}/${repo}/main/.github/scripts/listings.json`,
              { maxRetries: 1, timeoutMs: 5000 }
            )
        );
        if (structRes.ok) {
          const data = await structRes.json();
          if (Array.isArray(data)) {
            listings = data
              // The feed keeps closed/hidden roles in the file; drop them here
              // so they never reach the ranker.
              .filter((item: any) => item.active !== false && item.is_visible !== false)
              .map((item: any) => {
                // This feed is snake_case; accept camelCase too so a source that
                // publishes the other convention still maps cleanly.
                const appUrl = normalizeAppUrl(item.url || item.appUrl || '');
                const company = item.company_name || item.company || '';
                const location = Array.isArray(item.locations)
                  ? item.locations.join(', ')
                  : item.locations || item.location || '—';
                // date_posted / date_updated are epoch *seconds*.
                const epochSec = item.date_posted ?? item.date_updated;
                const dateMs =
                  typeof epochSec === 'number'
                    ? epochSec * 1000
                    : typeof item.dateMs === 'number'
                      ? item.dateMs
                      : parseDate(item.datePosted || '');

                return {
                  id: appUrl || `${slug}:${company}:${item.title || item.role || ''}`,
                  company,
                  companyUrl: item.company_url || item.companyUrl || undefined,
                  role: item.title || item.role || '—',
                  location: location || '—',
                  appUrl,
                  datePosted: dateMs ? formatDateToMonthDay(dateMs) : '—',
                  dateMs,
                  prestigeScore: prestigeOf(company),
                  source: slug,
                };
              })
              // A record with no company and no link is unusable downstream.
              .filter((l: Internship) => l.company && l.id);
          }
        }
      } catch (e) {
        // Fall through to markdown parsing
      }
    }
  }

  if (listings.length === 0) {
    listings = parseMarkdown(md, slug);
  }

  // Enhance with expiration detection
  listings = listings.map((internship) => {
    const exp = detectExpiration(internship.dateMs);
    return {
      ...internship,
      expirationReason: exp.reason,
      isExpired: exp.isExpired,
    };
  });

  return { listings, etag, sha };
}

/** Per-source state persisted between runs (etag/sha short-circuit + circuit breaker). */
export interface SourceState {
  etag?: string;
  sha?: string;
  lastOk?: number;
  failCount: number;
  circuitBreakerUntil?: number;
}

export interface ScrapeOneSourceResult {
  listings: Internship[];
  state: SourceState;
  /** True when the source was skipped because its circuit breaker is open. */
  skipped: boolean;
  /** True when etag/sha matched and the source returned no new content. */
  unchanged: boolean;
}

export const CIRCUIT_BREAKER_THRESHOLD = 3;
export const CIRCUIT_BREAKER_DURATION_MS = 30 * 60 * 1000; // 30 min

/**
 * Scrape exactly one source and return its listings plus updated state.
 *
 * Extracted from scrapeAllReposWithState so the AWS worker Lambda can process a
 * single source per SQS message. The multi-source path is unchanged and still
 * uses its own Promise.allSettled loop — this is additive, not a rewrite of it.
 *
 * Deduplication is deliberately NOT done here: with one source per invocation
 * there is nothing to dedupe against, and cross-source dedup now happens in
 * DynamoDB via the listingId (a hash of appUrl), which collapses duplicates
 * from different sources onto the same item.
 *
 * Throws on fetch failure so the caller (and SQS) can treat it as a retryable
 * message rather than a silent empty result.
 */
export async function scrapeOneSource(
  url: string,
  priorState?: SourceState,
  now: number = Date.now()
): Promise<ScrapeOneSourceResult> {
  const state: SourceState = { failCount: 0, ...priorState };

  // Circuit breaker: skip while open, reset once it has expired.
  if (state.circuitBreakerUntil) {
    if (now > state.circuitBreakerUntil) {
      state.circuitBreakerUntil = undefined;
      state.failCount = 0;
    } else {
      return { listings: [], state, skipped: true, unchanged: false };
    }
  }

  try {
    // scrapeRepo reads prior etag/sha out of the multi-source shape, so wrap
    // this source's state to match what it expects.
    const slug = repoSlug(url);
    const { listings, etag, sha } = await scrapeRepo(url, {
      perSource: { [slug]: state },
    });

    const unchanged = listings.length === 0 && (etag !== undefined || sha !== undefined);

    return {
      listings,
      state: {
        ...state,
        ...(etag && { etag }),
        ...(sha && { sha }),
        lastOk: now,
        failCount: 0,
        circuitBreakerUntil: undefined,
      },
      skipped: false,
      unchanged,
    };
  } catch (err) {
    // Record the failure and trip the breaker at the threshold, then rethrow so
    // the message is retried and eventually dead-lettered.
    state.failCount = (state.failCount || 0) + 1;
    if (state.failCount >= CIRCUIT_BREAKER_THRESHOLD) {
      state.circuitBreakerUntil = now + CIRCUIT_BREAKER_DURATION_MS;
    }
    throw Object.assign(err instanceof Error ? err : new Error(String(err)), {
      sourceState: state,
    });
  }
}

export async function scrapeAllReposWithState(scrapeState?: any, useNoStore: boolean = false): Promise<{
  listings: Internship[];
  perSource: Record<string, { etag?: string; sha?: string; lastOk?: number; failCount: number; circuitBreakerUntil?: number }>;
}> {
  const repos = loadSources();
  const perSource: Record<
    string,
    { etag?: string; sha?: string; lastOk?: number; failCount: number; circuitBreakerUntil?: number }
  > = scrapeState?.perSource || {};

  const all: Internship[] = [];
  const dedupMap = new Map<string, Internship>();
  const CIRCUIT_BREAKER_THRESHOLD = 3;
  const CIRCUIT_BREAKER_DURATION_MS = 30 * 60 * 1000; // 30 min

  // Filter out sources that are in circuit breaker
  const reposToScrape = repos
    .map((url, idx) => ({ url, idx }))
    .filter((item) => {
      const slug = repoSlug(item.url);
      const state = perSource[slug];
      if (!state?.circuitBreakerUntil) return true;
      if (Date.now() > state.circuitBreakerUntil) {
        // Circuit breaker expired; reset
        state.circuitBreakerUntil = undefined;
        state.failCount = 0;
        return true;
      }
      // Still in circuit breaker; skip
      console.warn(`Source ${slug} is in circuit breaker until ${new Date(state.circuitBreakerUntil).toISOString()}`);
      return false;
    });

  const results = await Promise.allSettled(
    reposToScrape.map((item) => scrapeRepo(item.url, scrapeState, useNoStore))
  );

  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    const { url } = reposToScrape[i];
    const slug = repoSlug(url);

    if (r.status === 'fulfilled') {
      const { listings, etag, sha } = r.value;

      // Update per-source metadata
      if (etag || sha) {
        perSource[slug] = {
          ...perSource[slug],
          ...(etag && { etag }),
          ...(sha && { sha }),
          lastOk: Date.now(),
          failCount: 0,
          circuitBreakerUntil: undefined,
        };
      }

      for (const listing of listings) {
        if (listing.appUrl) {
          // Dedupe on normalized appUrl: keep record with more recent dateMs
          const key = listing.appUrl;
          const existing = dedupMap.get(key);
          if (!existing || listing.dateMs > existing.dateMs) {
            dedupMap.set(key, listing);
          }
        } else {
          dedupMap.set(listing.id, listing);
        }
      }
    } else {
      console.error('Scrape failed for', slug, ':', r.reason);
      // Increment failCount
      const state = perSource[slug] || {};
      state.failCount = (state.failCount || 0) + 1;

      // Engage circuit breaker if threshold reached
      if (state.failCount >= CIRCUIT_BREAKER_THRESHOLD) {
        state.circuitBreakerUntil = Date.now() + CIRCUIT_BREAKER_DURATION_MS;
        console.error(`Circuit breaker activated for ${slug} until ${new Date(state.circuitBreakerUntil).toISOString()}`);
      }

      perSource[slug] = state;
    }
  }

  for (const listing of dedupMap.values()) {
    all.push(listing);
  }

  return { listings: all, perSource };
}

// Legacy API for backward compatibility: returns Internship[] only
export async function scrapeAllRepos(): Promise<Internship[]> {
  const { listings } = await scrapeAllReposWithState();
  return listings;
}
