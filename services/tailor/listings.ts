/**
 * Listing lookup for the tailor worker.
 *
 * Separate from my-app/lib/listingsRepo.ts on purpose: that module is built for
 * the Vercel runtime (its own client, its own timeouts, its own error types).
 * The worker reuses the scrape path's DynamoDB client instead, which is already
 * configured for Lambda.
 *
 * Accepts either the surrogate listing id or a raw appUrl, because the client
 * may hold either depending on where the row came from.
 */

import { createHash } from 'node:crypto';
import { GetCommand } from '@aws-sdk/lib-dynamodb';
import { doc, TABLE } from '../scrape/ddb.js';
import { listingKey } from '@infra/keys';
import type { Internship } from '@app/types';

/** Must match listingId() in infra/lib/keys.ts. */
function listingIdFor(appUrl: string): string {
  return createHash('sha256').update(appUrl).digest('hex').slice(0, 32);
}

async function fetchById(id: string): Promise<Internship | null> {
  const res = await doc.send(new GetCommand({ TableName: TABLE, Key: listingKey(id) }));
  if (!res.Item) return null;

  const item = res.Item;
  // Reject rows missing what the pipeline needs rather than failing later with
  // a confusing "cannot read property of undefined".
  if (typeof item.appUrl !== 'string' || typeof item.company !== 'string') return null;

  return {
    id: (item.id as string) ?? id,
    company: item.company as string,
    companyUrl: item.companyUrl as string | undefined,
    role: (item.role as string) ?? '—',
    location: (item.location as string) ?? '—',
    appUrl: item.appUrl as string,
    datePosted: (item.datePosted as string) ?? '—',
    dateMs: (item.dateMs as number) ?? 0,
    prestigeScore: (item.prestigeScore as number) ?? 0,
    source: (item.source as string) ?? '',
    linkHealth: item.linkHealth as Internship['linkHealth'],
    isExpired: item.isExpired as boolean | undefined,
    expirationReason: item.expirationReason as Internship['expirationReason'],
  };
}

/**
 * Resolve a listing the client asked to tailor against.
 *
 * Deactivated listings still resolve — they remain in the base table after the
 * sweep evicts them from the recency index, so tailoring keeps working for a
 * row the user still has open.
 */
export async function getListingById(internshipId: string): Promise<Internship | null> {
  if (!internshipId?.trim()) return null;

  const direct = await fetchById(internshipId);
  if (direct) return direct;

  if (internshipId.startsWith('http')) {
    return fetchById(listingIdFor(internshipId));
  }

  return null;
}
