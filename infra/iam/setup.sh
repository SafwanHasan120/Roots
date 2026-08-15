#!/usr/bin/env bash
#
# Create (or update) the GitHub Actions OIDC provider and deploy role.
#
# Idempotent: safe to re-run. Existing resources are updated in place rather
# than recreated, and re-running after a partial failure picks up where it
# stopped.
#
# Creates no IAM user and no access key. The account id is derived at runtime
# from the caller's identity and is never read from a committed file.
#
# Usage:
#   ./infra/iam/setup.sh                 # apply
#   DRY_RUN=1 ./infra/iam/setup.sh       # print what would change, touch nothing

set -euo pipefail

REGION="us-west-2"
REPO="SafwanHasan120/roots"
BRANCH="main"
ROLE_NAME="${ROLE_NAME:-github-actions-cdk-deploy}"
POLICY_NAME="cdk-bootstrap-assume"
QUALIFIER="${CDK_QUALIFIER:-hnb659fds}"
PROVIDER_HOST="token.actions.githubusercontent.com"
PROVIDER_URL="https://${PROVIDER_HOST}"
AUDIENCE="sts.amazonaws.com"
MAX_SESSION_DURATION=3600

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TRUST_TEMPLATE="${SCRIPT_DIR}/github-oidc-trust-policy.json"
DEPLOY_TEMPLATE="${SCRIPT_DIR}/github-oidc-deploy-policy.json"

DRY_RUN="${DRY_RUN:-}"

# Rendered policies land here; cleaned up on any exit path so account-id-bearing
# JSON never lingers on disk.
WORKDIR="$(mktemp -d)"
trap 'rm -rf "${WORKDIR}"' EXIT

info()  { printf '\033[0;34m==>\033[0m %s\n' "$*"; }
ok()    { printf '\033[0;32m  ok\033[0m %s\n' "$*"; }
warn()  { printf '\033[0;33m  !!\033[0m %s\n' "$*" >&2; }
die()   { printf '\033[0;31mERROR:\033[0m %s\n' "$*" >&2; exit 1; }

run() {
  if [[ -n "${DRY_RUN}" ]]; then
    printf '\033[0;33m  would run:\033[0m %s\n' "$*"
    return 0
  fi
  "$@"
}

# --- preflight ---------------------------------------------------------------

command -v aws >/dev/null 2>&1 || die "aws CLI not found on PATH."
command -v jq  >/dev/null 2>&1 || die "jq not found on PATH. Install it (brew install jq)."

for f in "${TRUST_TEMPLATE}" "${DEPLOY_TEMPLATE}"; do
  [[ -f "${f}" ]] || die "Missing policy template: ${f}"
done

info "Resolving caller identity"
CALLER_JSON="$(aws sts get-caller-identity --output json 2>/dev/null)" \
  || die "Could not call sts:GetCallerIdentity. Configure credentials first (aws configure / SSO login)."

ACCOUNT_ID="$(jq -r '.Account' <<<"${CALLER_JSON}")"
CALLER_ARN="$(jq -r '.Arn' <<<"${CALLER_JSON}")"
[[ "${ACCOUNT_ID}" =~ ^[0-9]{12}$ ]] || die "Unexpected account id from STS: '${ACCOUNT_ID}'"
ok "account ${ACCOUNT_ID}, caller ${CALLER_ARN}"

# --- verify the CDK bootstrap qualifier before granting anything -------------
#
# The deploy policy hardcodes the qualifier into both the role ARN pattern and
# the SSM parameter path. If the account was bootstrapped with a custom
# qualifier, a policy naming hnb659fds grants access to roles that do not exist
# and cdk deploy fails later with a confusing permissions error. Catch it here.

BOOTSTRAP_PARAM="/cdk-bootstrap/${QUALIFIER}/version"
info "Verifying CDK bootstrap qualifier '${QUALIFIER}' in ${REGION}"

if BOOTSTRAP_VERSION="$(aws ssm get-parameter \
      --name "${BOOTSTRAP_PARAM}" \
      --region "${REGION}" \
      --query 'Parameter.Value' \
      --output text 2>/dev/null)"; then
  ok "bootstrap stack present, version ${BOOTSTRAP_VERSION}"
else
  cat >&2 <<EOF

ERROR: SSM parameter ${BOOTSTRAP_PARAM} not found in ${REGION}.

The account does not appear to be CDK-bootstrapped in this region with the
qualifier '${QUALIFIER}'. The deploy policy would grant access to roles that
do not exist.

Fix one of these, then re-run:

  1. Bootstrap the account (most likely):
       pnpm cdk bootstrap aws://${ACCOUNT_ID}/${REGION}

  2. If you bootstrapped with a custom qualifier, pass it through:
       CDK_QUALIFIER=<your-qualifier> ./infra/iam/setup.sh
     and update the two <ACCOUNT_ID>-bearing resource ARNs in
     infra/iam/github-oidc-deploy-policy.json to match.

EOF
  exit 1
fi

# --- render policies ---------------------------------------------------------

TRUST_RENDERED="${WORKDIR}/trust.json"
DEPLOY_RENDERED="${WORKDIR}/deploy.json"
sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" "${TRUST_TEMPLATE}"  > "${TRUST_RENDERED}"
sed "s/<ACCOUNT_ID>/${ACCOUNT_ID}/g" "${DEPLOY_TEMPLATE}" > "${DEPLOY_RENDERED}"

jq empty "${TRUST_RENDERED}"  2>/dev/null || die "Rendered trust policy is not valid JSON."
jq empty "${DEPLOY_RENDERED}" 2>/dev/null || die "Rendered deploy policy is not valid JSON."

grep -q '<ACCOUNT_ID>' "${TRUST_RENDERED}" "${DEPLOY_RENDERED}" \
  && die "Placeholder substitution failed; <ACCOUNT_ID> still present."

