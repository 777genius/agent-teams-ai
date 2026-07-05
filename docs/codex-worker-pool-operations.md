# Codex Worker Pool Operations

This runbook describes how to run long Codex tasks through
`subscription-runtime` worker pools, how to monitor them, and how to adapt the
same shape to new projects.

It is written for backend/local operators and for other agents that need to
continue a task without prior chat context.

For a short copy-paste handoff, give another agent
`docs/codex-worker-agent-quickstart.md` first, then this runbook for details.

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
- `reasoningEffort: "high"` for hard coding tasks;
- a 72 hour task timeout for overnight goals;
- tmux or a host supervisor for process lifetime;
- a heartbeat or cron monitor for health checks.

The worker owns account switching. The operator owns workspace isolation,
monitoring, and deciding when to restart.

## Quick start for another agent

If you inherit a running Codex worker pool, do this first:

1. Ask for or discover the `jobId`. Prefer `codex_goal_get_job` over copying
   paths from chat.
2. Call `codex_goal_brief` or `codex_goal_status_by_id` for the stored job.
3. Check the tmux pane and runner process. Do not start another writer in the
   same worktree while the current runner is alive.
4. Check `git status --short --branch` in the worktree. Treat dirty files as
   active work unless the result file proves the task is done or failed.
5. Check the latest result JSON if it exists. If it does not exist, the task is
   usually still running.
6. Use `codex_accounts_status` for the selected pool. It must print only slot
   status and sanitized metadata.
7. If the runner stopped because of quota, capacity, auth or reconnect, restart
   a continuation through `codex_goal_continue` with the same stored job only
   when `codex_goal_brief.safeToContinue` is true.
8. If the runner stopped because of provider output, runtime, code, test or
   benchmark failure, inspect the dirty work before retrying.
9. Keep model `gpt-5.5`, reasoning effort `high`, service tier `fast`, engine
   `app-server-goal`, and a 72 hour task timeout unless the task owner changed
   them explicitly.
10. Verify with targeted tests before full benchmarks.
11. Commit only stable, reviewed worker changes with a conventional commit.

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
- reasoning effort: `high`;
- service tier: `fast`;
- task timeout: `72h`;
- max account cycles: `5`;
- execution engine: `app-server-goal`;
- edit mode: `allow-edits`.

Edit mode is a subscription-runtime edit/effect policy, not the provider's
low-level sandbox flag. Use `allow-edits` for workers that may create a
workspace patch. Use `providerSandboxMode` only when the provider sandbox itself
must be selected explicitly. Codex `danger-full-access` must be requested
through `accessBoundary: "danger_full_access"` with explicit acknowledgement,
not by setting provider sandbox alone.

Escape hatches remain available:

- `--dry-run` or `--print-command`: print the exact command without running it;
- `--no-tmux`: run in the current process;
- `--no-require-git-workspace`: allow non-git sandbox workspaces;
- direct TypeScript API: use `runCodexGoal()` from
  `@vioxen/subscription-runtime/worker-codex`;
- manual runner: keep using a custom `run-goal.mjs` when a host app needs full
  control.

`codex_goal_start`, `codex_goal_continue`, `codex_goal_stop` and direct CLI
`--tmux-session` launches resolve tmux through `SUBSCRIPTION_RUNTIME_TMUX_PATH`,
`TMUX_PATH`, `TMUX_BIN`, `PATH`, then common Homebrew and system paths. This
keeps native MCP usable in desktop hosts that provide a minimal `PATH`. Inside
the tmux pane, the runner command intentionally uses `run --no-tmux`; that
means the detached process is already inside tmux and should not create a nested
session.

Do not infer worker liveness from the tmux flag alone. Registry read models use
tmux state, progress heartbeat, recorded pid/process state, result files and
workspace state together. A worker may be observable through fresh running
progress even when the inner runner command includes `--no-tmux`.

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

## Worker Control Inbox

Use the control inbox when a human, orchestrator, or another agent needs to add
durable guidance to a stored worker job without injecting a live message into an
active provider turn.

Safe default:

```sh
subscription-runtime-codex-goal guidance my-job \
  --message "Stop broad verification and continue from current WIP with targeted tests first." \
  --idempotency-key my-job-guidance-urgent-001

subscription-runtime-codex-goal control-enqueue my-job \
  --body "Continue from current WIP. Prefer targeted tests before full benchmark." \
  --idempotency-key my-job-guidance-001

subscription-runtime-codex-goal control-decision my-job
subscription-runtime-codex-goal control-list my-job
subscription-runtime-codex-goal control-reconcile my-job
```

The default delivery mode is `next_safe_point`. The next safe continuation will
include pending guidance in the continuation packet and mark the signal
`delivered`. `record_only` signals are kept for audit and are not injected into
worker prompts.

