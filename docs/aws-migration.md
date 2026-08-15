# AWS migration — data model and operating notes

Reference for the DynamoDB single-table design and the cost assumptions behind
it. This document is load-bearing: the shard count, the sweep grace period, and
the revisit thresholds live only here. Review it whenever the key design or the
schedules change.

Region is `us-west-2`. Infrastructure is CDK v2 under `infra/`.

## Cost constraint

**Not "always free."** DynamoDB's 25 WCU / 25 RCU allowance applies to
*provisioned* mode only. This table is on-demand, so reads and writes are billed
per request from the first one. The 25 GB storage allowance does apply to both
modes.

The real constraint is:

> No service carrying a standing hourly or monthly charge, and total spend under
> $1/month.

That still excludes RDS, Aurora, NAT Gateway, VPC-attached Lambdas, Elastic IPs,
AppSync, API Gateway, and Secrets Manager. It is enforced in CI by
`infra/lib/__tests__/constraints.test.ts`, which synthesizes every stack and
fails on any forbidden resource type. That suite deliberately **does not assert
on billing mode** — billing mode is a cost decision governed by the budget
alarm, not a structural constraint.

On-demand was kept over provisioned because at this volume the per-request cost
is fractions of a cent, and provisioned mode would trade that for capacity
management the project does not need. Provisioned at 25/25 would genuinely be
$0.00 and is a reasonable alternative if the bill ever matters more than the
operational simplicity; it is a one-line change in `data-stack.ts`.

### Expected steady-state cost is not zero

Two line items appear even when nothing is happening:

- **SQS idle polling.** A Lambda SQS event source mapping long-polls
  continuously. Two mapped queues issue `ReceiveMessage` around the clock
  whether or not work exists — a few million requests a month. This is cents,
  but it produces a persistent nonzero SQS line next to an apparently idle
  system, and it is the single most likely thing to send someone hunting for a
  bug that does not exist.
- **DynamoDB on-demand.** Billed per request from the first read.

Both are well inside $1/month. The budget alarm is the guard, not a $0.00
expectation.

## Table

One table, `InternToolData`, holding four item types.

| Item | PK | SK |
|---|---|---|
| Listing | `LISTING#<listingId>` | `LISTING#<listingId>` |
| Scrape state | `META#SCRAPE` | `SOURCE#<slug>` |
| Tailor job | `JOB#<jobId>` | `JOB#<jobId>` |
| Rate bucket | `RATE#<uid>` | `DAY#<yyyy-mm-dd>` |

Key construction lives in `infra/lib/keys.ts` and is imported by the services.
Nothing should build a key string by hand — a writer and a reader that disagree
by one character produce items nothing can find, and that failure is invisible
until a query returns empty.

`ttl` is enabled on the table. Jobs and rate buckets set it; listings never do,
so listings are never auto-deleted.

### Listing id is a surrogate

`listingId = sha256(appUrl)[0:32]`.

The application URL is the listing's real identity — it is already the dedup key
in `scraper.ts` and the doc-id basis in the Firestore code being replaced.
Deriving the key from it means the key never moves.

The alternative, partitioning on normalized company, had two defects.
`companyNormalizer.ts` is frozen, so any change to its output would orphan
existing items under a stale key with no way to rebalance; and large employers
skew partition sizes. Company now lives on `GSI2`, where a rename rewrites one
index entry and leaves the item and every reference to it in place.

## Indexes

### GSI1 — recency, sharded

```
GSI1PK = ACTIVE#<shard>     shard = parseInt(listingId[0:8], 16) % 4
GSI1SK = <zero-padded dateMs>#<listingId>
```

Serves the dominant query: most recent active listings across all companies. The
read path issues **one query per shard in parallel** and merges on `GSI1SK`
descending.

**Inactive listings carry no `GSI1PK` attribute at all.** A DynamoDB item
without the index's partition key is absent from that index, so deactivation is
an eviction rather than something every read has to filter. The sweep does this
by `REMOVE`ing `GSI1PK`.

`GSI1SK` is zero-padded to 15 digits because DynamoDB sorts string sort keys
bytewise — unpadded, `"9999"` sorts after `"10000"` and the recency ordering is
silently wrong.

#### Why not time buckets

An earlier design bucketed on `ACTIVE#<yyyy-mm>`. It is lossy in both
directions. Keyed on posting date, a listing posted in May and still open in
August falls outside a "current + previous month" read and vanishes from the
site. Keyed on the current month, every item needs a periodic rewrite that
nothing was scheduled to perform. A hash of the id is time-independent, so an
item's index position never depends on the calendar.

#### Shard count: 4

Chosen to bound per-query result size and keep the merge cheap — **not** to
escape a hot partition. A single DynamoDB partition sustains 3000 RCU / 1000
WCU, far beyond this workload.

