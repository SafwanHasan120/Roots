# Tailor path (Sprint 3)

Async resume tailoring. Replaces a synchronous route that ran JD extraction plus
two Claude completions — up to 8192 tokens — inside a single HTTP request.

## Shape

```
browser
  │  POST /api/tailor  (Firebase ID token)
  ▼
Vercel route ──SigV4 (OIDC role)──> Lambda function URL  [authType: AWS_IAM]
                                          │  verify Firebase token -> uid
                                          │  reserve quota slot
                                          │  create job, enqueue
                                          ▼  202 {jobId}
                                        SQS ──> worker Lambda
                                                  │ resolve listing, SSRF guard
                                                  │ extract + analyze JD
                                                  │ Claude -> validate LaTeX
                                                  │ write artifact to S3
                                                  │ consume quota
                                                  ▼
browser  ──GET /api/tailor/status──> DynamoDB job + presigned S3 URL
```

## Two independent auth layers

Both are required, and they answer different questions:

| Layer | Question | Enforced by |
|---|---|---|
| `AWS_IAM` on the function URL | *Is this our Vercel deployment?* | Lambda, before any handler code runs |
| Firebase ID token | *Which user is asking?* | `services/tailor/auth.ts` |

The function URL is **not** public. `authType: NONE` plus a CORS allowlist was
the original design, but the browser never calls that URL — both endpoints are
Vercel route handlers. CORS is a browser convention, not a server-side control,
and does nothing against `curl`. IAM rejects unsigned requests outright.

**The uid now comes from the verified token, never the request body.** The
pre-migration route read `uid` from JSON the client supplied, so any caller could
spend another user's quota.

Token verification is implemented directly against Google's JWKS rather than
pulling in `firebase-admin`: the Lambda needs one RS256 signature check, not a
60MB SDK and a service account. It pins `alg: RS256` (rejecting `none` and HMAC
confusion), checks `iss`/`aud` against the project id, and honours the JWKS
`Cache-Control` max-age so key rotation does not start rejecting valid tokens.

## Quota: charged on completion

Each `RATE#<uid> / DAY#<yyyy-mm-dd>` item carries two counters:

| Counter | Meaning | Changed by |
|---|---|---|
| `reserved` | in-flight work | `+1` at enqueue, `-1` when the job settles |
| `consumed` | the user-facing daily count | `+1` **only** on a validated result |

The limit test counts `consumed + reserved`, so a user with 4 consumed and 1 in
flight is at the limit even though neither counter alone has reached it.

A failed job releases its reservation and leaves `consumed` untouched — the user
is never charged for a resume they did not receive.

**Known leak:** a worker killed mid-flight (Lambda timeout, OOM) never runs
either settlement path, so `reserved` stays elevated until the item's end-of-day
TTL and that user is under-quota for the rest of the day. This is the accepted
cost of charging on completion rather than at enqueue. Sprint 5 makes it
observable rather than silent.

## Idempotency

SQS guarantees at-least-once delivery, so every state transition is guarded:

- The worker skips a job already `DONE` or `FAILED` — a redelivered message must
  not re-run Claude or re-settle the quota.
- `markRunning` requires `status = QUEUED`, so a concurrent delivery that lost
  the race exits instead of racing.
- `consume` and `release` both require `reserved > 0`, so a double delivery
  cannot double-charge or drive the counter negative.

## Deliberate non-retry

The worker **does not rethrow** on failure. The job record already carries the
error and the quota is settled; letting SQS redeliver would repeat a
deterministic failure — a bad JD page fails identically three times, then
dead-letters and pages someone for nothing.

Genuinely transient failures (throttling, a dropped socket) still surface as
thrown errors from the AWS SDK layer before the handler's own try block.

## Status path

`/api/tailor/status` reads the job item and presigns the artifact **directly**.
A status Lambda would add a hop and a cold start to relocate two SDK calls the
Vercel function can already make.

Two things this route must get right:

- It **verifies the Firebase token itself** rather than trusting a uid from the
  query string, because it hands out access to a private artifact.
- It returns **404, not 403**, for another user's job — confirming that someone
  else's job exists is itself a leak.

Presigning requires the signer to hold `s3:GetObject`; the Vercel role is
granted it for `jobs/*` only.

## Environment

Vercel (Production), in addition to the Sprint 2 read-path vars:

| Variable | Value |
|---|---|
| `TAILOR_ENQUEUE_URL` | `EnqueueFunctionUrl` output |
| `TAILOR_ARTIFACT_BUCKET` | `ArtifactBucketName` output |

AWS, one-time — holds your Anthropic key, so it is created by hand and never
committed:

```bash
aws ssm put-parameter \
  --name /intern-tool/anthropic-api-key \
  --type SecureString \
  --value 'sk-ant-...' \
  --region us-west-2
```

## Artifacts expire after 30 days

An S3 lifecycle rule deletes them. Tailored resumes are regenerable output, and
keeping them indefinitely grows storage cost for no benefit. The UI states this
next to each result rather than letting a download silently 404.

## Open risk

**The 300s worker timeout is a guess.** The original synchronous call had no
timeout at all, so its real p99 is unknown. The Claude request itself is bounded
at 240s, leaving 60s to write the artifact and settle the quota. If real
completions exceed that, jobs will fail with the reservation correctly released —
but the ceiling should be measured rather than assumed.
