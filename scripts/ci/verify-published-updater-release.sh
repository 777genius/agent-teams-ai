#!/usr/bin/env bash

set -euo pipefail

REPOSITORY="${RELEASE_REPOSITORY:-${GITHUB_REPOSITORY:-}}"
TAG="${RELEASE_TAG:-}"
RELEASE_ID="${RELEASE_ID:-}"
MAX_ATTEMPTS="${RELEASE_GUARD_MAX_ATTEMPTS:-6}"
RETRY_SECONDS="${RELEASE_GUARD_RETRY_SECONDS:-10}"
REDRAFT_ON_FAILURE="${REDRAFT_INCOMPLETE_RELEASE:-false}"

fail_usage() {
  echo "[release-updater-guard] $*" >&2
  exit 2
}

[[ "$REPOSITORY" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$ ]] || \
  fail_usage "RELEASE_REPOSITORY or GITHUB_REPOSITORY must be owner/repository"
[[ "$TAG" =~ ^v[0-9]+\.[0-9]+\.[0-9]+([-.][A-Za-z0-9.-]+)?$ ]] || \
  fail_usage "RELEASE_TAG must be a semantic version tag, got '${TAG:-<empty>}'"
if [[ ! "$MAX_ATTEMPTS" =~ ^[0-9]+$ ]] || ((MAX_ATTEMPTS < 1 || MAX_ATTEMPTS > 20)); then
  fail_usage "RELEASE_GUARD_MAX_ATTEMPTS must be between 1 and 20"
fi
if [[ ! "$RETRY_SECONDS" =~ ^[0-9]+$ ]] || ((RETRY_SECONDS > 60)); then
  fail_usage "RELEASE_GUARD_RETRY_SECONDS must be between 0 and 60"
fi
[[ "$REDRAFT_ON_FAILURE" == "true" || "$REDRAFT_ON_FAILURE" == "false" ]] || \
  fail_usage "REDRAFT_INCOMPLETE_RELEASE must be true or false"

if [[ -z "$RELEASE_ID" ]]; then
  RELEASE_ID="$(gh api "repos/${REPOSITORY}/releases/tags/${TAG}" --jq '.id')"
fi
[[ "$RELEASE_ID" =~ ^[0-9]+$ ]] || fail_usage "RELEASE_ID must be numeric"

VERSION="${TAG#v}"
REQUIRED_FEEDS=(latest.yml latest-linux.yml latest-mac.yml)
REQUIRED_ASSETS=(
  "Agent.Teams.AI.Setup.${VERSION}.exe"
  "Agent.Teams.AI-${VERSION}.AppImage"
  "Agent.Teams.AI-${VERSION}-arm64-mac.zip"
  "Agent.Teams.AI-${VERSION}-arm64.dmg"
  "Agent.Teams.AI-${VERSION}-x64-mac.zip"
  "Agent.Teams.AI-${VERSION}-x64.dmg"
  "${REQUIRED_FEEDS[@]}"
)
SKIP_MARKER_PATTERN='\[(skip-updater|test-release|internal-release|no-autoupdate)\]'
errors=()

add_error() {
  errors+=("$1")
}

metadata_version() {
  local file="$1"
  local value
  value="$(sed -n 's/^version:[[:space:]]*//p' "$file")"
  value="${value//$'\r'/}"
  value="${value//\'/}"
  value="${value//\"/}"
  printf '%s' "$value"
}

verify_feed_contents() {
  local directory="$1"
  local feed file actual_version
  local required_references=()

  for feed in "${REQUIRED_FEEDS[@]}"; do
    file="${directory}/${feed}"
    actual_version="$(metadata_version "$file")"
    if [[ "$actual_version" != "$VERSION" ]]; then
      add_error "${feed} declares version '${actual_version:-missing}', expected '${VERSION}'"
    fi

    case "$feed" in
      latest.yml)
        required_references=("Agent.Teams.AI.Setup.${VERSION}.exe")
        ;;
      latest-linux.yml)
        required_references=("Agent.Teams.AI-${VERSION}.AppImage")
        ;;
      latest-mac.yml)
        required_references=(
          "Agent.Teams.AI-${VERSION}-arm64-mac.zip"
          "Agent.Teams.AI-${VERSION}-arm64.dmg"
          "Agent.Teams.AI-${VERSION}-x64-mac.zip"
          "Agent.Teams.AI-${VERSION}-x64.dmg"
        )
        ;;
    esac

    for reference in "${required_references[@]}"; do
      grep -Fq "$reference" "$file" || \
        add_error "${feed} does not reference ${reference}"
    done
  done
}