`guidance` is the first-class urgent steering shortcut. It calls the MCP tool
`codex_goal_send_guidance` and requests `interrupt_then_continue`. If the MCP
process owns the active attempt registry, the current attempt is interrupted
with the runtime-owned reason `runtime_interrupted` and the same task resumes
through a continuation packet. If the MCP process cannot prove that the active
attempt is locally controllable, it fails closed: the signal remains durable and
is delivered at the next safe continuation point.

Embedding the MCP server in the same process as an orchestrated worker can pass
an `activeAttemptRegistry` to `createCodexGoalMcpServer(...)`. Plain stdio MCP
usually runs out-of-process, so it should be expected to use the durable
next-safe-point fallback unless the host explicitly wires that registry.

For safety, enqueue responses and normal list responses do not echo signal
bodies. Use `control-list --include-bodies` only when the operator explicitly
needs to inspect the stored guidance text.

If a worker crashes after claiming a signal but before recording delivery, the
signal can remain in `accepted`. Use repair only after the attempt is confirmed
dead or stale:

```sh
subscription-runtime-codex-goal control-reconcile my-job \
  --repair \
  --accepted-stale-after-ms 300000
```

Repair releases stale local delivery claims back to pending so the next safe
continuation can receive the guidance. It does not inject a live message into an
active turn.

Native MCP equivalents:

- `codex_goal_send_guidance`
- `codex_goal_control_enqueue`
- `codex_goal_control_list`
- `codex_goal_control_decision`
- `codex_goal_control_reconcile`
- `codex_goal_control_supersede`

Do not use the inbox as an agent-to-agent chat. It is for worker control signals
targeted at one stored job. Shared or personal agent mailboxes belong in a
higher-level orchestrator.

## Live worker e2e harness

The permanent live harness is intentionally opt-in. The default command builds
the package and skips all real provider work:

```sh
npm run e2e:live-workers
```

Use that build-and-run command from a normal development checkout or a throwaway
release clone. Do not run it from `/var/data/runtimes/subscription-runtime/current/repo`
on a live host, because it cleans and rebuilds `dist` in place while the
production wrapper may import the same files. For an already deployed release,
first deploy with the release script checks, then run the no-build harness:

```sh
npm run e2e:live-workers:dist
```

To run it against real sandbox workers, use only explicit test/sandbox
workspaces:

```sh
SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 npm run e2e:live-workers
```

On `/current/repo`, replace `npm run e2e:live-workers` with
`npm run e2e:live-workers:dist` in the examples below.

To run only the project-scoped controller regression, use:

```sh
SUBSCRIPTION_RUNTIME_LIVE_E2E_ONLY=codex-project-controller-manifest-liveness-contract \
  npm run e2e:live-workers
```

That regression does not use real provider accounts. It creates a sandbox
`project_scoped_control` controller manifest, proves ordinary worker startup
fails closed, then proves brokered child worktree/job creation still works.

To inspect whether a controller manifest can become a live broker-only LLM
controller, use the launch-plan tool:

```sh
subscription-runtime-codex-goal tool codex_goal_project_controller_launch_plan \
  --args-json '{"registryRootDir":"/var/data/infinity-context/worker-jobs/registry","controllerJobId":"infinity-context-project-controller-v1"}'

subscription-runtime-codex-goal tool codex_goal_project_controller_status \
  --args-json '{"registryRootDir":"/var/data/infinity-context/worker-jobs/registry","controllerJobId":"infinity-context-project-controller-v1"}'
```

If the result is `provider_cannot_disable_raw_shell`, the selected provider
profile still exposes raw shell and must not be used for a live controller. Do
not switch the controller to `danger_full_access`; that bypasses the
project-scoped control boundary.
If `codex_goal_project_controller_start`, `stop` or `reconcile` returns
`controlled_agent_provider_runner_not_connected`, the persisted run is not owned
by the current MCP process. Treat this as expected fail-closed behavior after a
process restart or split-brain attempt. Do not use `danger_full_access`; stop or
reconcile from the owning process, or restart from clean controlled-agent state.
For Codex `start` also requires `projectAccessScope.authRoot` to match the
controller job `authRootDir` and at least one ready allowed account.

To run the real Codex controller-to-child regression through the host-side
broker tools, use:

```sh
SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 \
  SUBSCRIPTION_RUNTIME_LIVE_E2E_ONLY=codex-project-controller-starts-real-child-worker \
  npm run e2e:live-workers
```

This proves the project broker can start a real child Codex worker and integrate
its output from a sandbox project. It does not prove that a broker-only LLM
controller made those broker calls by itself.

To run only the controlled-agent Codex launcher smoke on a real account, use a
sandbox-only scenario:

```sh
SUBSCRIPTION_RUNTIME_LIVE_WORKERS=1 \
  CODEX_LIVE_ACCOUNT=account-e \
  CODEX_CONTROLLED_LIVE_MAX_GOAL_TURNS=1 \
  SUBSCRIPTION_RUNTIME_LIVE_E2E_ONLY=codex-controlled-controller-real-app-server-launcher \
  npm run e2e:live-workers
```

