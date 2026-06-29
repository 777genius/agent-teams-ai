# Codex Worker Pool Operations

This runbook describes how to run long Codex tasks through
`subscription-runtime` worker pools, how to monitor them, and how to adapt the
same shape to new projects.

It is written for backend/local operators and for other agents that need to
continue a task without prior chat context.

## When to use this workflow

Use the pool workflow when a task is long-running, writes code, benefits from a
native Codex `/goal`, and must continue across account quota or transient
session issues.

Good fits:

- benchmark improvement passes;
- large refactors in an isolated branch;
- repeated targeted test and fix loops;
- background maintenance tasks that can run for hours.

Avoid it for:

- one-shot read-only questions;
- tasks that need a human decision after every small step;
- unsafe tests against real user projects without explicit fresh permission;
- multiple writer workers in the same worktree.

## Core model

The practical runtime has these parts:

- one task prompt file;
- one stable `taskId`;
- one workspace or git worktree;
- one account pool;
- `FileBackendCodexSafeExecutor`;
- `executionEngine: "app-server-goal"` for native Codex goal continuation;
- `serviceTier: "fast"` for fast mode;
- `reasoningEffort: "xhigh"` for hard coding tasks;
- a 72 hour task timeout for overnight goals;
- tmux or a host supervisor for process lifetime;
- a heartbeat or cron monitor for health checks.

The worker owns account switching. The operator owns workspace isolation,
monitoring, and deciding when to restart.

## Quick start for another agent

If you inherit a running Codex worker pool, do this first:

1. Read the handoff text and identify the worktree, branch, tmux session, task
   id, prompt path, log path and allowed account slots.
2. Check the tmux pane and runner process. Do not start another writer in the
   same worktree while the current runner is alive.
3. Check `git status --short --branch` in the worktree. Treat dirty files as
   active work unless the result file proves the task is done or failed.
4. Check the latest result JSON if it exists. If it does not exist, the task is
   usually still running.
5. Run the safe account checker. It must print only slot status and sanitized
   metadata.
6. If the runner stopped because of quota, capacity, auth or reconnect, restart
   a continuation through the pool with the same prompt and workspace.
7. If the runner stopped because of provider output, runtime, code, test or
   benchmark failure, inspect the dirty work before retrying.
8. Keep model `gpt-5.5`, reasoning effort `xhigh`, service tier `fast`, engine
   `app-server-goal`, and a 72 hour task timeout unless the task owner changed
   them explicitly.
9. Verify with targeted tests before full benchmarks.
10. Commit only stable, reviewed worker changes with a conventional commit.

The safe default is: continue capacity failures automatically, inspect unknown
failures manually.

## CLI wrapper

Prefer the packaged CLI for new Codex goal runs:

```sh
subscription-runtime-codex-goal run \
  --job-root "$HOME/.cache/subscription-runtime/my-job" \
  --auth-root "$HOME/.cache/subscription-runtime/live-codex-auth" \
  --workspace /path/to/project-worktree \
  --prompt "$HOME/.cache/subscription-runtime/my-job/prompt.md" \
  --task-id my-task-001 \
  --accounts account-a,account-b,account-c \
  --tmux-session my-codex-worker
```

Defaults:

- model: `gpt-5.5`;
- reasoning effort: `xhigh`;
- service tier: `fast`;
- task timeout: `72h`;
- max account cycles: `3`;
- execution engine: `app-server-goal`;
- permission mode: `allow-edits`.

Escape hatches remain available:

- `--dry-run` or `--print-command`: print the exact command without running it;
- `--no-tmux`: run in the current process;
- `--no-require-git-workspace`: allow non-git sandbox workspaces;
- direct TypeScript API: use `runCodexGoal()` from
  `@vioxen/subscription-runtime/worker-codex`;
- manual runner: keep using a custom `run-goal.mjs` when a host app needs full
  control.

Useful operator commands:

```sh
subscription-runtime-codex-goal doctor \
  --job-root "$HOME/.cache/subscription-runtime/my-job" \
  --auth-root "$HOME/.cache/subscription-runtime/live-codex-auth" \
  --workspace /path/to/project-worktree \
  --prompt "$HOME/.cache/subscription-runtime/my-job/prompt.md" \
  --task-id my-task-001 \
  --accounts account-a,account-b,account-c

subscription-runtime-codex-goal status \
  --job-root "$HOME/.cache/subscription-runtime/my-job" \
  --workspace /path/to/project-worktree \
  --task-id my-task-001 \
  --tmux-session my-codex-worker

subscription-runtime-codex-goal tail \
  --job-root "$HOME/.cache/subscription-runtime/my-job" \
  --task-id my-task-001 \
  --lines 100
```

The CLI is intentionally a thin adapter. It does not replace tmux or host
orchestrators; it only creates the same runtime shape with fewer manual env
mistakes. The MCP adapter below uses the same application operations so humans
and agents see the same safety checks and status recommendations.

## MCP adapter for agents

Agents should prefer the MCP server when it is available:

```sh
subscription-runtime-codex-goal-mcp
```

The MCP adapter is the agent-facing control plane. It shares the same
application operations as the CLI, so operator behavior stays consistent while
agents get typed tools and structured results instead of long shell snippets.

Available tools:

- `codex_goal_dry_run`: build the no-tmux and tmux commands without starting
  anything.
- `codex_goal_start`: start one detached tmux worker. Requires
  `confirmStart: true`, checks that the tmux session is not already alive, and
  runs `doctor` unless `skipDoctor` is explicitly set. Completed, dirty, or
  unknown states require the explicit `forceStart` override.
- `codex_goal_status`: inspect tmux, result JSON, log freshness, workspace
  dirtiness, and `recommendedAction`.
- `codex_goal_doctor`: validate prompt, job root, auth root, workspace and
  account auth files.
- `codex_goal_tail`: read the last log lines.
- `codex_accounts_status`: inspect slot auth health without printing token
  material.

Minimal MCP `codex_goal_start` input:

```json
{
  "jobRootDir": "/Users/me/.cache/subscription-runtime/my-job",
  "authRootDir": "/Users/me/.cache/subscription-runtime/live-codex-auth",
  "workspacePath": "/path/to/project-worktree",
  "promptPath": "/Users/me/.cache/subscription-runtime/my-job/prompt.md",
  "taskId": "my-task-001",
  "accounts": ["account-a", "account-b", "account-c"],
  "tmuxSession": "my-codex-worker",
  "model": "gpt-5.5",
  "reasoningEffort": "xhigh",
  "serviceTier": "fast",
  "taskTimeoutMs": 259200000,
  "maxAccountCycles": 3,
  "confirmStart": true
}
```

The same input can be stored in a JSON file and passed as `configPath`. Tool
arguments override matching config file fields. This is the recommended handoff
shape for another agent because the agent only needs the config path plus
occasional overrides.

Recommended agent loop:

1. Call `codex_goal_status`.
2. If `recommendedAction` is `wait_for_worker`, do not start another writer in
   that worktree.
3. If `recommendedAction` is `start_worker`, run `codex_goal_dry_run`, then
   `codex_goal_start` with `confirmStart: true`.
4. If it is `continue_after_capacity` or `continue_after_timeout`, restart the
   same task with the same prompt, task id, workspace and account pool.
5. If it is `inspect_dirty_workspace` or `inspect_dirty_failure`, inspect the
   diff and log before retrying.
6. Use `codex_accounts_status` before asking a human to relogin slots.

Security rules:

- never print `auth.json`, access tokens, refresh tokens, id tokens or raw
  provider payloads;
- do not run two writer workers in one worktree;
- do not test launch/provisioning/smoke-flow against real user projects unless
  the user gave fresh explicit permission;
- use `codex_goal_dry_run` before `codex_goal_start` when inheriting unknown
  config.

## Recommended layout

Use a cache directory per logical job:

```txt
~/.cache/subscription-runtime/<job-id>/
  check-codex-accounts.mjs
  encryption-key.hex
  prompt.md
  run-goal.mjs
  state/
  <task-id>.latest-result.json
  <task-id>.log
```

