import { rateLimitedFetch } from './rateLimiter';
import { fetchWithRetry } from './retryManager';

export type ExtractionMethod = 'jsonld' | 'api' | 'html';

export interface ExtractedJD {
  text: string;
  method: ExtractionMethod;
  confidence: 'high' | 'low';
  finalUrl?: string;
}

interface CachedJD {
  data: ExtractedJD;
  cachedAt: number;
}

// In-memory cache for JD extraction (6h TTL)
const jdCache = new Map<string, CachedJD>();
const CACHE_TTL_MS = 6 * 60 * 60 * 1000;

function passesQualityGate(text: string): boolean {
  // Require >400 chars after cleanup
  if (text.length < 400) return false;

  // Match requirement keywords
  const keywordPattern =
    /responsibilit|qualificat|requirement|experience with|you'll|you will|required skills|key qualifications/i;
  return keywordPattern.test(text);
}

function stripBoilerplate(text: string): string {
  // Remove common footer/header boilerplate
  const lines = text.split('\n');
  const filtered = lines
    .filter(
      (line) =>
        !line.match(
          /^(posted|copyright|all rights|follow us|share this|apply now|posted on|about us|contact|privacy|terms)/i
        )
    )
    .join('\n');

  return filtered.trim();
}

function stripHtmlTags(html: string): string {
  // Strip specific tags: script, style, nav, header, footer, aside
  let result = html;
  result = result.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '');
  result = result.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '');
  result = result.replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '');
  result = result.replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '');
  result = result.replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '');
  result = result.replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '');
  // Strip all remaining tags
  result = result.replace(/<[^>]+>/g, ' ');
  result = result.replace(/\s+/g, ' ');
  return result.trim();
}

function getLargestTextBlock(html: string): string {
  // Find the largest block of text (likely the main content)
  const divPattern =
    /<(div|section|article|main|content)\b[^>]*>([\s\S]*?)<\/\1>/gi;
  let largest = '';

  let match;
  while ((match = divPattern.exec(html)) !== null) {
    const text = stripHtmlTags(match[2]);
    if (text.length > largest.length) {
      largest = text;
    }
  }

  return largest || stripHtmlTags(html);
}

function truncateAroundHeadings(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;

  // Find requirement-related headings
  const requirementPattern =
    /^(requirements|qualifications|responsibilities|responsibilities|required skills|about the role|job description)$/i;

  const lines = text.split('\n');
  let result = '';

  for (let i = 0; i < lines.length && result.length < maxChars; i++) {
    const line = lines[i];
    result += line + '\n';

    // If we found a requirement heading and we're past it, continue
    if (requirementPattern.test(line.trim())) {
      // Prioritize content after this heading
      for (let j = i + 1; j < lines.length && result.length < maxChars; j++) {
        result += lines[j] + '\n';
      }
      break;
    }
  }

  return result.substring(0, maxChars).trim();
}

async function extractFromJsonLD(html: string): Promise<string | null> {
  try {
    const jsonLdPattern =
      /<script[^>]*type="application\/ld\+json"[^>]*>([\s\S]*?)<\/script>/gi;
    let match;

    while ((match = jsonLdPattern.exec(html)) !== null) {
      const jsonText = match[1];
      try {
        const json = JSON.parse(jsonText);

        // Check if it's a JobPosting schema
        if (
          json['@type'] === 'JobPosting' ||
          json.type === 'JobPosting'
        ) {
          const parts: string[] = [];

          if (json.description) parts.push(String(json.description));
          if (json.qualifications) parts.push(String(json.qualifications));
          if (json.responsibilities) parts.push(String(json.responsibilities));
          if (json.skills) {
            const skills = Array.isArray(json.skills)
              ? json.skills.join(', ')
              : String(json.skills);
            parts.push(skills);
          }

          if (parts.length > 0) {
            return parts.join('\n\n');
          }
        }
      } catch {
        // Skip malformed JSON
        continue;
      }
    }

    return null;
  } catch {
    return null;
  }
}