This proves the live Codex controlled-agent provider can start with native
app-server environments disabled and with only broker/status MCP tools in the
generated profile. It is intentionally bounded with `maxGoalTurns` and should
not be treated as a long-running production controller.

If the selected account is expired, quota-limited or capacity-limited, the
harness reports the scenario as skipped. That means auth/account state must be
repaired before claiming a successful live controller pass.

The harness covers Codex app-server sandbox execution, broken-auth skip,
quota-to-next-account continuation with inbox delivery, project-scoped
controller manifest liveness, project-scoped child-worker startup through
broker tools, and Claude CLI safe-point inbox delivery. It redacts token-shaped
strings from result output and should not be pointed at real user projects.

## Choosing the control surface

Use the highest-level surface that still gives the operator enough control:

| Surface | Best for | Tradeoff |
| --- | --- | --- |
| MCP `subscription-runtime-codex-goal-mcp` | Agents that need structured start, monitor, recover and handoff tools | Requires an MCP-capable host |
| CLI MCP fallback `subscription-runtime-codex-goal tool <name>` | Agents in Codex threads where native MCP tools did not load | Same MCP server via SDK, but called through shell commands |
| CLI direct commands `subscription-runtime-codex-goal run/status/doctor/tail` | Humans, shell scripts, tmux and simple cron monitors | Smaller surface than MCP, but easy to inspect |
| `runCodexGoal()` TypeScript API | Host apps or orchestrators that want to own scheduling, UI, notifications or persistence | Caller must preserve the safety policy and account status checks |
| `FileBackendCodexSafeExecutor` | Advanced integrations that need custom workers, custom account definitions or custom execution policy | Most flexible, most responsibility |

The recommended order for agents is native MCP first, CLI MCP fallback second,
direct API only when the agent is editing a host integration. Direct API should
not be used as a shortcut to bypass `codex_goal_brief.safeToContinue`,
single-writer checks, capacity-aware account status or dirty-worktree review.

### Sandboxed lane orchestrators

A lane orchestrator running inside a Codex `app-server-goal` worker is still
inside the provider sandbox. It should assume host GitHub credentials, raw
account auth roots, tmux supervision and worker-spawn privileges are unavailable
unless the host explicitly exposes them through subscription-runtime controls.

Use that boundary deliberately:

- child worker creation, continuation, stop and account repair belong on the
  host-side MCP, CLI or SDK control surface;
- lane workers may request those actions with `codex_goal_handoff`,
  `codex_goal_decision`, `codex_goal_control_enqueue` or a host-owned
  orchestrator port;
- do not pass `GITHUB_TOKEN`, `GH_TOKEN`, raw `auth.json` bytes or provider
  credentials into the worker sandbox to make a lane orchestrator self-spawn;
- if native MCP is not available in the worker thread, use the CLI MCP fallback
  command from the handoff rather than invoking provider or host auth surfaces
  directly.

### Flexible and custom integrations

Use the SDK MCP client when a host or agent cannot access native MCP tools but
still wants the same control plane:

```ts
import { callCodexGoalMcpTool } from "@vioxen/subscription-runtime/worker-codex";

const brief = await callCodexGoalMcpTool({
  name: "codex_goal_brief",
  args: { jobId: "my-job" },
});
```

Use `runCodexGoal()` when a host app wants the same Codex goal behavior but
needs to customize process supervision, notifications, job storage or UI:

```ts
import { runCodexGoal, codexGoalAccountSlots } from "@vioxen/subscription-runtime/worker-codex";

await runCodexGoal({
  jobRootDir: "/Users/me/.cache/subscription-runtime/my-job",
  stateRootDir: "/Users/me/.cache/subscription-runtime/my-job/state",
  authRootDir: "/Users/me/.cache/subscription-runtime/live-codex-auth",
  workspacePath: "/path/to/project-worktree",
  promptPath: "/Users/me/.cache/subscription-runtime/my-job/prompt.md",
  taskId: "my-task-001",
  accounts: codexGoalAccountSlots(["account-a", "account-b", "account-c"]),
  outputPath: "/Users/me/.cache/subscription-runtime/my-job/my-task-001.latest-result.json",
  model: "gpt-5.5",
  reasoningEffort: "high",
  serviceTier: "fast",
  taskTimeoutMs: 72 * 60 * 60 * 1000,
  maxAccountCycles: 5,
});
```

Use `FileBackendCodexSafeExecutor` directly only when `runCodexGoal()` is too
high level. Common reasons:

- the host app already owns task queues and wants to construct `run()` input
  itself;
- accounts are not simple `authRoot/account-name/auth.json` slots;
- the host needs a custom `safeExecutionPolicy`;
- the host needs custom worker metadata, telemetry or account ordering.

Even in direct API mode, keep these invariants:

- one writer per worktree;
- `executionEngine: "app-server-goal"` for native `/goal` continuation;
- `retryOnCapacity`, `retryOnAccountUnavailable` and
  `retryOnReconnectRequired` may be automatic;