Keep auth slots outside the job cache:

```txt
~/.cache/subscription-runtime/live-codex-auth/
  account-a/auth.json
  account-b/auth.json
  account-c/auth.json
```

Never print `auth.json`, access tokens, refresh tokens, id tokens, or full
provider payloads in chat or logs.

## Account slots

Each slot is a separate Codex `CODEX_HOME`:

```sh
CODEX_HOME="$HOME/.cache/subscription-runtime/live-codex-auth/account-a" \
  codex login --device-auth
```

Device auth is preferred for handoff because it gives a short-lived code and
does not depend on a specific browser callback window.

For relogin:

```sh
slot="account-a"
auth_root="$HOME/.cache/subscription-runtime/live-codex-auth"
cp "$auth_root/$slot/auth.json" \
  "$auth_root/$slot/auth.json.bak.$(date +%Y%m%d-%H%M%S).before-relogin"
CODEX_HOME="$auth_root/$slot" codex login --device-auth
```

After login, run a safe account checker. It should report only slot health and
sanitized metadata:

```sh
node ~/.cache/subscription-runtime/<job-id>/check-codex-accounts.mjs
```

Expected statuses:

- `ready`: slot can be selected;
- `quota_limited` or `capacity_unavailable`: switch to another account;
- `auth_invalid` or revoked refresh token: relogin the slot;
- `reconnect_required`: try one repair/reconnect, then cooldown the slot;
- `account_unavailable`: disable or cooldown the slot and continue elsewhere.

## Workspace strategy

For write tasks, prefer one writer per git worktree.

```sh
git worktree add -b feat/my-task-pass \
  /path/to/project-my-task-pass \
  base-branch
```

Rules:

- do not run two writer workers in the same worktree;
- keep the stable parent branch clean before creating worker branches;
- give each worker a focused prompt and branch;
- use shared `.venv` or dependency caches only when they are ignored by git;
- do not discard dirty work from a worker unless the user explicitly asks.

Good parallel split:

- worker 1: lexical/list/count recall;
- worker 2: reasoning/relationship/motivation;
- worker 3: temporal/source-sibling/answer-shape.

Merge only after each worker has a stable commit and focused verification.

## Runner template

This is the minimal shape for a native Codex goal runner.

```js
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { FileBackendCodexSafeExecutor } from "@vioxen/subscription-runtime/worker-codex";

const root = process.env.SUBSCRIPTION_RUNTIME_JOB_ROOT;
const authRoot = process.env.SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT;
const workspacePath = process.env.SUBSCRIPTION_RUNTIME_WORKSPACE_PATH;
const taskId = process.env.SUBSCRIPTION_RUNTIME_TASK_ID;
const promptPath = process.env.SUBSCRIPTION_RUNTIME_PROMPT_PATH;

if (!root || !authRoot || !workspacePath || !taskId || !promptPath) {
  throw new Error("missing required subscription-runtime env");
}

const stateRootDir = join(root, "state");
const keyPath = join(root, "encryption-key.hex");
const taskTimeoutMs = Number(
  process.env.SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS ?? 72 * 60 * 60 * 1000,
);

await mkdir(stateRootDir, { recursive: true, mode: 0o700 });

async function stableKey() {
  if (existsSync(keyPath)) {
    return Buffer.from((await readFile(keyPath, "utf8")).trim(), "hex");
  }
  const key = randomBytes(32);
  await writeFile(keyPath, `${key.toString("hex")}\n`, { mode: 0o600 });
  return key;
}

const encryptionKey = await stableKey();
const prompt = await readFile(promptPath, "utf8");
const accountNames = (process.env.CODEX_ACCOUNTS ?? "account-a")
  .split(",")
  .map((name) => name.trim())
  .filter(Boolean);

const executor = new FileBackendCodexSafeExecutor({
  executorId: process.env.SUBSCRIPTION_RUNTIME_EXECUTOR_ID ?? taskId,
  stateRootDir,
  workspacePath,
  maxAccountCycles: Number(process.env.SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES ?? 3),
  accounts: accountNames.map((accountName, index) => ({
    codexAuthJsonPath: join(authRoot, accountName, "auth.json"),
    worker: {
      providerInstanceId: `${taskId}-${accountName}`,
      stateRootDir,
      codexBinaryPath: process.env.CODEX_BINARY_PATH ?? "codex",
      model: process.env.CODEX_MODEL ?? "gpt-5.5",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "xhigh",
      serviceTier: process.env.CODEX_SERVICE_TIER ?? "fast",
      executionEngine: "app-server-goal",
      encryptionKey,
      taskTimeoutMs,
      capacityAccountId: accountName,
      capacityPolicy: {
        quotaCooldownMs: 15 * 60 * 1000,
        reconnectCooldownMs: 15 * 60 * 1000,
        maxReconnectRetriesPerAccount: 1,
      },
      metadata: { accountOrder: String(index + 1) },
    },
  })),
  safeExecutionPolicy: {
    retryOnCapacity: true,
    retryOnAccountUnavailable: true,
    retryOnReconnectRequired: true,
    continuationMode: "packet_first",
  },
});

try {
  const result = await executor.run({
    taskId,
    prompt,
    staleLockMs: 1,
    controls: { permissionMode: "allow-edits" },
    metadata: {
      goal: process.env.SUBSCRIPTION_RUNTIME_GOAL_SUMMARY ?? taskId,
      codexGoalObjective:
        process.env.SUBSCRIPTION_RUNTIME_CODEX_GOAL_OBJECTIVE ?? prompt,
    },
  });
  await writeFile(
    join(root, `${taskId}.latest-result.json`),
    `${JSON.stringify(result, null, 2)}\n`,
    "utf8",
  );
} finally {
  await executor.dispose();
}
```

