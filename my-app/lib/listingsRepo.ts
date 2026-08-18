import { QueryCommand, GetCommand, type QueryCommandOutput } from '@aws-sdk/lib-dynamodb';
import type { Internship } from './types';
import {
  getDocClient,
  TABLE_NAME,
  CredentialError,
  EmptyResultError,
  isCredentialError,
} from './ddbClient';

/**
 * DynamoDB read path for listings.
 *
 * Mirrors the key design in infra/lib/keys.ts. Those constants are duplicated
 * here rather than imported because my-app ships to Vercel and must not depend
 * on the infra package; the values are asserted against each other in
 * lib/__tests__/listingsRepo.test.ts so they cannot drift silently.
 */

const RECENCY_INDEX = 'GSI1v2';
const COMPANY_INDEX = 'GSI2';
const ACTIVE_SHARD_COUNT = 4;

/** Ceiling on pages fetched per shard, so a runaway result set cannot hang a render. */
const MAX_PAGES_PER_SHARD = 10;

export function allActiveShardKeys(): string[] {
  return Array.from({ length: ACTIVE_SHARD_COUNT }, (_, i) => `ACTIVE#${i}`);
}

/**
 * Fields ranker.ts requires. A row missing any of them is dropped rather than
 * passed on: ranker.ts is frozen, so it must receive exactly the shape it
 * already expects.
 */
function toInternship(item: Record<string, unknown>): Internship | null {
  const { company, role, location, appUrl, datePosted, dateMs, prestigeScore, source, id } = item;

  if (
    typeof company !== 'string' ||
    typeof role !== 'string' ||
    typeof appUrl !== 'string' ||
    typeof dateMs !== 'number'
  ) {
    return null;
  }

  return {
    id: typeof id === 'string' && id ? id : appUrl,
    company,
    companyUrl: typeof item.companyUrl === 'string' ? item.companyUrl : undefined,
    role,
    location: typeof location === 'string' ? location : '—',
    appUrl,
    datePosted: typeof datePosted === 'string' ? datePosted : '—',
    dateMs,
    prestigeScore: typeof prestigeScore === 'number' ? prestigeScore : 0,
    source: typeof source === 'string' ? source : '',
    linkHealth: item.linkHealth as Internship['linkHealth'],
    isExpired: typeof item.isExpired === 'boolean' ? item.isExpired : undefined,
    expirationReason: item.expirationReason as Internship['expirationReason'],
  };
}

function mapRows(items: Record<string, unknown>[]): Internship[] {
  const out: Internship[] = [];
  let dropped = 0;
  for (const item of items) {
    const mapped = toInternship(item);
    if (mapped) out.push(mapped);
    else dropped++;
  }
  if (dropped > 0) {
    console.warn(`listingsRepo: dropped ${dropped} malformed item(s) missing required fields`);
  }
  return out;
}

async function queryShard(shardKey: string, limit: number): Promise<Record<string, unknown>[]> {
  const doc = getDocClient();
  const rows: Record<string, unknown>[] = [];
  let cursor: Record<string, unknown> | undefined;
  let pages = 0;

  do {
    const res: QueryCommandOutput = await doc.send(
      new QueryCommand({
        TableName: TABLE_NAME,
        IndexName: RECENCY_INDEX,
        KeyConditionExpression: 'GSI1PK = :pk',
        ExpressionAttributeValues: { ':pk': shardKey },
        // Newest first: GSI1SK is a zero-padded dateMs.
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: cursor as never,
      }),
    );

    rows.push(...((res.Items ?? []) as Record<string, unknown>[]));
    cursor = res.LastEvaluatedKey;
    pages++;

    if (rows.length >= limit) break;

    if (cursor && pages >= MAX_PAGES_PER_SHARD) {
      console.warn(
        `listingsRepo: hit page ceiling (${MAX_PAGES_PER_SHARD}) on ${shardKey}; results truncated`,
      );
      break;
    }
  } while (cursor);

  return rows;
}

export interface QueryRecentOptions {
  /** Maximum listings to return. Each shard is queried for this many. */
  limit?: number;
  /**
   * When false, an empty result resolves to [] instead of throwing. Only the
   * metrics route wants this — an empty table there is a fact to report, not a
   * failure to surface.
   */
  throwOnEmpty?: boolean;
}

/**
 * Most recent active listings across all shards.
 *
 * Queries every shard in parallel and merges on GSI1SK descending. Each shard is
 * asked for the full page size because the top N may be unevenly distributed —
 * asking for limit/shardCount would silently drop newer listings whenever one
 * shard holds a disproportionate share.
 *
 * A single shard failing fails the whole read. Returning a partial set would
 * silently hide listings, which is worse than an error the caller can handle.
 */
export async function queryRecent(options: QueryRecentOptions = {}): Promise<Internship[]> {
  const { limit = 1000, throwOnEmpty = true } = options;

  if (!TABLE_NAME) {
    throw new CredentialError('DDB_TABLE_NAME is not set');
  }

  let perShard: Record<string, unknown>[][];
  try {
    perShard = await Promise.all(allActiveShardKeys().map((key) => queryShard(key, limit)));
  } catch (err) {
    if (isCredentialError(err)) {
      throw new CredentialError('DynamoDB rejected our credentials', { cause: err });
    }
    throw err;
  }

  const merged = mapRows(perShard.flat()).sort((a, b) => b.dateMs - a.dateMs);

  if (merged.length === 0 && throwOnEmpty) {
    // An empty table means the scrape broke. Throwing lets ISR serve the last
    // good render; rendering "no internships" would cache the outage.
    throw new EmptyResultError('No active listings found — the scrape may have failed');
  }

  return merged.slice(0, limit);
}

/** Resolve one listing by its surrogate id. Returns inactive listings too. */
export async function getListingById(listingId: string): Promise<Internship | null> {
  if (!listingId?.trim() || !TABLE_NAME) return null;

  try {
    const res = await getDocClient().send(
      new GetCommand({
        TableName: TABLE_NAME,
        Key: { PK: `LISTING#${listingId}`, SK: `LISTING#${listingId}` },
      }),
    );
    return res.Item ? toInternship(res.Item as Record<string, unknown>) : null;
  } catch (err) {
    if (isCredentialError(err)) {
      throw new CredentialError('DynamoDB rejected our credentials', { cause: err });
    }
    throw err;
  }
}

/** All listings for a normalized company name, via GSI2. Includes inactive. */
export async function queryByCompany(normalizedCompany: string): Promise<Internship[]> {
  if (!normalizedCompany?.trim() || !TABLE_NAME) return [];

  const res = await getDocClient().send(
    new QueryCommand({
      TableName: TABLE_NAME,
      IndexName: COMPANY_INDEX,
      KeyConditionExpression: 'GSI2PK = :pk',
      ExpressionAttributeValues: { ':pk': `COMPANY#${normalizedCompany}` },
      ScanIndexForward: false,
    }),
  );

  return mapRows((res.Items ?? []) as Record<string, unknown>[]);
}
