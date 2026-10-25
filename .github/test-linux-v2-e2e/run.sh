#!/usr/bin/env bash
# TEST-only: one pure OpenCode V2 team run (lead + teammate) through the dev app on Linux.
# Usage: run.sh <opencode version> <model>
# Needs: CANDIDATE_CLI (packaged runtime front door), KIMI_TEST_API_KEY in the environment.
set -uo pipefail
VERSION=${1:?version}
MODEL=${2:?model}
HERE=$(cd "$(dirname "$0")" && pwd)
APP=${GITHUB_WORKSPACE:?}
W="$RUNNER_TEMP/TEST-v2-$VERSION"
OUT="$RUNNER_TEMP/TEST-v2-out/$VERSION"
mkdir -p "$W" "$OUT"

npm i --prefix "$W/oc" --ignore-scripts --no-audit --no-fund "@opencode/cli-linux-x64@$VERSION" >"$OUT/npm.log" 2>&1
OC="$W/oc/node_modules/@opencode/cli-linux-x64/bin/opencode"
echo "opencode $("$OC" --version 2>&1 | tail -1) sha256 $(sha256sum "$OC" | cut -d' ' -f1)" | tee "$OUT/opencode.txt"

PROJECT="$W/project"
mkdir -p "$PROJECT"
git -C "$PROJECT" init -q
git -C "$PROJECT" config --local user.name iliya
git -C "$PROJECT" config --local user.email iliyazelenkog@gmail.com
printf '# TEST V2 %s\n' "$VERSION" >"$PROJECT/README.md"
git -C "$PROJECT" add README.md && git -C "$PROJECT" commit -q -m "TEST e2e fixture"

export HOME="$W/home"
export XDG_CACHE_HOME="$HOME/.cache" XDG_CONFIG_HOME="$HOME/.config"
export XDG_DATA_HOME="$HOME/.local/share" XDG_STATE_HOME="$HOME/.local/state"
mkdir -p "$HOME" "$W/userdata" "$W/claude-root/projects"
export CLAUDE_DEV_RUNTIME_DISABLE_GH=1
export CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH="${CANDIDATE_CLI:?}"
export CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH="$OC"
export AGENT_TEAMS_ELECTRON_USER_DATA_DIR="$W/userdata"
export AGENT_TEAMS_ELECTRON_CLAUDE_ROOT="$W/claude-root"

# The key stays in this shell only for the connect step; the app never receives it from the environment.
KEY="${KIMI_TEST_API_KEY:-}"
unset KIMI_TEST_API_KEY

(cd "$APP" && exec setsid xvfb-run -a -s "-screen 0 1440x900x24" pnpm dev:mcp --noSandbox) >"$OUT/dev.log" 2>&1 &
DEV=$!
cleanup() { kill -TERM -- "-$DEV" 2>/dev/null || kill -TERM "$DEV" 2>/dev/null; sleep 5; kill -KILL -- "-$DEV" 2>/dev/null || true; }
trap cleanup EXIT

node "$HERE/cdp.mjs" wait 9222 || { echo "app did not become ready"; tail -60 "$OUT/dev.log"; exit 1; }
node "$HERE/cdp.mjs" eval 'window.electronAPI.openCodeRuntime.getStatus()' >"$OUT/status.json" 2>&1; cat "$OUT/status.json"

KIMI_TEST_API_KEY="$KEY" node "$HERE/cdp.mjs" connect "$PROJECT" >"$OUT/connect.json" 2>&1
CONNECT=$?
cat "$OUT/connect.json"
unset KEY
if [ "$CONNECT" -ne 0 ]; then echo "provider connect failed"; exit 1; fi

TEAM="v2-linux-${VERSION//./}"
node "$HERE/e2e.mjs" "$TEAM" "$PROJECT" "$MODEL" "$W/claude-root" "$OUT" 9222
RESULT=$?
echo "e2e exit=$RESULT (connect exit=$CONNECT)"
git -C "$PROJECT" status --short >"$OUT/project-status.txt" 2>&1 || true
# Sanitized diagnostics only: categories/phases, no credentials.
find "$HOME" "$W/userdata" -path '*diagnostics*' -name '*.json' -size -64k 2>/dev/null | while read -r f; do
  mkdir -p "$OUT/diagnostics"; cp "$f" "$OUT/diagnostics/$(echo "$f" | sha256sum | cut -c1-12)-$(basename "$f")"
done
exit "$RESULT"