Production scripts should summarize results before writing them, so raw error
chains cannot leak tokens.

## Starting a worker

Use tmux for local overnight work:

```sh
tmux new-session -d -s my-codex-worker -c /path/to/subscription-runtime \
  'env \
    CODEX_ACCOUNTS=account-a,account-b,account-c \
    SUBSCRIPTION_RUNTIME_JOB_ROOT=$HOME/.cache/subscription-runtime/my-job \
    SUBSCRIPTION_RUNTIME_CODEX_AUTH_ROOT=$HOME/.cache/subscription-runtime/live-codex-auth \
    SUBSCRIPTION_RUNTIME_WORKSPACE_PATH=/path/to/project-worktree \
    SUBSCRIPTION_RUNTIME_TASK_ID=my-task-001 \
    SUBSCRIPTION_RUNTIME_PROMPT_PATH=$HOME/.cache/subscription-runtime/my-job/prompt.md \
    SUBSCRIPTION_RUNTIME_TASK_TIMEOUT_MS=259200000 \
    CODEX_MODEL=gpt-5.5 \
    CODEX_REASONING_EFFORT=xhigh \
    CODEX_SERVICE_TIER=fast \
    node $HOME/.cache/subscription-runtime/my-job/run-goal.mjs \
    2>&1 | tee -a $HOME/.cache/subscription-runtime/my-job/my-task-001.log'
```

Keep the prompt self-contained:

- objective;
- current baseline;
- constraints;
- allowed verification commands;
- commit and push expectations;
- what to do if blocked;
- what not to touch.

## Monitoring checklist

Check these periodically:

```sh
tmux list-sessions
tmux list-panes -t my-codex-worker \
  -F '#{pane_pid} #{pane_current_command} #{pane_dead} #{pane_dead_status}'
pgrep -P <tmux-pane-pid> -laf .
ps -o pid,ppid,stat,etime,pcpu,pmem,command -p <runner-pid>,<app-server-pid>
git -C /path/to/project-worktree status --short --branch
tail -100 ~/.cache/subscription-runtime/my-job/my-task-001.log
ls -l ~/.cache/subscription-runtime/my-job/my-task-001.latest-result.json
node ~/.cache/subscription-runtime/my-job/check-codex-accounts.mjs
```

Healthy signs:

