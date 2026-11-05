#!/bin/bash
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
W="$RUNNER_TEMP/TEST-intel-v2"
OUT="$RUNNER_TEMP/TEST-intel-v2-out"
mkdir -p "$W" "$OUT"
npm install --prefix "$W/oc" --ignore-scripts --no-audit --no-fund @opencode/cli-darwin-x64@2.1.4 > /dev/null
OC="$W/oc/node_modules/@opencode/cli-darwin-x64/bin/opencode"
"$OC" --version
PROJECT="$W/project"
mkdir -p "$PROJECT" "$W/home" "$W/userdata" "$W/claude-root/projects"
git -C "$PROJECT" init -q
git -C "$PROJECT" config user.name iliya
git -C "$PROJECT" config user.email iliyazelenkog@gmail.com
printf '# TEST Intel V2\n' > "$PROJECT/README.md"
git -C "$PROJECT" add README.md
git -C "$PROJECT" commit -qm 'test: create fixture'
export HOME="$W/home" XDG_CACHE_HOME="$W/home/.cache" XDG_CONFIG_HOME="$W/home/.config"
export XDG_DATA_HOME="$W/home/.local/share" XDG_STATE_HOME="$W/home/.local/state"
export CLAUDE_DEV_RUNTIME_DISABLE_GH=1 CLAUDE_AGENT_TEAMS_ORCHESTRATOR_CLI_PATH="$CANDIDATE_CLI"
export CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH="$OC"
export AGENT_TEAMS_ELECTRON_USER_DATA_DIR="$W/userdata" AGENT_TEAMS_ELECTRON_CLAUDE_ROOT="$W/claude-root"
KEY="${KIMI_TEST_API_KEY:-}"
unset KIMI_TEST_API_KEY
pnpm dev:mcp > "$OUT/dev.log" 2>&1 &
DEV=$!
cleanup() { kill "$DEV" 2>/dev/null || true; }
trap cleanup EXIT
node "$HERE/cdp.mjs" wait 9222
KIMI_TEST_API_KEY="$KEY" node "$HERE/cdp.mjs" connect "$PROJECT" > "$OUT/connect.log" 2>&1
unset KEY
set +e
node "$HERE/e2e.mjs" test-intel-v2 "$PROJECT" kimi-code-plan-cn/kimi-for-coding "$W/claude-root" "$OUT" 9222 > "$OUT/e2e.log" 2>&1
result=$?
set -e
node - "$OUT/e2e-log.jsonl" "$OUT/verdict.json" "$result" <<'NODE'
const fs = require('fs');
let rows=[]; try { rows=fs.readFileSync(process.argv[2],'utf8').trim().split('\n').map(JSON.parse) } catch {}
const verdict=rows.findLast(row=>row.step==='verdict')?.data ?? null;
fs.writeFileSync(process.argv[3],JSON.stringify({exitCode:Number(process.argv[4]),verdict},null,2));
console.log(JSON.stringify({exitCode:Number(process.argv[4]),verdict}));
NODE
exit "$result"
