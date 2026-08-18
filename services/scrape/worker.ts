/**
 * Scrape worker. One SQS message = one source.
 *
 * Scrapes the source, probes link health, and upserts each listing into
 * DynamoDB. Throws on failure so SQS redelivers; after maxReceiveCount (3
 * deliveries) the message dead-letters.
 *
 * There is no in-process retry here. The retry unit is the whole message: SQS
 * redelivers it with the original payload from a clean invocation, which is
 * strictly better than burning wall-clock inside a timeout-bounded execution.
 */

import type { SQSEvent, SQSRecord } from 'aws-lambda';
import type { Internship } from '@app/types';
import { scrapeOneSource, type SourceState } from '@app/scraper';
import { validateUrls } from '@app/urlValidator';
import { upsertListing, getSourceState, putSourceState } from './ddb.js';

interface ScrapeMessage {
  url: string;
  slug: string;
  runId: string;
}

export interface WorkerSummary {
  slug: string;
  runId: string;
  scraped: number;
  written: number;
  unchanged: number;
  skipped: boolean;
}

/** Cap on link-health probes per invocation. */
const LINK_PROBE_LIMIT = Number(process.env.LINK_PROBE_LIMIT ?? 400);

export async function handler(event: SQSEvent): Promise<void> {
  // batchSize is 1, so this loop runs once. Written as a loop anyway so raising
  // batchSize later does not silently drop records.
  for (const record of event.Records) {
    await processRecord(record);
  }
}

async function processRecord(record: SQSRecord): Promise<WorkerSummary> {
  const msg = JSON.parse(record.body) as ScrapeMessage;
  const { url, slug, runId } = msg;

  const priorState = await getSourceState(slug);

  let result;
  try {
    result = await scrapeOneSource(url, priorState);
  } catch (err) {
    // scrapeOneSource attaches the updated state (failCount, circuit breaker)
    // to the error. Persist it so the breaker survives the invocation, then
    // rethrow to let SQS handle redelivery.
    const state = (err as { sourceState?: SourceState }).sourceState;
    if (state) {
      await putSourceState(slug, state).catch((e) =>
        console.error(JSON.stringify({ msg: 'failed to persist source state', slug, error: String(e) })),
      );
    }
    throw err;
  }

  await putSourceState(slug, result.state);

  if (result.skipped) {
    console.log(JSON.stringify({ slug, runId, skipped: true, reason: 'circuit-breaker-open' }));
    return { slug, runId, scraped: 0, written: 0, unchanged: 0, skipped: true };
  }

  const listings = await withLinkHealth(result.listings);

  let written = 0;
  let unchanged = 0;

  // Sequential rather than parallel: the source list is small, and this keeps
  // write throughput predictable against on-demand capacity.
  for (const listing of listings) {
    if (!listing.appUrl && !listing.id) continue;
    const res = await upsertListing(listing, runId);
    if (res.written) written++;
    else unchanged++;
  }

  const summary: WorkerSummary = {
    slug,
    runId,
    scraped: listings.length,
    written,
    unchanged,
    skipped: false,
  };
  console.log(JSON.stringify(summary));
  return summary;
}

/**
 * Populate Internship.linkHealth by HEAD-probing application URLs.
 *
 * urlValidator's 24h cache is per-invocation in Lambda and so does not help
 * across runs — this is one HEAD request per listing per run. Acceptable at the
 * current corpus size; bounded by LINK_PROBE_LIMIT so a source that suddenly
 * returns thousands of rows cannot blow the function timeout.
 *
 * Probe failure must never fail the scrape: a listing with unknown link health
 * is still worth storing.
 */
async function withLinkHealth(listings: Internship[]): Promise<Internship[]> {
  const probeable = listings.filter((l) => l.appUrl).slice(0, LINK_PROBE_LIMIT);
  if (probeable.length === 0) return listings;

  try {
    const results = await validateUrls(probeable.map((l) => l.appUrl));
    const healthByUrl = new Map(results.map((r) => [r.url, r.health]));
    return listings.map((l) =>
      l.appUrl && healthByUrl.has(l.appUrl)
        ? { ...l, linkHealth: healthByUrl.get(l.appUrl) }
        : l,
    );
  } catch (err) {
    console.error(JSON.stringify({ msg: 'link health probing failed', error: String(err) }));
    return listings;
  }
}