verify_once() {
  errors=()

  local release_state asset_names latest_tag searchable_text
  local is_draft is_prerelease release_tag

  if ! release_state="$(gh api "repos/${REPOSITORY}/releases/${RELEASE_ID}" \
    --jq '[.draft, .prerelease, .tag_name] | @tsv')"; then
    add_error "could not read release ${RELEASE_ID}"
  else
    IFS=$'\t' read -r is_draft is_prerelease release_tag <<<"$release_state"
    [[ "$is_draft" == "false" ]] || add_error "${TAG} is still a draft"
    [[ "$is_prerelease" == "false" ]] || add_error "${TAG} is a prerelease"
    [[ "$release_tag" == "$TAG" ]] || \
      add_error "release id ${RELEASE_ID} belongs to ${release_tag}, expected ${TAG}"
  fi

  if searchable_text="$(gh api "repos/${REPOSITORY}/releases/${RELEASE_ID}" \
    --jq '[.tag_name, .name, .body] | map(select(type == "string")) | join("\n") | ascii_downcase')"; then
    if grep -Eiq "$SKIP_MARKER_PATTERN" <<<"$searchable_text"; then
      add_error "${TAG} contains an updater skip marker"
    fi
  else
    add_error "could not inspect ${TAG} title and notes"
  fi

  if asset_names="$(gh api "repos/${REPOSITORY}/releases/${RELEASE_ID}/assets" \
    --paginate --jq '.[].name')"; then
    for asset in "${REQUIRED_ASSETS[@]}"; do
      grep -Fxq "$asset" <<<"$asset_names" || add_error "missing release asset ${asset}"
    done
  else
    add_error "could not list assets for ${TAG}"
    asset_names=''
  fi

  if latest_tag="$(gh api "repos/${REPOSITORY}/releases/latest" --jq '.tag_name')"; then
    [[ "$latest_tag" == "$TAG" ]] || \
      add_error "GitHub latest release is ${latest_tag}, expected ${TAG}"
  else
    add_error "could not resolve GitHub's latest release"
  fi

  local feeds_available=true feed temporary_directory
  for feed in "${REQUIRED_FEEDS[@]}"; do
    if ! grep -Fxq "$feed" <<<"$asset_names"; then
      feeds_available=false
      break
    fi
  done

  if [[ "$feeds_available" == "true" ]]; then
    temporary_directory="$(mktemp -d)"
    for feed in "${REQUIRED_FEEDS[@]}"; do
      if ! gh release download "$TAG" \
        --repo "$REPOSITORY" \
        --pattern "$feed" \
        --dir "$temporary_directory" \
        --clobber >/dev/null; then
        add_error "could not download ${feed} from ${TAG}"
      fi
    done

    if [[ -f "${temporary_directory}/latest.yml" && \
      -f "${temporary_directory}/latest-linux.yml" && \
      -f "${temporary_directory}/latest-mac.yml" ]]; then
      verify_feed_contents "$temporary_directory"
    fi
    rm -rf "$temporary_directory"
  fi

  for feed in "${REQUIRED_FEEDS[@]}"; do
    if ! curl --fail --silent --show-error --location --head \
      "https://github.com/${REPOSITORY}/releases/latest/download/${feed}" >/dev/null; then
      add_error "latest download URL for ${feed} is unavailable"
    fi
  done

  ((${#errors[@]} == 0))
}

for ((attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1)); do
  if verify_once; then
    echo "[release-updater-guard] ${TAG} is public, latest, and updater-ready"
    exit 0
  fi

  echo "::warning title=Updater release verification ${attempt}/${MAX_ATTEMPTS}::${errors[*]}"
  if ((attempt < MAX_ATTEMPTS)); then
    sleep "$RETRY_SECONDS"
  fi
done

for error in "${errors[@]}"; do
  echo "::error title=Incomplete updater release::${error}"
done

if [[ "$REDRAFT_ON_FAILURE" == "true" ]]; then
  echo "[release-updater-guard] Returning incomplete release ${TAG} to draft" >&2
  gh api --method PATCH \
    "repos/${REPOSITORY}/releases/${RELEASE_ID}" \
    -F draft=true \
    -f make_latest=false >/dev/null
fi

echo "[release-updater-guard] ${TAG} is not safe for in-app updates" >&2
exit 1