EXPECTED_SUB="repo:${REPO}:ref:refs/heads/${BRANCH}"
ACTUAL_SUB="$(jq -r '.Statement[0].Condition.StringEquals["token.actions.githubusercontent.com:sub"]' "${TRUST_RENDERED}")"
[[ "${ACTUAL_SUB}" == "${EXPECTED_SUB}" ]] \
  || die "Trust policy sub claim is '${ACTUAL_SUB}', expected '${EXPECTED_SUB}'."

# Guard against a wildcard creeping into the repo/org segment.
case "${ACTUAL_SUB}" in
  *'*'*) die "Trust policy sub claim contains a wildcard. Refusing to continue." ;;
esac
ok "trust policy pinned to ${EXPECTED_SUB}"

PROVIDER_ARN="arn:aws:iam::${ACCOUNT_ID}:oidc-provider/${PROVIDER_HOST}"

# --- OIDC provider -----------------------------------------------------------
#
# No --thumbprint-list. IAM validates token.actions.githubusercontent.com
# against the root CA; pinning a leaf thumbprint is stale advice that breaks on
# certificate rotation. If the installed CLI still demands one, that CLI is too
# old — say so rather than silently pinning a hash that will expire.

info "OIDC provider ${PROVIDER_HOST}"
if aws iam get-open-id-connect-provider --open-id-connect-provider-arn "${PROVIDER_ARN}" >/dev/null 2>&1; then
  ok "already exists, leaving as is"

  EXISTING_AUDS="$(aws iam get-open-id-connect-provider \
    --open-id-connect-provider-arn "${PROVIDER_ARN}" \
    --query 'ClientIDList' --output json)"
  if ! jq -e --arg a "${AUDIENCE}" 'index($a)' <<<"${EXISTING_AUDS}" >/dev/null; then
    warn "provider is missing audience '${AUDIENCE}'; adding it"
    run aws iam add-client-id-to-open-id-connect-provider \
      --open-id-connect-provider-arn "${PROVIDER_ARN}" \
      --client-id "${AUDIENCE}"
  fi
else
  info "creating provider"
  CREATE_ERR="${WORKDIR}/oidc-create.err"
  if run aws iam create-open-id-connect-provider \
        --url "${PROVIDER_URL}" \
        --client-id-list "${AUDIENCE}" \
        2>"${CREATE_ERR}"; then
    ok "created"
  else
    if grep -qiE 'thumbprint' "${CREATE_ERR}"; then
      cat >&2 <<EOF

ERROR: This aws CLI requires --thumbprint-list, which means it predates IAM's
root-CA validation for GitHub's OIDC endpoint.

Do NOT work around this with a hardcoded thumbprint — pinned leaf thumbprints
go stale when GitHub rotates certificates and the failure surfaces much later
as an opaque auth error.

Upgrade the CLI, then re-run this script:
    brew upgrade awscli        # or: https://docs.aws.amazon.com/cli/latest/userguide/getting-started-install.html

Installed version:
    $(aws --version 2>&1)

EOF
      exit 1
    fi
    cat >&2 "${CREATE_ERR}"
    die "Failed to create the OIDC provider (see error above)."
  fi
fi

# --- role --------------------------------------------------------------------

info "IAM role ${ROLE_NAME}"
if aws iam get-role --role-name "${ROLE_NAME}" >/dev/null 2>&1; then
  ok "exists, updating trust policy and session duration"
  run aws iam update-assume-role-policy \
    --role-name "${ROLE_NAME}" \
    --policy-document "file://${TRUST_RENDERED}"
  run aws iam update-role \
    --role-name "${ROLE_NAME}" \
    --max-session-duration "${MAX_SESSION_DURATION}"
else
  info "creating role"
  run aws iam create-role \
    --role-name "${ROLE_NAME}" \
    --assume-role-policy-document "file://${TRUST_RENDERED}" \
    --max-session-duration "${MAX_SESSION_DURATION}" \
    --description "GitHub Actions OIDC deploy role for ${REPO} (${BRANCH}). Managed by infra/iam/setup.sh." \
    >/dev/null
  ok "created"
fi

# put-role-policy is upsert semantics, so this is idempotent as written.
info "Inline policy ${POLICY_NAME}"
run aws iam put-role-policy \
  --role-name "${ROLE_NAME}" \
  --policy-name "${POLICY_NAME}" \
  --policy-document "file://${DEPLOY_RENDERED}"
ok "applied"

# Nothing should have attached a managed policy, but a stray
# AdministratorAccess here would silently defeat the entire scoping effort.
ATTACHED="$(aws iam list-attached-role-policies --role-name "${ROLE_NAME}" \
  --query 'AttachedPolicies[].PolicyArn' --output text 2>/dev/null || true)"
if [[ -n "${ATTACHED}" && "${ATTACHED}" != "None" ]]; then
  warn "role has attached managed policies, which this setup does not expect:"
  warn "  ${ATTACHED}"
  warn "Review and detach unless deliberate."
fi

ROLE_ARN="arn:aws:iam::${ACCOUNT_ID}:role/${ROLE_NAME}"

cat <<EOF

$([[ -n "${DRY_RUN}" ]] && echo "DRY RUN — nothing was changed." || echo "Done.")

  Role ARN: ${ROLE_ARN}

Next, set the repo variable GitHub Actions reads (not a secret — a role ARN is
not sensitive, and keeping it a variable makes it visible in the UI):

  gh variable set AWS_DEPLOY_ROLE_ARN --repo ${REPO} --body "${ROLE_ARN}"

Then push to ${BRANCH} and watch the deploy workflow.
See docs/deploy-credentials.md for verification and troubleshooting.

EOF
