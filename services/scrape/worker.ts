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

/**
 * Cap on link-health probes per invocation.
 *
 * Deliberately low. Probes are HEAD requests through the shared rate limiter,
 * which allows 5 concurrent per host with a 100ms floor, and each carries
 * timeoutMs 5000 with 2 retries. A source whose links concentrate on a few ATS
 * hosts therefore serializes, and one blackholing host costs ~15s per probe.
 * Raise this only with a measured p99 duration in hand.
 */
const LINK_PROBE_LIMIT = Number(process.env.LINK_PROBE_LIMIT ?? 150);

/**
 * Parallel upserts per batch.
 *
 * Sequential writes do not survive a large source: at ~15ms per round trip,
 * 1,875 listings is ~28s, and an *unchanged* listing costs two round trips
 * (the conditional-check failure, then touchListing) — so a steady-state run is
 * slower than a cold one. Same bounded-batch shape as sweep.ts, which is tuned
 * for the same on-demand table.
 *
 * Env-tunable so setting it to 1 restores the old sequential behaviour without
 * a code deploy.
 */
const UPSERT_CONCURRENCY = Math.max(1, Number(process.env.UPSERT_CONCURRENCY ?? 10));

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

  // A listing with neither key is unusable; drop before batching so the
  // concurrency window is never padded with no-ops.
  const writable = listings.filter((l) => l.appUrl || l.id);

  // Bounded concurrency, same shape as sweep.ts. A single failed upsert must
  // not abandon the rest of the batch, but it MUST still fail the message so
  // SQS redelivers — otherwise a partial write would look like a success and
  // the sweep would later treat the unwritten listings as absent.
  for (let i = 0; i < writable.length; i += UPSERT_CONCURRENCY) {
    const batch = writable.slice(i, i + UPSERT_CONCURRENCY);
    const results = await Promise.allSettled(
      batch.map((listing) => upsertListing(listing, runId)),
    );

    const failed = results.find((r) => r.status === 'rejected');
    if (failed) {
      throw (failed as PromiseRejectedResult).reason;
    }

    for (const res of results) {
      if ((res as PromiseFulfilledResult<{ written: boolean }>).value.written) written++;
      else unchanged++;
    }
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
  // Probe the FRESHEST N, not the first N. The feed's own order is arbitrary,
  // so slicing it directly pinned coverage to the same arbitrary subset every
  // run while the rest kept linkHealth undefined forever. Sorting by dateMs
  // spends the budget where it matters — users act on recent listings, and
  // expirationDetector ages out the tail regardless. Needs no persisted state.
  const probeable = listings
    .filter((l) => l.appUrl)
    .sort((a, b) => b.dateMs - a.dateMs)
    .slice(0, LINK_PROBE_LIMIT);
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