- provider output, unknown runtime, test and benchmark failures require
  manual inspection before retry;
- pass the job `stateRootDir` to account status checks so cooldown/quota
  records are visible;
- never print raw auth files, tokens or provider payloads.

## MCP adapter for agents

Agents should prefer the MCP server when it is available:

```sh
subscription-runtime-codex-goal-mcp
```

The MCP adapter is the agent-facing control plane. It shares the same
application operations as the CLI, so operator behavior stays consistent while
agents get typed tools and structured results instead of long shell snippets.

If native MCP tools do not appear in a Codex thread, use the CLI MCP fallback.
It launches the same server in-process through the SDK, so it has the same tool
surface:

```sh
subscription-runtime-codex-goal doctor-control
subscription-runtime-codex-goal tools
subscription-runtime-codex-goal overview
subscription-runtime-codex-goal brief memo-locomo-cat1-recall
subscription-runtime-codex-goal handoff memo-locomo-cat1-recall
subscription-runtime-codex-goal accounts memo-locomo-cat1-recall
subscription-runtime-codex-goal continue-job memo-locomo-cat1-recall --confirm
subscription-runtime-codex-goal stop-job memo-locomo-cat1-recall --confirm
subscription-runtime-codex-goal maintenance-pause-job memo-locomo-cat1-recall --confirm --reason resize
subscription-runtime-codex-goal tool codex_goal_brief --args-json '{"jobId":"memo-locomo-cat1-recall"}'
subscription-runtime-codex-goal tool codex_goal_accounts_status --args-json '{"jobId":"memo-locomo-cat1-recall"}'
subscription-runtime-codex-goal tool codex_goal_continue --args-json '{"jobId":"memo-locomo-cat1-recall","confirmContinue":true}'
subscription-runtime-codex-goal resource codex-goal://jobs/memo-locomo-cat1-recall
subscription-runtime-codex-goal prompts
```

For Codex CLI/Desktop user config, install or verify the native server with:

```sh
codex mcp add subscription-runtime-codex-goal -- "$(command -v node)" /Users/belief/dev/projects/subscription-runtime/dist/worker-codex/codex-goal-mcp.js
codex mcp get subscription-runtime-codex-goal
```

After editing source, run `npm run build`; new Codex threads use `dist`.

### Job registry happy path

The first-class agent workflow is a versioned `job.json` manifest. It keeps
paths, account slots, model settings and tmux session in one place so another
agent can continue by `jobId` without reconstructing shell commands from chat.

Recommended flow:

1. `codex_goal_create_job` once per logical goal.
2. `codex_goal_get_job` or `codex_goal_list_jobs` for handoff.
3. `codex_goal_brief` for the compact current state.
4. `codex_goal_continue` with `confirmContinue: true` only when
   `brief.safeToContinue` is true.
5. `codex_goal_mark_reviewed` after a completed worker was inspected.

Minimal `codex_goal_create_job` input:

```json
{
  "jobId": "memo-locomo-cat1-recall",
  "description": "Improve LoCoMo category 1 recall",
  "tags": ["memo-stack", "locomo", "cat1"],
  "jobRootDir": "/Users/me/.cache/subscription-runtime/memo-locomo-cat1-recall",
  "authRootDir": "/Users/me/.cache/subscription-runtime/live-codex-auth",
  "stateRootDir": "/Users/me/.cache/subscription-runtime/memo-locomo-cat1-recall/state",
  "workspacePath": "/path/to/project-worktree",
  "promptPath": "/Users/me/.cache/subscription-runtime/memo-locomo-cat1-recall/prompt.md",
  "taskId": "memo-locomo-cat1-recall",
  "accounts": ["account-a", "account-b", "account-c"],
  "tmuxSession": "memo-locomo-cat1-recall",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "serviceTier": "fast",
  "executionEngine": "app-server-goal",
  "taskTimeoutMs": 259200000,
  "maxAccountCycles": 5
}
```

The manifest is stored under:

```txt
~/.cache/subscription-runtime/codex-goal-jobs/<jobId>/job.json
```

Agents can also read it as an MCP resource:

```txt
codex-goal://jobs/<jobId>
```

### MCP tools

Core launch and inspection tools:

- `codex_goal_dry_run`: build the no-tmux and tmux commands without starting
  anything.
- `codex_goal_start`: start one detached tmux worker. Requires
  `confirmStart: true`, checks that the tmux session is not already alive, and
  writes/updates the registry manifest before `doctor` and tmux start. This
  keeps the job visible to `overview` even if a confirmed launch fails during
  preflight. It runs `doctor` unless `skipDoctor` is explicitly set. Completed,
  dirty, or unknown states require the explicit `forceStart` override.
- `codex_goal_status`: inspect tmux, result JSON, log freshness, workspace
  dirtiness, and `recommendedAction`.
- `codex_goal_doctor`: validate prompt, job root, auth root, workspace and
  account auth files.