- tmux pane is alive;
- `run-goal.mjs` is a child of the pane shell;
- an app-server process exists for the active attempt;
- the worktree is either clean at start or has expected WIP;
- files change over time, or the app-server has CPU activity;
- result JSON is absent while running or has a recent terminal summary after
  completion.

Quiet logs are not always bad. The app-server goal path often writes the final
summary only when the attempt finishes.

## Restart policy

Do not restart just because output is quiet.

Restart or continue only when evidence shows:

- runner process exited;
- tmux pane died;
- result JSON says capacity/auth/reconnect failure;
- no file changes, no CPU, no result and no active app-server for a long window;
- account pool changed and the old attempt cannot continue.

Error handling policy:

- quota or capacity limit: switch to the next ready account;
- auth invalid or revoked refresh token: mark slot unavailable, relogin later,
  continue with another ready account;
- reconnect required: try one same-account repair, then cooldown and switch;
- provider output invalid, unknown runtime, test failure or benchmark failure:
  do not automatically switch accounts;
- unknown failure with dirty workspace: stop and inspect before retry;
- unknown failure with clean workspace: at most one same-account retry.

This distinction matters. Account switching is for capacity or broken sessions,
not for hiding code or test failures.

## Troubleshooting and decisions

Use this table before restarting a worker:

| Signal | Meaning | Action |
| --- | --- | --- |
| `ready` account status | Slot can run Codex | Keep it in the pool |
| `quota_limited` or `capacity_unavailable` | Slot has no usable capacity now | Switch to next ready slot |
| `auth_invalid` or revoked refresh token | Slot credentials are broken | Remove from active pool, relogin later |
| `reconnect_required` once | Session or app-server needs repair | Try one same-account repair |
| repeated `reconnect_required` | Slot session is unhealthy | Cooldown slot, switch to next ready slot |
| `provider_output_invalid` | Runtime got unusable provider output | Do not switch accounts automatically, inspect |
| test or benchmark failure | Code behavior failed | Do not switch accounts automatically, inspect |
| dirty worktree and unknown failure | Mid-task state may be partial | Stop and inspect before retry |
| clean worktree and unknown failure | No code was changed | At most one same-account retry |
| tmux alive, result absent, app-server alive | Task is probably running | Keep monitoring |
| tmux dead or runner missing | Task stopped | Read result/logs, then continue if policy allows |

Before a continuation, record:

- current branch and commit;
- dirty file summary;
- last result or last visible log line;
- account slots that are ready;
- whether the failure was capacity, auth, reconnect or unknown.

Continuation should preserve the same worktree and prompt unless the task owner
explicitly asks to fork or reset. If the current worktree is dirty, the next
attempt must understand it is continuing mid-task.

## Long task verification

For benchmark and refactor goals:

- run targeted tests first;
- add scenario regression tests, not benchmark ID checks;
- avoid full benchmark runs after every small edit;
- run the full benchmark only after targeted slices improve;
- commit stable changes with a conventional commit;
- push only stable branches;
- merge worker branches manually after review.

For memory and retrieval tasks, forbid:

- `case_id` hardcode;
- answer or evidence ID leakage;
- provider SDK imports in core;
- raw provider payload in rendered evidence;
- unrelated dirty changes.

## Handoff notes for another agent

Give the next agent:

- repo path;
- worktree path;
- branch name;
- tmux session name;
- task id;
- prompt path;
- result path;
- account slots allowed for the pool;
- model, effort and service tier;
- commands from the monitoring checklist;
- restart policy from this runbook.

Minimal handoff text:

```txt
Use subscription-runtime Codex worker pool.
Worktree: /path/to/project-worktree
Branch: feat/my-task-pass
tmux: my-codex-worker
Task id: my-task-001
Prompt: ~/.cache/subscription-runtime/my-job/prompt.md
Accounts: account-a,account-b,account-c
Model: gpt-5.5
Effort: xhigh
Service tier: fast
Execution engine: app-server-goal
Do not run two writers in the same worktree.
If quota/capacity/auth/reconnect happens, use pool continuation.
If unknown/runtime/test failure happens, inspect dirty work before retry.
```
