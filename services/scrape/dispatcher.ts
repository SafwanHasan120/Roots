/**
 * Scrape dispatcher.
 *
 * Two modes, both on this one function:
 *
 *   scrape - enumerate enabled sources, put one SQS message per source.
 *   sweep  - after the workers have drained, deactivate listings that have
 *            fallen out of every source or aged out.
 *
 * The sweep lives here rather than in the worker because a worker sees only its
 * own source and cannot distinguish "absent from my source" from "absent
 * everywhere". Deactivating on a single worker's view would take down every
 * listing that source does not carry. The dispatcher is the only component with
 * a whole-corpus view.
 */

import { SQSClient, SendMessageBatchCommand } from '@aws-sdk/client-sqs';
import { loadSources, repoSlug } from '@app/scraper';
import { recordRun } from './ddb.js';
import { runSweep } from './sweep.js';

const sqs = new SQSClient({ maxAttempts: 3 });

export interface DispatcherEvent {
  mode?: 'scrape' | 'sweep';
  /** Overrides the generated run id. Test/replay affordance. */
  runId?: string;
}

export interface DispatcherResult {
  mode: 'scrape' | 'sweep';
  runId: string;
  enqueued?: number;
  swept?: { scanned: number; deactivated: number };
}

/** Run ids are timestamp-based so history sorts naturally and reads legibly in logs. */
export function makeRunId(now: number = Date.now()): string {
  return new Date(now).toISOString().replace(/[:.]/g, '-');
}

export async function handler(event: DispatcherEvent = {}): Promise<DispatcherResult> {
  const mode = event.mode ?? 'scrape';
  const runId = event.runId ?? makeRunId();

  if (mode === 'sweep') {
    const swept = await runSweep(runId);
    console.log(JSON.stringify({ mode, runId, ...swept }));
    return { mode, runId, swept };
  }

  const queueUrl = requireEnv('QUEUE_URL');
  const sources = loadSources();

  if (sources.length === 0) {
    // Never silent: an empty source list means sources.json is broken, and the
    // sweep would then deactivate the entire corpus.
    throw new Error('No enabled sources found; refusing to dispatch an empty run');
  }

  // Record the run BEFORE enqueueing. The sweep's grace window is measured in
  // run ids, so a run that enqueued work but was never recorded would let the
  // window slide by without the corresponding listings being marked seen.
  await recordRun(runId);

  const entries = sources.map((url, i) => ({
    Id: String(i),
    MessageBody: JSON.stringify({ url, slug: repoSlug(url), runId }),
  }));

  // Batch of 10 is the SQS limit; sources currently number 2, but chunking
  // keeps this correct if the list grows.
  let enqueued = 0;
  for (let i = 0; i < entries.length; i += 10) {
    const chunk = entries.slice(i, i + 10);
    const res = await sqs.send(
      new SendMessageBatchCommand({ QueueUrl: queueUrl, Entries: chunk }),
    );
    enqueued += res.Successful?.length ?? 0;
    if (res.Failed?.length) {
      // Partial batch failure is not retryable by SQS here — this is a send, not
      // a receive — so surface it and let the invocation fail.
      throw new Error(
        `Failed to enqueue ${res.Failed.length} source(s): ${JSON.stringify(res.Failed)}`,
      );
    }
  }

  console.log(JSON.stringify({ mode, runId, enqueued, sources: sources.length }));
  return { mode, runId, enqueued };
}

function requireEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}