- `codex_goal_tail`: read the last log lines.
- `codex_accounts_status`: inspect slot auth health, capacity cooldowns and
  sanitized identity hashes without printing token material.

Job registry tools:

- `codex_goal_list_jobs`: list stored jobs.
- `codex_goal_get_job`: read one `job.json`.
- `codex_goal_create_job`: create a new stored job.
- `codex_goal_update_job`: patch a stored job.
- `codex_goal_overview`: summarize all stored jobs in a registry with compact
  status, account availability, stale/silent-stale flags and ready-to-call
  next-action commands.
- `agent_run_watch`: provider-neutral, read-only run observation. In the Codex
  goal MCP server it reports Codex and Claude run status, liveness, heartbeat
  freshness, result/failure, optional log tail, optional changed files,
  artifacts, capacity hints, warnings and `readOnlyDecision`. It never starts,
  stops, continues, recovers, writes inbox signals or delivers work.
- `codex_goal_run_watch`: Codex-scoped read-only run observation surface.
- `codex_goal_reconcile_preview`: reconciliation-preview tool, not pure watch.
  It is dry-run by default. With `continueSafeJobs: true`, it continues only
  stopped jobs whose adapter reports `safeToContinue`, blocks same-workspace
  writer conflicts, and respects `maxContinuesPerRun`.
- `codex_goal_status_by_id`: inspect a job by `jobId`.
- `codex_goal_brief`: compact operator summary with stale/progress/account
  hints, recent commands and the next safe job-level command.
- `codex_goal_decision`: read-only decision report for agents. It combines
  brief, account state and registry-level single-writer conflicts into
  `decision.action`, `decision.severity`, `decision.blockers`, `decision.evidence`,
  `decision.checklist` and an exact `decision.nextBestCommand`.
- `codex_goal_handoff`: build a copy-paste safe handoff bundle with job
  paths, status, account summary, next commands and CLI fallback commands.
- `codex_goal_accounts_status`: inspect the stored job's configured account
  slots by `jobId`, including job-specific cooldown/quota state.
- `codex_goal_accounts_list_pools`: list account pools for the stored job by
  `jobId` using the job state root for capacity-aware counts.
- `codex_goal_accounts_relogin_instructions`: generate safe relogin commands
  for a stored job account slot by `jobId`.

Lifecycle tools:

- `codex_goal_recommend_next_action`: explain the safe next tool for a stored
  job.
- `codex_goal_continue`: restart a stopped safe continuation.
- `codex_goal_recover`: same safety checks, but explicitly marked as recovery.
- `codex_goal_stop`: stop a stored job's tmux worker after explicit
  confirmation. By default it allows silent-stale workers only; use `forceStop`
  only after manual review. A successful stop writes
  `<taskId>.stop-event.json` in the job root.
- `codex_goal_maintenance_pause`: planned stop for resize, deploy or host
  maintenance. It kills the tmux worker, writes `maintenance_paused` progress
  and `<taskId>.maintenance-pause.json`, but does not reconcile a synthetic
  failure result. After maintenance, use `codex_goal_continue` when the brief
  or decision reports `safeToContinue: true`.
- `codex_goal_pause`: soft pause marker for human handoff. It does not kill
  tmux or discard work.
- `codex_goal_mark_reviewed`: mark completed worker output as reviewed.
- `codex_goal_assert_single_writer`: verify that the tmux session is the only
  intended writer for that worktree.

Account pool tools:

- `codex_accounts_list_pools`: list pools under a root cache directory.
- `codex_accounts_status`: inspect a specific pool or auth root.
- `codex_accounts_relogin_instructions`: generate safe relogin commands for a
  slot without exposing token material.

Prefer the `codex_goal_accounts_*` tools when a `jobId` exists. Use the raw
`codex_accounts_*` tools only for pool discovery, manual cleanup or operating
outside a stored job.

`agent_run_watch` should be the default read-only monitor when an agent needs
to see what workers are doing. It returns normalized `RunObservationSnapshot`
objects and read-only recommendations. `codex_goal_overview` is still useful
for compact registry triage: it returns aggregate counts for running,
silent-stale, safe-to-continue, relogin-needed, manual-review and completed
jobs, plus per-job command hints and lifecycle markers. It also returns
`workspaceConflicts` and `safeToOperate`; if two potential writer jobs share
one workspace, overview blocks their continuation hints until a single writer
is chosen.

`codex_goal_brief` should be the default single-job monitor response for
agents. It returns:

- `lastProgressAt`
- `lastProgressAgeMs`
- `isStale`
- `silentStale`
- `progressStatus`
- `progressUpdatedAt`
- `progressHeartbeatAgeMs`
- `workerAlive`
- `workerSupervisorKind`
- `workerAliveReason`
- `workerProcessAlive`
- `workerFreshProgressAlive`
- `logByteLength`
- `runtimeEventsPath`
- `lastRuntimeEvent`
- `lastRuntimeEventAt`
- `lastRuntimeEventLevel`
- `currentAccount`
- `lastFailureReason`
- `recentCommands`
- `changedFiles`
- `lifecycleMarkers`
- `lifecycleMarkerTypes`
- `maintenancePaused`
- `safeToContinue`
- `hasAvailableAccount`
- `availableDedupedAccounts`
- `capacityBlockedAccounts`
- `needsHumanRelogin`
- `nextBestCommand`