async function extractFromKnownAPIs(url: string, finalUrl: string): Promise<string | null> {
  try {
    const hostname = new URL(finalUrl).hostname;

    // Greenhouse
    if (hostname.includes('greenhouse.io')) {
      const jobId = finalUrl.match(/\/jobs\/(\d+)/)?.[1];
      if (jobId) {
        const apiUrl = `https://job-boards.greenhouse.io/api/v1/boards/${hostname.split('.')[0]}/jobs/${jobId}`;
        const res = await rateLimitedFetch(apiUrl, () =>
          fetchWithRetry(apiUrl, {
            timeoutMs: 8000,
            maxRetries: 2,
          })
        );
        const data = (await res.json()) as any;
        if (data.content) {
          return stripHtmlTags(data.content);
        }
      }
    }

    // Lever
    if (hostname.includes('lever.co')) {
      const match = finalUrl.match(/\/postings\/([^/]+)\/([^/]+)/);
      if (match) {
        const [, org, id] = match;
        const apiUrl = `https://api.lever.co/v0/postings/${org}/${id}`;
        const res = await rateLimitedFetch(apiUrl, () =>
          fetchWithRetry(apiUrl, {
            timeoutMs: 8000,
            maxRetries: 2,
          })
        );
        const data = (await res.json()) as any;
        if (data.data && data.data.content) {
          return stripHtmlTags(data.data.content);
        }
      }
    }

    // Ashby
    if (hostname.includes('ashby.com') || hostname.includes('jobs.ashby.com')) {
      // Ashby requires a different approach; skip for now
      return null;
    }

    return null;
  } catch {
    return null;
  }
}

async function extractFromHTML(html: string): Promise<string | null> {
  try {
    const largest = getLargestTextBlock(html);
    return largest.length > 0 ? largest : null;
  } catch {
    return null;
  }
}

async function fetchWithFollowRedirects(url: string): Promise<{ html: string; finalUrl: string }> {
  return rateLimitedFetch(url, async () => {
    const res = await fetchWithRetry(url, {
      timeoutMs: 10000,
      maxRetries: 2,
    });
    const html = await res.text();
    return { html, finalUrl: res.url };
  });
}

export async function extractJD(url: string): Promise<ExtractedJD> {
  // Check cache first
  const cached = jdCache.get(url);
  if (cached && Date.now() - cached.cachedAt < CACHE_TTL_MS) {
    return cached.data;
  }

  try {
    const { html, finalUrl } = await fetchWithFollowRedirects(url);

    // Strategy 1: JSON-LD (before any script stripping)
    let text = await extractFromJsonLD(html);
    if (text && passesQualityGate(stripBoilerplate(text))) {
      const result: ExtractedJD = {
        text: stripBoilerplate(text),
        method: 'jsonld',
        confidence: 'high',
        finalUrl,
      };
      jdCache.set(url, { data: result, cachedAt: Date.now() });
      return result;
    }

    // Strategy 2: Known-host APIs
    text = await extractFromKnownAPIs(url, finalUrl);
    if (text && passesQualityGate(stripBoilerplate(text))) {
      const result: ExtractedJD = {
        text: stripBoilerplate(text),
        method: 'api',
        confidence: 'high',
        finalUrl,
      };
      jdCache.set(url, { data: result, cachedAt: Date.now() });
      return result;
    }

    // Strategy 3: Generic HTML
    text = await extractFromHTML(html);
    if (text) {
      text = stripBoilerplate(text);
      const confidence = passesQualityGate(text) ? 'high' : 'low';

      // Truncate to 8000 chars, slicing around requirement headings
      const truncated = truncateAroundHeadings(text, 8000);

      const result: ExtractedJD = {
        text: truncated,
        method: 'html',
        confidence,
        finalUrl,
      };
      jdCache.set(url, { data: result, cachedAt: Date.now() });
      return result;
    }

    // Fallback: could not extract anything meaningful
    const result: ExtractedJD = {
      text: '',
      method: 'html',
      confidence: 'low',
      finalUrl,
    };
    jdCache.set(url, { data: result, cachedAt: Date.now() });
    return result;
  } catch (error) {
    console.error('JD extraction failed:', error);
    throw new Error(`Failed to extract job description from ${url}`);
  }
}

export function clearJDCache(): void {
  jdCache.clear();
}

export function getJDCacheStats() {
  return {
    cachedUrls: jdCache.size,
    entries: Array.from(jdCache.entries()).map(([url, cached]) => ({
      url,
      method: cached.data.method,
      confidence: cached.data.confidence,
      age: Date.now() - cached.cachedAt,
    })),
  };
}
