# Runbook

What to do when something alarms. Region is `us-west-2`, account `856121136047`,
profile `roots`.

## Quick health check

```bash
curl -H "Authorization: Bearer $METRICS_SECRET" https://<host>/api/metrics | jq '.ops, .alerts'
```

Returns dead-letter depths, when the scrape last ran, and whether that is stale.

## Alarms and what they mean

| Alarm | Means | First thing to check |
|---|---|---|
| `ScrapeDlqAlarm` | A source failed 3 delivery attempts | Worker logs — usually GitHub 5xx or a parse change |
| `TailorDlqAlarm` | A tailor job failed 3 attempts | Worker logs; the job record has `errorCode` |
| `DispatcherErrorAlarm` | The scrape dispatcher threw | Dispatcher logs. **Nothing else will fire** — see below |
| `ScrapeWorkerErrorAlarm` | Unhandled worker error (OOM, timeout) | Duration and memory in the log tail |
| `TailorWorkerErrorAlarm` | Same, tailor side | Whether a Claude call ran long |
| `TailorEnqueueErrorAlarm` | Enqueue failing (threshold 3) | Rejected auth is a 401, not an error — this means something else |
| `ScrapeFreshnessAlarm` | No scrape in 26h | Whether the EventBridge schedule is enabled |
| `LambdaThrottleAlarm` | A function was throttled | Account concurrency limit is **10**, not 1000 |

### Why the dispatcher alarm exists separately

The dispatcher enqueues nothing when it fails. No message means no DLQ, no
worker invocation, no worker error — every other alarm stays green while the
scrape silently stops. Before this alarm existed the only signal was the
26-hour freshness alarm, which tells you data is stale but not which component
broke.

## Common situations

### Scrape DLQ has messages

```bash
aws logs tail /aws/lambda/InternToolScrape-Worker11F36D0F-eCZu9e6Woxpu \
  --since 2h --profile roots --region us-west-2 | grep -i error
```

Redrive after fixing the cause:

```bash
aws sqs start-message-move-task \
  --source-arn <dlq-arn> --destination-arn <queue-arn> \
  --profile roots --region us-west-2
```

If the messages are stale (source has changed since), purge instead — the next
scheduled run re-scrapes everything anyway.

### Scrape is stale but nothing errored

The schedule itself stopped firing. Check it exists and is enabled:

```bash
aws scheduler list-schedules --profile roots --region us-west-2 \
  --query 'Schedules[].{Name:Name,State:State}'
```

Then run one by hand:

```bash
aws lambda invoke --function-name InternToolScrape-DispatcherD4A12972-1ec0I3rL80ed \
  --cli-binary-format raw-in-base64-out --payload '{"mode":"scrape"}' \
  --profile roots --region us-west-2 /dev/stdout
```

### The sweep deactivated far more than expected

It won't — `runSweep` aborts if more than 50% of a ≥10-row corpus would be
deactivated for *absence*, and the log says so. That guard exists because this
happened once: `lastSeenRun` was missing from the GSI1 projection, every row
read as never-seen, and one sweep took down all 419 listings.

**Most likely cause now: one large source failed.** `SimplifyJobs` carries ~1,886
of ~2,232 unique listings (~85%). If it alone fails for `SWEEP_GRACE_RUNS` (3)
consecutive runs, its listings look absent and *by themselves* exceed the 50%
limit, so the sweep aborts wholesale. That is correct behaviour — it fails loud
instead of wiping the corpus — but note the side effect: genuinely expired
listings from the other sources also stop being swept, so the corpus goes stale
rather than wrong.

Check per-source worker logs before anything else:

```bash
aws logs filter-log-events --profile roots --region us-west-2 \
  --log-group-name /aws/lambda/<worker-fn> --since 3d \
  --filter-pattern '{ $.slug = "SimplifyJobs/Summer2027-Internships" }'
```

**Do not weaken the 50% limit to make the abort go away.** Fix the source.

