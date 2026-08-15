# Deploy credentials

How CI deploys to AWS without any stored credential.

GitHub Actions mints a short-lived OIDC token, AWS trades it for temporary STS
credentials, and those expire within the hour. There is no IAM user, no access
key, and no AWS secret in the repository. The only AWS-related value stored on
GitHub is the role ARN, which is not sensitive.

## What exists

| Thing | Identifier | Where it is defined |
|---|---|---|
| OIDC provider | `token.actions.githubusercontent.com` | created by `infra/iam/setup.sh` |
| Deploy role | `github-actions-cdk-deploy` | created by `infra/iam/setup.sh` |
| Trust policy | pinned to `repo:SafwanHasan120/roots:ref:refs/heads/main` | `infra/iam/github-oidc-trust-policy.json` |
| Inline policy | `cdk-bootstrap-assume` | `infra/iam/github-oidc-deploy-policy.json` |
| Role ARN | repo variable `AWS_DEPLOY_ROLE_ARN` | GitHub → Settings → Secrets and variables → Actions → Variables |
| Workflow | `.github/workflows/deploy.yml` | push to `main` only |

Region is `us-west-2`. Max session duration is 3600s.

The committed policy files carry an `<ACCOUNT_ID>` placeholder. `setup.sh`
substitutes the real account id at runtime from `aws sts get-caller-identity`,
renders into a temp directory, and deletes it on exit — the account id is never
committed.

### What the role can actually do

Almost nothing on its own. Two permissions:

- `sts:AssumeRole` on `arn:aws:iam::<account>:role/cdk-hnb659fds-*-<account>-us-west-2`
- `ssm:GetParameter` on `/cdk-bootstrap/hnb659fds/version`

Real deploy permissions live in the CDK bootstrap roles (`deploy-role`,
`file-publishing-role`, `cfn-exec-role`), which this role assumes. That
indirection is the point: the blast radius of a compromised workflow is bounded
by what CDK bootstrap granted, not by `AdministratorAccess`. Anyone who "fixes"
a permissions error by attaching `AdministratorAccess` to this role has removed
the entire security property.

`setup.sh` warns if it finds managed policies attached, because that is the
most likely way this gets quietly undone.

## Setup

Run once, from the repo root, with admin credentials:

```bash
./infra/iam/setup.sh
```

Preview without changing anything:

```bash
DRY_RUN=1 ./infra/iam/setup.sh
```

The script is idempotent — re-running updates in place rather than failing, so
it is safe after a partial failure or a policy edit.

It aborts if `/cdk-bootstrap/hnb659fds/version` is missing, which means the
account is not bootstrapped in `us-west-2` (or used a custom qualifier). Fix
with `pnpm cdk bootstrap aws://<account>/us-west-2`, or pass
`CDK_QUALIFIER=<yours>` and update the ARNs in the deploy policy to match.

Then publish the role ARN:

```bash
gh variable set AWS_DEPLOY_ROLE_ARN --repo SafwanHasan120/roots \
  --body "arn:aws:iam::<account>:role/github-actions-cdk-deploy"
```

A **variable**, not a secret. Role ARNs are not credentials, and a variable is
readable in the UI, which makes debugging a mismatch far easier. Storing it as
a secret also masks it in logs, which actively hinders diagnosis.

## Verify

Push to `main` and open the workflow run.

The temporary `Verify assumed identity` step should print an **assumed-role**
ARN:

```
arn:aws:sts::<account>:assumed-role/github-actions-cdk-deploy/gha-cdk-deploy-<run-id>
```

That is the success condition. If you instead see an **IAM user** ARN
(`arn:aws:iam::<account>:user/...`), OIDC is not in play — a static credential
has leaked into the environment and needs to be found and removed.

**Delete the `Verify assumed identity` step once the run is green.** It exists
only to prove the mechanism works on first setup.

Confirm from the CLI too:

```bash
aws iam get-role --role-name github-actions-cdk-deploy \
  --query 'Role.{Arn:Arn,MaxSession:MaxSessionDuration,Trust:AssumeRolePolicyDocument}'

aws iam get-role-policy --role-name github-actions-cdk-deploy \
  --policy-name cdk-bootstrap-assume

# Should be empty. Anything here is a scoping regression.
aws iam list-attached-role-policies --role-name github-actions-cdk-deploy
```

## Failure mode: sub-claim mismatch

The common failure is:

```
Error: Not authorized to perform sts:AssumeRoleWithWebIdentity
```

This means the `sub` claim in the token did not exactly match the trust
policy's `StringEquals` condition.

**The fix is to compare the two strings, not to loosen the condition.**
Switching to `StringLike` with a wildcard is how a repo-scoped role becomes an
org-wide one — any repo in the org, including a fork someone opened a PR from,
could then assume it. Do not do this.