**Revisit above roughly 50,000 active listings**, or if a single shard's query
exceeds the 1 MB response limit before filling a page. The corpus is currently
in the hundreds.

Raising the count is a **migration, not a config change**: it rewrites `GSI1PK`
on every existing item and needs a one-off backfill script. Changing the
constant alone would strand every existing item in a shard the reader no longer
queries.

### GSI2 — company

```
GSI2PK = COMPANY#<normalizedCompany>
GSI2SK = <zero-padded dateMs>#<listingId>
```

Per-company lookup. The UI issues no such query today; this exists for
key-design correctness and for the metrics route. Deactivated listings stay in
this index, so per-company history survives deactivation.

Both indexes use `INCLUDE` projections carrying the fields the homepage renders,
so a read needs no base-table fetch. Projected attributes are billed as a second
copy of the data, so the lists are deliberately narrow — notably the upsert
`hash` is excluded.

## Listing lifecycle

### Idempotent upsert

Each listing item stores a `hash` of its content. The worker writes with
`ConditionExpression: attribute_not_exists(PK) OR #hash <> :hash`, so an
unchanged listing produces a `ConditionalCheckFailedException` and no write.
That exception is the expected outcome on a no-change run and is counted as
success, not an error.

### Deactivation (the sweep)

Owned by the **dispatcher**, on a second scheduled invocation ~15 minutes after
the scrape, not by the worker. A worker sees only its own source and cannot
distinguish "absent from my source" from "absent everywhere" — a worker-owned
sweep would deactivate every listing not present in whichever source it happened
to process. The dispatcher is the only component with a whole-corpus view.

Mechanism:

1. Every successful worker write stamps `lastSeenAt` and `lastSeenRun`.
2. The sweep queries all 4 shards and deactivates an item when **either**:
   - `lastSeenRun` is absent from the last **3** run ids — i.e. missing from
     source for 3 consecutive runs. Runs are daily, so a vanished listing stays
     visible about 3 days. The grace tolerates one transient GitHub failure plus
     one circuit-breaker trip.
   - `isExpiredOrOld()` from the frozen `expirationDetector.ts` returns true.
     The sweep is that module's first live caller.
3. Deactivation sets `active = false`, sets `deactivatedAt`, and `REMOVE`s
   `GSI1PK`.
4. **Reactivation is automatic.** If a listing reappears in a later scrape, the
   normal upsert re-adds `GSI1PK`. The sweep writes no tombstone.

The +15 minute offset assumes the two-source queue drains well inside 15
minutes, which it does. If sources grow substantially this becomes a race, and
the trigger should move from a clock to queue-depth.

## Read path notes

- Query all 4 shard keys in parallel (`allActiveShardKeys()`), each for the full
  page size — the requested top-N may be unevenly distributed across shards.
- **One shard failing fails the whole read.** Returning a partial set silently
  drops listings, which is worse than an error.
- An empty result is treated as an error, not an empty page: the table being
  empty means the scrape broke, and serving a stale cached page beats rendering
  "no internships".
- Loop on `LastEvaluatedKey` up to a bounded page count so a result set over the
  1 MB response limit is never silently truncated.

## Rate limiting

`RATE#<uid> / DAY#<yyyy-mm-dd>` holds two counters:

- `reserved` — incremented at enqueue under a conditional write. Bounds
  in-flight work; stops a user queueing hundreds of jobs at once.
- `consumed` — the user-facing daily quota. Incremented **only** when a job
  completes with a validated result.

Failures and DLQ arrivals decrement `reserved` and leave `consumed` untouched,
so a user is never charged for work never delivered.

**Known leak:** a worker killed mid-flight (Lambda timeout, OOM) leaves
`reserved` elevated until the item's end-of-day TTL, leaving that user
under-quota for the rest of the day. This is the accepted cost of charging on
completion rather than at enqueue. It is observable — see the runbook — rather
than silent. A sweeper would fix it properly; that is more machinery than the
problem currently justifies.

## Stack layout

| Stack | Contents | Destroy safe? |
|---|---|---|
| `InternToolData` | the table | Table is `RETAIN`; stack destroy keeps data |
| `InternToolScrape` | scheduler, queues, dispatcher, worker | yes |
| `InternToolTailor` | function URL, queues, worker, S3 bucket | yes |
| `InternToolOps` | alarms, dashboard | yes — but see below |

The table is deliberately isolated so no compute-stack teardown can take the
data with it.

**The budget is not in CDK.** It is created by hand in the console. The ops
stack's rollback is `cdk destroy`, which would otherwise delete the cost
guardrail at exactly the moment something had gone wrong enough to warrant a
rollback. `constraints.test.ts` asserts no `AWS::Budgets::Budget` appears in any
template.