`codex_goal_decision` should be the default single-job action gate. Use it
when a worker needs attention and an agent must decide whether to wait,
continue, fix accounts or stop for manual review. It is read-only and does not
start or stop tmux. Its `decision.safeToContinue` already accounts for
registry-level workspace conflicts, so agents should prefer it over checking
`brief.safeToContinue` alone before acting.

`codex_goal_handoff` should be the default handoff response. It returns a
`handoff.text` block that is safe to paste into another agent thread, plus
structured `summary`, `mcpCommands`, `reviewCommands`, `cliFallbackCommands`
and sanitized account status.

`codex_accounts_status` returns `dedupedAccountNames` and
`availableDedupedAccountNames` for worker pool inputs. If the same sanitized
identity appears in multiple slots, the deduped list keeps the newest ready
slot for that identity and leaves the older duplicate visible for manual
cleanup. Agents should use `availableDedupedAccountNames` for new worker runs
because it also excludes cooldown, quota exhausted and auth-broken slots.
Pass the job `stateRootDir` whenever you care about quota/cooldown state;
without it, account tools can validate auth files but cannot see worker
capacity records.

`codex_goal_accounts_status` also returns top-level `count`, `available`,
`hasAvailableAccount`, `summary` and an `accounts` alias for `slots`. Monitors
should prefer those fields for compact status cards instead of inferring counts
from one response shape.

For a host that keeps worker auth outside the local machine, sync only the
auth-relevant files after a manual relogin:

```sh
# optional: preview first
node scripts/ops/sync-codex-auth-to-host.mjs \
  --host <worker-host> \
  --accounts account-a,account-e \
  --local-root ~/.cache/subscription-runtime/live-codex-auth \
  --remote-root /var/data/codex-home/live-codex-auth \
  --dry-run

# apply after the dry-run looks right
node scripts/ops/sync-codex-auth-to-host.mjs \
  --host <worker-host> \
  --accounts account-a,account-e \
  --local-root ~/.cache/subscription-runtime/live-codex-auth \
  --remote-root /var/data/codex-home/live-codex-auth
```

The helper uploads `auth.json`, `models_cache.json` and `installation_id` through
a temporary remote directory and then swaps the account directory. It does not
print auth payloads and does not copy Codex sqlite state, logs, shell snapshots,
memories, plugin cache or auth backups.

When a worker result reports `capacity_unavailable` with a `recoveryHint`
mentioning `auth-stale`, treat it as a stale or missing per-account auth root,
not as a code failure. Run account diagnostics, relogin the affected slot on the
machine that can complete browser auth, run the sync helper above for exactly
the affected accounts, then retry the worker. Use the host's actual auth root
when it is not `/var/data/codex-home/live-codex-auth`.

`codex_accounts_list_pools` also accepts `stateRootDir`. Use it when choosing
between pools for a specific job. Its response includes `capacityAware` so an
agent can tell whether capacity records were considered.

Prompt templates:

- `start_codex_goal_worker`
- `monitor_codex_goal_worker`
- `recover_codex_goal_worker`
- `handoff_codex_goal_job`
- `review_worker_changes`

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
  "reasoningEffort": "high",
  "serviceTier": "fast",
  "taskTimeoutMs": 259200000,
  "maxAccountCycles": 5,
  "confirmStart": true
}
```

The same input can be stored in a JSON file and passed as `configPath`. Tool
arguments override matching config file fields. This is the recommended handoff
shape for another agent because the agent only needs the config path plus
occasional overrides.

Recommended agent loop:

1. Call `agent_run_watch` first when you need pure observation of what workers
   are doing. Use `--include-log-tail` and `--include-changed-files` only when
   the extra data is needed. Call `codex_goal_overview` for compact registry
   triage. Use `codex_goal_reconcile_preview` only when a registrar wants a
   one-shot reconciliation preview; keep it dry-run unless the run is explicitly
   allowed to continue safe jobs. Call
   `codex_goal_brief` when a specific `jobId` needs monitoring.
   If `overview.safeToOperate` is false, resolve `overview.workspaceConflicts`
   before starting or continuing any writer.
   Call `codex_goal_decision` when the job needs action. Follow
   `decision.checklist` and `decision.nextBestCommand`; do not continue when
   `decision.severity` is `blocked` or `critical`.

   CLI fallback examples:

   ```bash
   subscription-runtime-codex-goal run-watch <jobId> --provider codex --include-log-tail --include-changed-files --json
   subscription-runtime-codex-goal run-watch <runId> --provider claude --state-root <runtime-state-dir> --include-log-tail --include-changed-files --json
   ```

   Lead-agent watch use-case:

   ```bash
   watch_json="$(
     subscription-runtime-codex-goal run-watch "$run_id" \
       --provider claude \
       --state-root "$runtime_state_dir" \
       --include-log-tail \
       --include-changed-files \
       --json
   )"

   decision="$(printf '%s' "$watch_json" | jq -r '.snapshots[0].readOnlyDecision.kind')"
   ```

   Interpret the read-only decision without taking action inside watch:

   - `keep_watching`: worker is still running or still has fresh progress.
     Continue polling. Do not start a second writer for the same workspace.
   - `review_completed`: run is terminal and clean enough to review. Inspect
     output, changed files and artifacts before merging or reporting success.
   - `manual_review_required`: the run reached a terminal or ambiguous state
     that needs human or registrar inspection. Read `manualReviewReasons`,
     `result.reason`, `warnings` and log tail.
   - `capacity_blocked`: account/session/capacity is unavailable. Do not
     auto-retry in a tight loop. Relogin, provide a token, or wait for cooldown.
   - `stale_needs_inspection`: heartbeat or log freshness is stale. Inspect
     process/session state before deciding whether another control layer should
     stop or recover it.
   - `unsafe_state_mismatch`: observation sources disagree. Treat it as a
     safety stop for automation and inspect the run directory manually.

   Claude worker success-path smoke requires an explicit OAuth token. The
   worker does not silently borrow the interactive Claude profile.

   ```bash
   export CLAUDE_CODE_OAUTH_TOKEN=...
   export CLAUDE_RUNTIME_DIST_DIR=/path/to/test-claude-runtime/dist
   CLAUDE_WORKER_SMOKE_MODE=single npm run smoke:worker-claude
   ```

   Claude worker smoke uses `claude-runtime` as the required Claude Code
   execution path. It does not fall back to `claude -p`. Set
   `CLAUDE_RUNTIME_DIST_DIR=/path/to/test-claude-runtime/dist` when testing
   against a local source checkout that is not installed as a package.

   The single-worker smoke now verifies both the real Claude worker result and
   the durable watch artifacts: `progress`, `result`, log tail and
   `readOnlyDecision`. When runtime startup fails, watch surfaces the redacted
   diagnostic in `snapshots[].result.details.runtimeMessage`.

   CLI fallback:

   ```bash
   subscription-runtime-codex-goal run-watch [jobId] --provider codex --include-log-tail --tail-lines 20 --include-changed-files --json
   ```

   Claude worker artifact fallback:

   ```bash
   subscription-runtime-codex-goal run-watch [runId] --provider claude --state-root <runtime-state-dir> --include-log-tail --include-changed-files --json
   ```

   Reconcile-preview fallback:

   ```bash
   subscription-runtime-codex-goal reconcile-preview --registry-root <dir>
   ```
   To let parked capacity jobs wake without a human loop, run the same command
   from a cron or systemd timer with `--continue-safe-jobs`. The preview uses
   the stored brief/overview gate, respects `continueAfter` cooldowns, and only
   starts jobs whose `brief.safeToContinue` is true.

   ```bash
   subscription-runtime-codex-goal reconcile-preview --registry-root <dir> --continue-safe-jobs
   ```
2. If `recommendedAction` is `wait_for_worker`, do not start another writer in
   that worktree while `brief.silentStale` is false.
3. If `brief.silentStale` is true, inspect tmux, process tree, app-server,
   recent log tail and git status. If it is truly stuck, call
   `codex_goal_stop({ jobId, confirmStop: true })` before recovery and preserve
   the generated stop-event JSON.
   Check `brief.lifecycleMarkers` first: it shows sanitized pause, review and
   stop-event markers that explain recent operator actions without opening
   jobRootDir manually.
   Also check `brief.progressUpdatedAt` and `brief.progressHeartbeatAgeMs`.
   Fresh progress means a quiet stdout/log is not enough evidence to stop.
4. If `brief.hasAvailableAccount` is false, do not continue. Use
   `codex_goal_accounts_status`, then ask for relogin or wait for cooldown.
5. If `recommendedAction` is `start_worker`, use `codex_goal_continue` for
   stored jobs, or `codex_goal_dry_run` then `codex_goal_start` for direct
   launch config.
6. If it is `continue_after_capacity` or `continue_after_timeout`, restart the
   same task with the same prompt, task id, workspace and account pool only
   when `brief.safeToContinue` is true.
7. If it is `inspect_dirty_workspace` or `inspect_dirty_failure`, inspect the
   diff and log before retrying.
8. Use `codex_accounts_status` before asking a human to relogin slots.

### Agent recipes by task type

Long coding or refactor task:

1. Create one job per worktree with `codex_goal_create_job`.
2. Use `codex_goal_overview` for pool-level checks and `codex_goal_brief` for
   the specific job that needs action.
3. Use `codex_goal_brief` as the only periodic single-job monitor unless it asks for
   another tool.
4. Continue only on `brief.safeToContinue === true`.
5. On completion, inspect git diff and tests before `codex_goal_mark_reviewed`.

Benchmark improvement task:

1. Put targeted slice commands in the prompt.
2. Tell the worker not to run full benchmarks repeatedly.
3. Monitor with `codex_goal_brief`; use `recentCommands` to detect accidental
   full-benchmark loops.
4. Full benchmark should be a deliberate final verification, not the main loop.

Parallel worker split:

1. Create separate git worktrees and separate `jobId`s.
2. Give each job a focused prompt and its own tmux session.
3. Start production worker-pool jobs through `codex_goal_create_job` plus
   `codex_goal_continue`, or through `codex_goal_start` with full launch config.
   Do not hand-roll `tmux new-session ... codex-goal run --no-tmux` for pooled
   workers. `--no-tmux` is the inner runner command used by the official
   launcher, or a foreground debug mode when the caller accepts direct-process
   ownership.
4. Never run two writer workers in one worktree.
5. Integrate only after each worker has focused verification and a stable
   handoff, patch or commit candidate. For strict `isolated_workspace_write`
   linked worktrees, prefer handoff or patch and let the controller create the
   commit through the Project Integration lifecycle. Worker-local commits are
   appropriate only when the workspace is commit-capable, for example an
   isolated clone with its own writable `.git` directory.

Read-only or analysis task:

1. Usually do not use the pool workflow.
2. If a long read-only task still needs a worker, set a read-only permission
   mode and require a clean worktree before start.

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

Merge only after each worker has a stable handoff, patch or commit candidate
with focused verification. Do not require sandboxed linked-worktree workers to
run `git add` or `git commit`; those operations may need shared `.git` metadata
outside the writable workspace.

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
  maxAccountCycles: Number(process.env.SUBSCRIPTION_RUNTIME_MAX_ACCOUNT_CYCLES ?? 5),
  accounts: accountNames.map((accountName, index) => ({
    codexAuthJsonPath: join(authRoot, accountName, "auth.json"),
    worker: {
      providerInstanceId: `${taskId}-${accountName}`,
      stateRootDir,
      codexBinaryPath: process.env.CODEX_BINARY_PATH ?? "codex",
      model: process.env.CODEX_MODEL ?? "gpt-5.5",
      reasoningEffort: process.env.CODEX_REASONING_EFFORT ?? "high",
      serviceTier: process.env.CODEX_SERVICE_TIER ?? "fast",
      executionEngine: "app-server-goal",
      encryptionKey,
      taskTimeoutMs,
      capacityAccountId: accountName,
      capacityPolicy: {
        quotaCooldownMs: 15 * 60 * 1000,
        reconnectCooldownMs: 15 * 60 * 1000,
        maxReconnectRetriesPerAccount: 4,
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
    controls: { editMode: "allow-edits" },
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
    CODEX_REASONING_EFFORT=high \
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
cat ~/.cache/subscription-runtime/my-job/my-task-001.progress.json
ls -l ~/.cache/subscription-runtime/my-job/my-task-001.latest-result.json
node ~/.cache/subscription-runtime/my-job/check-codex-accounts.mjs
```