Print the actual claim by adding this step **before** the
`configure-aws-credentials` step:

```yaml
      # THROWAWAY — delete immediately after reading the output.
      - name: Print OIDC sub claim
        run: |
          TOKEN="$(curl -sS -H "Authorization: bearer $ACTIONS_ID_TOKEN_REQUEST_TOKEN" \
            "$ACTIONS_ID_TOKEN_REQUEST_URL&audience=sts.amazonaws.com" | jq -r '.value')"
          echo "$TOKEN" | cut -d. -f2 | base64 -d 2>/dev/null | jq '{sub, aud, repository, ref}'
```

This decodes only the payload, which carries no secret — but the request token
in the environment does, so delete the step as soon as you have the value.

Compare `sub` against the trust policy and update
`infra/iam/github-oidc-trust-policy.json` to match, then re-run `setup.sh`.

Expected for this repo:

```
repo:SafwanHasan120/roots:ref:refs/heads/main
```

Two things to check before assuming that string is right:

- **Numeric ids.** Repos created after mid-2026 may carry numeric owner and
  repository ids in `sub` instead of names. Confirm the actual value rather
  than assuming the name form — this is exactly why the decode step exists.
- **Trigger shape.** The `ref:refs/heads/main` form is specific to a branch
  push. A tag produces `ref:refs/tags/<tag>`, a PR produces
  `pull_request`, and an environment-gated job produces
  `environment:<name>`. This workflow only triggers on push to `main`, so
  anything else means the trigger changed.

Also worth confirming when the assume fails:

- `permissions: id-token: write` is present (without it there is no token at all)
- `vars.AWS_DEPLOY_ROLE_ARN` is set, and set as a *variable* rather than a secret
- the audience is `sts.amazonaws.com` on both the provider and the trust policy

## Rotate and revoke

There is no credential to rotate — tokens are minted per run and expire within
the hour. "Rotation" here means changing what the role can do or who can assume
it.

**Revoke immediately** (breaks deploys until re-run):

```bash
aws iam delete-role-policy --role-name github-actions-cdk-deploy \
  --policy-name cdk-bootstrap-assume
```

The role survives but can do nothing. Restore with `./infra/iam/setup.sh`.

**Revoke sessions already issued** — deleting the policy does not invalidate
credentials handed out in the last hour. To cut those off:

```bash
aws iam put-role-policy --role-name github-actions-cdk-deploy \
  --policy-name RevokeOldSessions \
  --policy-document '{"Version":"2012-10-17","Statement":[{"Effect":"Deny","Action":"*","Resource":"*","Condition":{"DateLessThan":{"aws:TokenIssueTime":"<ISO8601-timestamp-now>"}}}]}'
```

**Full teardown:**

```bash
aws iam delete-role-policy --role-name github-actions-cdk-deploy --policy-name cdk-bootstrap-assume
aws iam delete-role --role-name github-actions-cdk-deploy
# Only if nothing else uses it — other repos may share this provider:
aws iam delete-open-id-connect-provider \
  --open-id-connect-provider-arn arn:aws:iam::<account>:oidc-provider/token.actions.githubusercontent.com
gh variable delete AWS_DEPLOY_ROLE_ARN --repo SafwanHasan120/roots
```

## Extending to a second branch

Move the `sub` condition from a single string to an explicit list. Keep
`StringEquals` — a list of exact matches stays exact, whereas `StringLike` with
`*` opens it far wider than intended.

In `infra/iam/github-oidc-trust-policy.json`:

```json
"token.actions.githubusercontent.com:sub": [
  "repo:SafwanHasan120/roots:ref:refs/heads/main",
  "repo:SafwanHasan120/roots:ref:refs/heads/staging"
]
```

Then re-run `./infra/iam/setup.sh` and add the branch to the workflow trigger.
Note `setup.sh` validates the sub claim against a single expected string, so
extend that check alongside the policy.

For a separate environment with different permissions, prefer a second role
with its own scoped policy over widening this one — `staging` deploying with
production's permissions is the failure this design is meant to prevent.

For deploys gated on a GitHub Environment, the claim becomes
`repo:SafwanHasan120/roots:environment:production` and the job needs a matching
`environment:` key.

## Note on the OIDC provider thumbprint

`setup.sh` deliberately does not pass `--thumbprint-list`. IAM validates
`token.actions.githubusercontent.com` against the root CA, so a pinned leaf
thumbprint is unnecessary and goes stale when GitHub rotates certificates —
surfacing much later as an opaque auth failure.

Guides still recommending a hardcoded `6938fd4d98bab03faadb97b34396831e3780aea1`
predate that change. If the AWS CLI rejects creation for a missing thumbprint,
the CLI is too old; `setup.sh` says so and stops rather than pinning a hash that
will expire.