If the source is healthy, check that `lastSeenRun` is still projected:

```bash
aws dynamodb describe-table --table-name InternToolData-AppTable815C50BC-DR7EUEW9SOCY \
  --profile roots --region us-west-2 \
  --query 'Table.GlobalSecondaryIndexes[?IndexName==`GSI1v2`].Projection.NonKeyAttributes'
```

Recovery is a re-scrape: the normal upsert restores `GSI1PK` on every listing it
sees, so nothing is permanently lost.

### Leaked tailor reservations

A worker killed mid-flight (timeout, OOM) never runs either settlement path, so
`reserved` stays elevated and that user is under-quota until the item's
end-of-day TTL.

Find them:

```bash
aws dynamodb scan --table-name InternToolData-AppTable815C50BC-DR7EUEW9SOCY \
  --filter-expression 'begins_with(PK, :p) AND reserved > :z' \
  --expression-attribute-values '{":p":{"S":"RATE#"},":z":{"N":"0"}}' \
  --profile roots --region us-west-2 \
  --query 'Items[].{uid:PK.S,reserved:reserved.N,consumed:consumed.N}'
```

A nonzero `reserved` with no matching RUNNING job is a leak. Clear one by hand:

```bash
aws dynamodb update-item --table-name <table> \
  --key '{"PK":{"S":"RATE#<uid>"},"SK":{"S":"DAY#<yyyy-mm-dd>"}}' \
  --update-expression 'SET reserved = :z, claimed = consumed' \
  --expression-attribute-values '{":z":{"N":"0"}}' \
  --profile roots --region us-west-2
```

They also clear themselves at midnight UTC. This is the accepted cost of
charging quota on completion rather than at enqueue; the alternative charges
users for resumes they never received.

### A user reports "we couldn't read the job description"

Working as intended. Client-rendered boards (Workday and similar) serve their
description via JavaScript, so there is nothing in the HTML to extract. The job
settles as `NEEDS_JD`, **no quota is consumed**, and the UI offers a paste box.
Roughly 2 in 8 sampled listings behave this way.

Only investigate if it happens on a page whose description *is* in the HTML.

## Cost

Expected steady state is **not $0.00**. Two line items appear even when nothing
is happening:

- **SQS idle polling.** Lambda event source mappings long-poll continuously, so
  two mapped queues issue `ReceiveMessage` around the clock — a few million
  requests a month. Cents, but a persistent nonzero SQS line next to an
  apparently idle system, and the single most likely thing to send someone
  hunting a bug that does not exist.
- **DynamoDB on-demand.** Billed per request from the first read. The 25 WCU/RCU
  free allowance is provisioned-mode only.

CloudWatch alarms are billed per alarm-month; at eight alarms this stays well
inside budget. Dashboards are free up to three.

```bash
aws ce get-cost-and-usage --time-period Start=$(date -u -v-7d +%F),End=$(date -u +%F) \
  --granularity DAILY --metrics UnblendedCost \
  --group-by Type=DIMENSION,Key=SERVICE --profile roots
```

**The $1 budget is not in CDK.** It was created by hand in the console
deliberately: this stack's rollback is `cdk destroy`, which would otherwise
delete the cost guardrail at exactly the moment something had gone wrong enough
to warrant a rollback. `constraints.test.ts` fails if a budget ever appears in a
template.

## Rollbacks

| Stack | Safe to destroy? |
|---|---|
| `InternToolOps` | Yes — observation only |
| `InternToolTailor` | Yes; the artifact bucket is `RETAIN` |
| `InternToolScrape` | Yes; the table is in another stack |
| `InternToolVercelAccess` | Breaks the site's reads until redeployed |
| `InternToolData` | Table is `RETAIN`, so data survives the stack |

Read path only: flip `LISTINGS_SOURCE=firestore` in Vercel and redeploy. That
lever disappears once Sprint 2b lands.
