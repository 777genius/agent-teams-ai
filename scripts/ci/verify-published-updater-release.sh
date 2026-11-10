#!/usr/bin/env bash
set -euo pipefail

REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
TAG="${RELEASE_TAG:-}"
RELEASE_ID="${RELEASE_ID:-}"
MAX_ATTEMPTS="${RELEASE_GUARD_MAX_ATTEMPTS:-6}"
RETRY_SECONDS="${RELEASE_GUARD_RETRY_SECONDS:-10}"
REDRAFT_ON_FAILURE="${REDRAFT_INCOMPLETE_RELEASE:-false}"
fail_usage() { echo "[release-updater-guard] $*" >&2; exit 2; }
[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || fail_usage 'Repository must be owner/repository'
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+$ ]] || fail_usage 'Stable semantic release tag required'
[[ "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] && ((MAX_ATTEMPTS >= 1 && MAX_ATTEMPTS <= 20)) || fail_usage 'Invalid retry count'
[[ "$RETRY_SECONDS" =~ ^[0-9]+$ ]] && ((RETRY_SECONDS <= 60)) || fail_usage 'Invalid retry delay'
[[ "$REDRAFT_ON_FAILURE" == true || "$REDRAFT_ON_FAILURE" == false ]] || fail_usage 'Invalid redraft flag'
if [[ -z "$RELEASE_ID" ]]; then RELEASE_ID="$(gh api "repos/${REPOSITORY}/releases/tags/${TAG}" --jq .id)"; fi
[[ "$RELEASE_ID" =~ ^[0-9]+$ ]] || fail_usage 'Numeric release ID required'

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  status=0
  pnpm exec tsx scripts/ci/verify-updater-release.ts --state published \
    --repository "$REPOSITORY" --release-tag "$TAG" --release-id "$RELEASE_ID" || status=$?
  if ((status == 0)); then
    echo "[release-updater-guard] ${TAG} is public, latest, and updater-ready"
    exit 0
  fi
  # Only transient transport failures retry. A conflicting release never gets repaired here.
  if ((status != 75 || attempt == MAX_ATTEMPTS)); then break; fi
  sleep "$RETRY_SECONDS"
done
if [[ "$REDRAFT_ON_FAILURE" == true ]]; then
  actual_tag="$(gh api "repos/${REPOSITORY}/releases/${RELEASE_ID}" --jq .tag_name)"
  [[ "$actual_tag" == "$TAG" ]] || fail_usage 'Refusing to redraft a different release ID'
  echo "[release-updater-guard] Returning incomplete release ${TAG} to draft" >&2
  gh api --method PATCH "repos/${REPOSITORY}/releases/${RELEASE_ID}" -F draft=true -f make_latest=false >/dev/null
fi
echo "[release-updater-guard] ${TAG} is not safe for in-app updates" >&2
exit 1