Healthy signs:

- tmux pane is alive;
- `run-goal.mjs` is a child of the pane shell;
- an app-server process exists for the active attempt;
- `<task-id>.progress.json` has a fresh `updatedAt` heartbeat;
- the worktree is either clean at start or has expected WIP;
- files change over time, or the app-server has CPU activity;
- result JSON is absent while running or has a recent terminal summary after
  completion.

Quiet logs are not always bad. The app-server goal path often writes the final
summary only when the attempt finishes. A fresh progress heartbeat is stronger
evidence than stdout silence.

For registry operations, prefer `codex_goal_brief`, `codex_goal_decision` or
`codex_goal_overview` over manual tmux checks. These commands normalize
`workerAlive` from tmux, pid/process and fresh running progress, so old terminal
results from previous attempts do not hide an observable current attempt.

## Restart policy

Do not restart just because output is quiet.

Restart or continue only when evidence shows:

- runner process exited;
- tmux pane died;
- result JSON says capacity/auth/reconnect failure;
- no fresh progress heartbeat, no file changes, no CPU, no result and no active
  app-server for a long window;
- account pool changed and the old attempt cannot continue.

Never restart through a workspace conflict. If `codex_goal_overview` reports
`workspaceConflicts`, choose one writer job first, then continue only that job.

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
| `runtime_interrupted` | Runtime intentionally stopped an active attempt for safe guidance | Continue through the generated packet, preserving WIP |
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
Effort: high
Service tier: fast
Execution engine: app-server-goal
Do not run two writers in the same worktree.
If quota/capacity/auth/reconnect happens, use pool continuation.
If unknown/runtime/test failure happens, inspect dirty work before retry.
```
