# Read path (Sprint 2)

How the Vercel frontend gets listings out of DynamoDB, and how to roll the
cutover back without a code change.

## Shape

```
Vercel function ──assume role via OIDC──> AWS STS
       │
       └─ lib/listingsSource.ts     (LISTINGS_SOURCE flag)
            ├─ ddb        -> lib/listingsRepo.ts -> DynamoDB GSI1v2
            └─ firestore  -> lib/firestore.ts    (deleted in 2b)
```

Everything funnels through `readActiveListings()`. Callers pass the result to
`rankInternships()` themselves, so ranking is identical on both backends —
`ranker.ts` is frozen and must receive the same shape either way.

## Environment variables

Set these on the Vercel project (Production):

| Variable | Value | Purpose |
|---|---|---|
| `DDB_TABLE_NAME` | `InternToolData-AppTable815C50BC-DR7EUEW9SOCY` | Which table to read |
| `AWS_REGION` | `us-west-2` | |
| `AWS_ROLE_ARN` | output of `InternToolVercelAccess` | Role assumed via OIDC |
| `LISTINGS_SOURCE` | `ddb` | `firestore` to roll back |
| `METRICS_SECRET` | any long random string | Guards `/api/metrics` |

**No AWS access key.** Vercel mints an OIDC token per invocation and trades it
for temporary credentials. Enable it under Project → Settings → Security →
Secure Backend Access (OIDC Federation) before the first deploy; without it the
SDK finds no credentials and the read path returns 503.

## Rolling back (2a)

Set `LISTINGS_SOURCE=firestore` in Vercel and redeploy. No code revert, no
rebuild of the scrape path. Firestore stays current because the Vercel cron is
still running until 2b removes it.

**Exercise this both directions before relying on it.** A rollback path first
tested during an incident is not a rollback path.

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

## Still to do (Sprint 2b)

Only after 2a has run a full day in production:

- delete `lib/firestore.ts`, `lib/listingsSource.ts`, and the `firestore` branch
- delete `app/api/scrape/refresh/route.ts`
- remove `crons` from `vercel.json`
- drop `LISTINGS_SOURCE` from Vercel
