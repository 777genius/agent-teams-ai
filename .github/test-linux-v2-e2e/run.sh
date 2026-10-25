#!/usr/bin/env bash
# TEST-only: one pure OpenCode team run (lead + teammate) through the dev app, V1 or V2,
# on Linux x64 (under Xvfb) or macOS arm64 (the runner's GUI session).
# Usage: run.sh <opencode version> <provider/model>
# Needs: PLATFORM (linux-x64 or darwin-arm64), CANDIDATE_CLI (packaged runtime front door),
# KIMI_TEST_API_KEY in the environment.
set -uo pipefail
VERSION=${1:?version}
MODEL=${2:?model}
case "${PLATFORM:?}" in
  linux-x64 | darwin-arm64) ;;
  *) echo "unsupported platform $PLATFORM"; exit 2 ;;
esac
case "$VERSION" in
  # V1: the platform binary of npm opencode-ai (glibc on Linux), as the app installer selects it.
  # Its plain key connect takes no selector: V1 uses its first key option, as the app's form does.
  1.*) GEN=v1 PKG=opencode-$PLATFORM AUTH_OPTION= ;;
  # V2 admits a key connect only through its native option.
  2.*) GEN=v2 PKG=@opencode/cli-$PLATFORM AUTH_OPTION=api:native ;;
  *) echo "unsupported OpenCode version $VERSION"; exit 2 ;;
esac
sha256() { if command -v sha256sum >/dev/null; then sha256sum "$@"; else shasum -a 256 "$@"; fi; }
HERE=$(cd "$(dirname "$0")" && pwd)
APP=${GITHUB_WORKSPACE:?}
W="$RUNNER_TEMP/TEST-$GEN-$VERSION"
OUT="$RUNNER_TEMP/TEST-e2e-out/$VERSION"
mkdir -p "$W" "$OUT"

npm i --prefix "$W/oc" --ignore-scripts --no-audit --no-fund "$PKG@$VERSION" >"$OUT/npm.log" 2>&1
OC="$W/oc/node_modules/$PKG/bin/opencode"
echo "opencode $("$OC" --version 2>&1 | tail -1) sha256 $(sha256 "$OC" | cut -d' ' -f1)" | tee "$OUT/opencode.txt"

PROJECT="$W/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q
git -C "$PROJECT" config --local user.name iliya
git -C "$PROJECT" config --local user.email iliyazelenkog@gmail.com
printf '# TEST V2 %s\n' "$VERSION" >"$PROJECT/README.md"
git -C "$PROJECT" add README.md && git -C "$PROJECT" commit -q -m "TEST e2e fixture"

ISOLATED_HOME="$W/home"
DIAGNOSTIC_ROOTS=("$W")
if [ "$PLATFORM" = darwin-arm64 ]; then
  # macOS keeps the runner's home: the login keychain is found through HOME, and without a
  # default keychain Chromium can block on a modal prompt. The runtime keeps its data there.
  DIAGNOSTIC_ROOTS+=("$HOME/Library/Application Support/claude-multimodel-nodejs" "$HOME/Library/Logs/claude-multimodel-nodejs")
else
  export HOME="$ISOLATED_HOME"
fi
export XDG_CACHE_HOME="$ISOLATED_HOME/.cache" XDG_CONFIG_HOME="$ISOLATED_HOME/.config"
export XDG_DATA_HOME="$ISOLATED_HOME/.local/share" XDG_STATE_HOME="$ISOLATED_HOME/.local/state"
mkdir -p "$ISOLATED_HOME" "$W/userdata" "$W/claude-root/projects"
export CLAUDE_DEV_RUNTIME_DISABLE_GH=1
export CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH="${CANDIDATE_CLI:?}"
export CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH="$OC"
export AGENT_TEAMS_ELECTRON_USER_DATA_DIR="$W/userdata"
export AGENT_TEAMS_ELECTRON_CLAUDE_ROOT="$W/claude-root"

# The key stays in this shell only for the connect step; the app never receives it from the environment.
KEY="${KIMI_TEST_API_KEY:-}"
unset KIMI_TEST_API_KEY

# The app gets its own process group, so cleanup stops the whole dev tree.
if [ "$PLATFORM" = darwin-arm64 ]; then
  LAUNCH=(perl -MPOSIX -e 'POSIX::setsid() or die "setsid: $!"; exec @ARGV or die "exec: $!"' pnpm dev:mcp)
else
  LAUNCH=(setsid xvfb-run -a -s "-screen 0 1440x900x24" pnpm dev:mcp --noSandbox)
fi
(cd "$APP" && exec "${LAUNCH[@]}") >"$OUT/dev.log" 2>&1 &
DEV=$!
collect() {
  # Sanitized diagnostics only: fixed categories and phases, no credentials.
  find "${DIAGNOSTIC_ROOTS[@]}" -path '*diagnostics*' -name '*.json' -not -path '*/node_modules/*' -size -64k 2>/dev/null | while read -r f; do
    mkdir -p "$OUT/diagnostics"; cp "$f" "$OUT/diagnostics/$(echo "$f" | sha256 | cut -c1-12)-$(basename "$f")"
  done
  find "${DIAGNOSTIC_ROOTS[@]}" -path '*diagnostics*' -name '*.json' -not -path '*/node_modules/*' 2>/dev/null | sed "s|$W/||" > "$OUT/diagnostics-index.txt" || true
}
cleanup() { collect; kill -TERM -- "-$DEV" 2>/dev/null || kill -TERM "$DEV" 2>/dev/null; sleep 5; kill -KILL -- "-$DEV" 2>/dev/null || true; }
trap cleanup EXIT

node "$HERE/cdp.mjs" wait 9222 || { echo "app did not become ready"; tail -60 "$OUT/dev.log"; exit 1; }
node "$HERE/cdp.mjs" eval 'window.electronAPI.openCodeRuntime.getStatus()' >"$OUT/status.json" 2>&1; cat "$OUT/status.json"

KIMI_TEST_API_KEY="$KEY" KIMI_PROVIDER_ID="${MODEL%%/*}" KIMI_AUTH_OPTION_ID="$AUTH_OPTION" \
  node "$HERE/cdp.mjs" connect "$PROJECT" >"$OUT/connect.json" 2>&1
CONNECT=$?
cat "$OUT/connect.json"
unset KEY
if [ "$CONNECT" -ne 0 ]; then echo "provider connect failed"; collect; cat "$OUT"/diagnostics/*.json 2>/dev/null; exit 1; fi

TEAM="$GEN-${PLATFORM%%-*}-${VERSION//./}"
node "$HERE/e2e.mjs" "$TEAM" "$PROJECT" "$MODEL" "$W/claude-root" "$OUT" 9222
RESULT=$?
echo "e2e exit=$RESULT (connect exit=$CONNECT)"
git -C "$PROJECT" status --short >"$OUT/project-status.txt" 2>&1 || true
exit "$RESULT"
