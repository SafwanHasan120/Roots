# Read path (Sprint 2)

How the Vercel frontend gets listings out of DynamoDB.

## Shape

```
Vercel function ──OIDC token ──> STS ──> role session
       │
       └─ lib/listingsRepo.ts ──> DynamoDB GSI1v2 (4 shards, merged)
```

Callers query `queryRecent()` and pass the result to `rankInternships()`
themselves — `ranker.ts` is frozen and must receive exactly the shape it
already expects.

**The Firestore path is gone** (Sprint 2b). `lib/firestore.ts`,
`lib/listingsSource.ts`, the `LISTINGS_SOURCE` flag, and
`/api/scrape/refresh` were deleted; the Vercel cron block went with them.
`lib/firestore-sync.ts` remains — it backs user resumes, favorites and tailor
results, which never moved to DynamoDB.

Rolling the read path back now means reverting the commit, not flipping an
environment variable.

## Credentials

The SDK's **default provider chain cannot see Vercel's OIDC token** — it checks
env vars, the shared config file, and IMDS, none of which exist there, and fails
with `Could not load credentials from any providers`. `resolveCredentials()` in
`lib/ddbClient.ts` uses `@vercel/functions/oidc` explicitly, keyed on
`VERCEL_OIDC_TOKEN` so local development still falls through to the AWS profile.

Every AWS client on the Vercel side must use it: the DynamoDB client, the SigV4
signer for the tailor function URL, and the S3 client that presigns artifacts.
A presigner with no credentials fails at *use* time with a 403, not at signing
time, which is a slow way to discover the mistake.

## Environment variables

Set these on the Vercel project (Production):

| Variable | Value | Purpose |
|---|---|---|
| `DDB_TABLE_NAME` | `InternToolData-AppTable815C50BC-DR7EUEW9SOCY` | Which table to read |
| `AWS_REGION` | `us-west-2` | |
| `AWS_ROLE_ARN` | output of `InternToolVercelAccess` | Role assumed via OIDC |
| `METRICS_SECRET` | any long random string | Guards `/api/metrics` |

**No AWS access key.** Vercel mints an OIDC token per invocation and trades it
for temporary credentials. Enable it under Project → Settings → Security →
Secure Backend Access (OIDC Federation) before the first deploy; without it the
SDK finds no credentials and the read path returns 503.

## Rolling back

Revert the commit and redeploy. There is no longer an environment-variable
lever: 2b deleted the Firestore branch, and the Vercel cron that kept Firestore
current went with it.

Listings are disposable — the scheduled scrape rebuilds the table daily — so the
real recovery for bad data is re-running the dispatcher, not restoring a backup.

## Failure modes, and why each behaves as it does

| Condition | Behaviour | Reason |
|---|---|---|
| Table empty | throws `EmptyResultError`; `/api/scrape` returns 503 + `no-store` | An empty table means the scrape broke. Rendering "no internships" would cache the outage; throwing lets ISR keep serving the last good page. |
| Credentials missing/rejected | `CredentialError`; 503 with a distinct message | Otherwise a missing IAM role reads like a code bug. |
| One shard query fails | whole read fails | A partial set silently hides listings — worse than an error. |
| Row missing required fields | dropped, logged | `ranker.ts` is frozen and must never receive a malformed object. |
| Result exceeds 1 MB page | paginates on `LastEvaluatedKey`, capped at 10 pages/shard | Never silently truncate; never loop forever. |
| Any error | `Cache-Control: no-store` | Without it a transient failure is cached at the edge for the full `s-maxage`. |

## Shard fan-out

`GSI1v2` is sharded four ways on a hash of the listing id. `queryRecent()`
queries all four in parallel and merges on `dateMs` descending.

Each shard is asked for the **full** limit, not `limit / 4`. The top N is not
evenly distributed across shards, so dividing would drop newer listings whenever
one shard holds a disproportionate share.

The shard count is duplicated in `lib/listingsRepo.ts` rather than imported from
`infra/lib/keys.ts` — `my-app` ships to Vercel and must not depend on the infra
package. `lib/__tests__/listingsRepo.test.ts` asserts the values agree, so they
cannot drift silently.

## Why the homepage is `force-dynamic`

It reads a database that has no meaning at build time. Prerendering would fail
the Vercel build outright (`DDB_TABLE_NAME is not set`). `revalidate = 3600`
still applies: the first request populates the ISR cache and later ones are
served from it for an hour. Only the timing of the first render moved.

## `/api/metrics` now requires a secret

It previously triggered a **full live scrape on every request, unauthenticated** —
an unmetered way for anyone to make the app hammer GitHub. It now reports on
what the scheduled scrape stored, behind `Authorization: Bearer $METRICS_SECRET`,
and fails closed if the secret is unset.

```bash
curl -H "Authorization: Bearer $METRICS_SECRET" https://<host>/api/metrics
```

`linkHealth` in that response is finally meaningful — nothing populated the
field before the scrape worker started probing URLs in Sprint 1.

## Sprint 2b: done

Deleted `lib/firestore.ts`, `lib/listingsSource.ts`,
`app/api/scrape/refresh/route.ts`, the `crons` block in `vercel.json`, and the
unused `firebase-admin` dependency. `LISTINGS_SOURCE` can be removed from the
Vercel environment; nothing reads it.
