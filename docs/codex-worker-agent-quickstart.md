# Codex Worker Agent Quickstart

Use this when an agent needs to operate subscription-runtime Codex `/goal`
workers with minimal prior context.

## MCP setup

Prefer MCP for agents:

```json
{
  "mcpServers": {
    "subscription-runtime-codex-goal": {
      "command": "node",
      "args": [
        "/Users/belief/dev/projects/subscription-runtime/dist/worker-codex/codex-goal-mcp.js"
      ],
      "cwd": "/Users/belief/dev/projects/subscription-runtime"
    }
  }
}
```

If the package binary is installed in PATH, this is also valid:

```json
{
  "mcpServers": {
    "subscription-runtime-codex-goal": {
      "command": "subscription-runtime-codex-goal-mcp"
    }
  }
}
```

Make sure `npm run build` has been run after source changes.

For Codex CLI/Desktop user config, this server can be installed with:

```sh
codex mcp add subscription-runtime-codex-goal -- "$(command -v node)" /Users/belief/dev/projects/subscription-runtime/dist/worker-codex/codex-goal-mcp.js
codex mcp get subscription-runtime-codex-goal
```

If native MCP tools do not appear in a Codex thread, use the CLI fallback. It
calls the same MCP server in-process through the SDK and exposes the same tool
surface:

```sh
subscription-runtime-codex-goal doctor-control
subscription-runtime-codex-goal tools
subscription-runtime-codex-goal overview
subscription-runtime-codex-goal brief my-task
subscription-runtime-codex-goal decision my-task
subscription-runtime-codex-goal handoff my-task
subscription-runtime-codex-goal accounts my-task
subscription-runtime-codex-goal stop-job my-task --confirm
subscription-runtime-codex-goal maintenance-pause-job my-task --confirm --reason resize
subscription-runtime-codex-goal tool codex_goal_brief --args-json '{"jobId":"my-task"}'
subscription-runtime-codex-goal tool codex_goal_accounts_status --args-json '{"jobId":"my-task"}'
subscription-runtime-codex-goal tool codex_goal_continue --args-json '{"jobId":"my-task","confirmContinue":true}'
```

## Default loop

1. Get the `jobId`.
2. For multiple jobs or unknown state, call `codex_goal_overview()`.
   If `overview.safeToOperate === false` or `workspaceConflicts` is non-empty,
   stop and resolve the single-writer conflict before continuing any job.
3. Call `codex_goal_get_job({ jobId })`.
4. Call `codex_goal_brief({ jobId })`.
5. Call `codex_goal_decision({ jobId })` when you need to act. It returns
   `decision.action`, `decision.severity`, `decision.blockers`, `decision.evidence`,
   `decision.checklist` and `decision.nextBestCommand`.
6. For handoff, call `codex_goal_handoff({ jobId })` and pass its `text`.
7. If the worker is alive, do not start another writer. Monitor later.
8. If `brief.silentStale === true`, inspect tmux, process tree, app-server,
   recent log tail and git status. If it is truly stuck, call
   `codex_goal_stop({ jobId, confirmStop: true })` before recovery. Successful
   stops write `<taskId>.stop-event.json` in the job root.
   For planned resize, deploy or host maintenance, prefer
   `codex_goal_maintenance_pause({ jobId, confirmPause: true, reason })`.
   It writes `maintenance_paused` progress and avoids synthetic failure
   reconciliation before the next continue.
   `brief.lifecycleMarkers` and `codex_goal_overview.jobs[].lifecycleMarkers`
   show existing pause, review and stop markers so agents do not have to inspect
   jobRootDir by hand.
   Prefer `brief.progressUpdatedAt` and `brief.progressHeartbeatAgeMs` over
   stdout silence when deciding whether a worker is actually stale.
   If stdout log is empty, inspect `brief.runtimeEventsPath`,
   `brief.lastRuntimeEvent` and `brief.lastRuntimeEventAt`.
9. If `brief.safeToContinue === true`, call
   `codex_goal_continue({ jobId, confirmContinue: true })`.
10. If `brief.hasAvailableAccount === false`, call
   `codex_goal_accounts_status({ jobId })`.
11. If account status shows invalid auth, call
   `codex_goal_accounts_relogin_instructions({ jobId, account })` and ask the
   human to login.
12. If the status is dirty, provider output invalid, unknown runtime, test
   failure or benchmark failure, inspect the worktree and logs manually before
   retrying.
13. After completion, review diff and verification evidence, then call
   `codex_goal_mark_reviewed({ jobId })`.

## Starting a new job

Use exact Codex model IDs. GPT-5.6 Sol is `gpt-5.6-sol`, not `gpt-5.6`, and
requires Codex CLI `0.144.0` or newer. Availability remains account-specific;
on a model rejection, the app-server runtime reports the current account's
`model/list` catalog instead of silently selecting another model.

Create one stored job per logical goal and per writer worktree:

```json
{
  "jobId": "my-task",
  "description": "Short goal description",
  "jobRootDir": "/Users/belief/.cache/subscription-runtime/my-task",
  "authRootDir": "/Users/belief/.cache/subscription-runtime/live-codex-auth",
  "stateRootDir": "/Users/belief/.cache/subscription-runtime/my-task/state",
  "workspacePath": "/path/to/project-worktree",
  "promptPath": "/Users/belief/.cache/subscription-runtime/my-task/prompt.md",
  "taskId": "my-task",
  "progressPath": "/Users/belief/.cache/subscription-runtime/my-task/my-task.progress.json",
  "progressHeartbeatMs": 60000,
  "accounts": ["account-a", "account-b", "account-c"],
  "tmuxSession": "my-task",
  "model": "gpt-5.5",
  "reasoningEffort": "high",
  "serviceTier": "default",
  "executionEngine": "app-server-goal",
  "taskTimeoutMs": 259200000,
  "appServerStartupTimeoutMs": 120000,
  "maxAccountCycles": 5,
  "accessBoundary": "isolated_workspace_write",
  "projectAccessScope": {
    "projectId": "my-project",
    "workspaceRoots": ["/path/to/project-worktree"],
    "jobIdPrefixes": ["my-task"],
    "tmuxSessionPrefixes": ["my-task"],
    "allowedBranches": ["main"],
    "allowedGitRemotes": ["origin"]
  },
  "networkAccess": "restricted"
}
```

`accessBoundary` is the runtime contract. `providerSandboxMode` is only the
low-level Codex sandbox selector. Do not use provider `danger-full-access`
unless the job uses `accessBoundary: "danger_full_access"` with an explicit
emergency acknowledgement.

Then call:

```txt
codex_goal_create_job(...)
codex_goal_overview()
codex_goal_brief({ jobId: "my-task" })
codex_goal_decision({ jobId: "my-task" })
codex_goal_continue({ jobId: "my-task", confirmContinue: true })
```

Without native MCP, call the same tools through the CLI:

```sh
subscription-runtime-codex-goal tool codex_goal_create_job --args-file job.json
subscription-runtime-codex-goal overview
subscription-runtime-codex-goal brief my-task
subscription-runtime-codex-goal decision my-task
subscription-runtime-codex-goal handoff my-task
subscription-runtime-codex-goal continue-job my-task --confirm
```

## Project-scoped controller jobs

Use `accessBoundary: "project_scoped_control"` only for a controller manifest
that coordinates scoped project work through broker tools. Do not run it as a
normal Codex writer with `codex_goal_continue`; ordinary launches fail closed
because raw shell cannot enforce project-scoped control.

The manifest is not a live LLM orchestrator. It does not schedule workers or call
broker tools by itself. Treat it as the scoped identity and policy anchor that a
host-side boss, daemon, MCP/CLI/SDK caller or future restricted LLM launcher uses
when making broker calls.

If status says a `project_scoped_control` controller manifest exists but no LLM
orchestrator process is running, that can be a valid state. To get autonomous
reasoning, start only a launcher that can hide raw shell, raw tmux, raw git,
direct registry writes and auth roots while exposing read-only status plus
`codex_goal_project_*` tools. If that launcher is unavailable, keep the boss or
host supervisor calling broker tools directly. Never switch the controller to
`danger_full_access` just to make it "alive".

Before starting a live LLM controller, build the controlled-agent launch plan:

```txt
codex_goal_project_controller_launch_plan({ controllerJobId, registryRootDir, providerKind })
codex_goal_project_controller_status({ controllerJobId, registryRootDir, providerKind })
codex_goal_project_controller_start({ controllerJobId, registryRootDir, providerKind })
codex_goal_project_controller_consume_guidance({ controllerJobId, registryRootDir })
codex_goal_project_controller_stop({ controllerJobId, registryRootDir, providerKind, reason })
codex_goal_project_controller_reconcile({ controllerJobId, registryRootDir, providerKind })
codex_goal_project_refill_worker({ controllerJobId, sourceWorkspacePath, baseBranch, promptBody, confirmRefill: true })
```

Use the CLI fallback for launch plans, status reads and diagnostics only. The
CLI fallback command `subscription-runtime-codex-goal tool
codex_goal_project_controller_start` is deliberately blocked because it uses a
one-shot in-process MCP server and cannot keep the provider runner attached
after the command exits. Start live controllers only from the host supervisor,
daemon, native MCP server or SDK process that will continue owning `status`,
`stop` and `reconcile`. For a durable CLI-owned controller process, use:

```sh
subscription-runtime-codex-goal controller-supervise \
  --controller-job-id infinity-context-project-controller-v1 \
  --registry-root /var/data/infinity-context/worker-jobs/registry \
  --provider codex \
  --status-interval-ms 60000 \
  --format json
```

`controller-supervise` keeps the in-process MCP server and provider runner alive
for the lifetime of the process. It starts through the same
`codex_goal_project_controller_start` policy path, polls status, reconciles and
exits when provider status becomes terminal, and stops the controlled provider
on SIGINT/SIGTERM. Do not replace it with
`danger_full_access` if a one-shot start fails.

Status responses include `liveController`. Treat `providerRunnerAttached=false`
or `ownerMatches=false` as "manifest/state exists, but this process does not own
the live LLM controller". If `providerObservedStatus` is present and not
`running`, the controller is not live even when the provider runner is still
attached before reconcile updates persisted state.

The Codex controlled-agent profile disables native app-server environments and
keeps only the configured broker/status MCP surface. If a profile can only add
deny rules around raw shell, the launch plan returns blocked with
`provider_cannot_disable_raw_shell`. That is not a bug. A live controller may be
started only when the provider adapter can enforce broker-only tools without
raw shell access. The launch-plan output includes the exact allowed MCP tools,
generated Codex profile preview and safe evidence; it does not start an LLM
process.

`codex_goal_project_controller_start` is also fail-closed. For Codex it starts
the app-server controlled-agent provider only after the launch plan is ready,
the controller scope includes `projectAccessScope.authRoot`, and at least one
configured account is ready and allowed. The runtime reads `auth.json` only
host-side to build a `SessionArtifact`; the LLM never receives auth payloads.
The controller job `prompt.md` is passed into the live controller task as the
project objective, not only kept as manifest metadata. For smoke tests only,
`maxGoalTurns` may be supplied to the start tool to bound a tiny controller
slice; production controllers normally omit it and are stopped through the safe
provider runner.

For Claude, pass `providerKind: "claude"` and a `sessionArtifactPath` to
`codex_goal_project_controller_start`. The session artifact path must resolve
inside `projectAccessScope.authRoot`; symlink escapes are rejected. The runtime
wraps that file as a Claude `SessionArtifact` host-side and starts the Claude
controlled-agent provider with strict MCP broker tools. A
`project_scoped_control` manifest by itself is not a live LLM process.
`status` reads persisted controlled-agent session/run state and, when the
provider is still attached in this MCP process, also reports provider liveness.
`stop` and `reconcile` use the same provider adapter. If a different process
tries to stop/reconcile a persisted run without the in-memory provider instance,
it returns `controlled_agent_provider_runner_not_connected` instead of guessing
or using `danger_full_access`.

Claude has the same controlled provider shape through the controlled-agent
lifecycle. Its CLI profile uses strict MCP config, broker/status MCP tools in
`allowedTools`, and raw host tools such as Bash, Edit, Write, Read, WebFetch,
WebSearch and Task in `disallowedTools`. A live Claude controller still needs a
valid Claude session artifact; if session wiring or account state is missing,
the adapter must fail closed instead of falling back to raw shell or
`danger_full_access`.

Controller manifest requirements:

- `accessBoundary: "project_scoped_control"`;
- `networkAccess: "restricted"`;
- `projectAccessScope.registryRoot` points at the worker registry;
- `projectAccessScope.authRoot` equals the controller job `authRootDir`;
- `workspaceRoots` and `worktreeRoots` include only this project's roots;
- `jobIdPrefixes` and `tmuxSessionPrefixes` are project-specific;
- `allowedBranches`, `allowedGitRemotes` and optional `allowedAccountIds` are
  explicitly scoped;
- never set `allowDangerFullAccess` for a controller or child job.

Controller actions must use brokered MCP tools:

```txt
codex_goal_project_create_worktree({ controllerJobId, ... })
codex_goal_project_create_job({ controllerJobId, ... })
codex_goal_project_refill_worker({ controllerJobId, sourceWorkspacePath, baseBranch, promptBody, confirmRefill: true })
codex_goal_project_controller_launch_plan({ controllerJobId, ... })
codex_goal_project_controller_status({ controllerJobId, ... })
codex_goal_project_start({ controllerJobId, jobId, confirmStart: true })
codex_goal_project_mark_reviewed({ controllerJobId, jobId })
codex_goal_project_open_integration_attempt({ controllerJobId, ... })
codex_goal_project_apply_worker_output({ controllerJobId, attemptId, ... })
codex_goal_project_run_required_checks({ controllerJobId, attemptId, ... })
codex_goal_project_commit_approved_changes({ controllerJobId, attemptId, ... })
codex_goal_project_push_approved_commit({ controllerJobId, attemptId, ... })
codex_goal_project_reject_integration_attempt({ controllerJobId, attemptId, ... })
```

Child jobs created by `codex_goal_project_create_job` inherit a narrowed scope
from the controller. They default to
`accessBoundary: "isolated_workspace_write"` and cannot request
`project_scoped_control` or `danger_full_access` through the controller path.

For capacity refill, prefer `codex_goal_project_refill_worker` over the manual
`create_worktree -> write prompt -> create_job -> start` sequence. The helper
creates a scoped worktree, writes the prompt inside the child job root, creates
the child manifest, starts it unless `startWorker: false`, and records the
broker audit trail for controller adoption. The caller still supplies the
controlled task identity, including `jobId`, `workspacePath`, `sourceWorkspacePath`
and `promptBody`; the helper does not invent product work by itself.
`workerRole` is capacity taxonomy only: `producer`, `fastgate` or `reviewer`.
New children default to `reasoningEffort: "high"` and `serviceTier: "default"`
unless the caller supplies a more specific child manifest value.

These child jobs should normally produce a diff, patch or handoff, not their own
commit. In a linked git worktree, `git add` and `git commit` can require writes
to common `.git` metadata outside the child workspace, so a strict sandbox may
deny the commit even after edits and tests succeeded. That is expected. Preserve
the diff and let the project controller integrate through the Project
Integration lifecycle. Use worker-local commits only for a commit-capable
isolated clone whose `.git` directory is inside the writable workspace.

## Recovery rules

- quota, capacity, auth broken or reconnect: use the pool continuation path;
- no available accounts: use `codex_goal_accounts_status`, then relogin or
  wait for cooldown;
- `brief.silentStale === true`: worker is alive but has no fresh observable
  progress; inspect tmux/process/log/worktree, then use `codex_goal_stop`
  before recovery if it is truly stuck; keep the generated stop-event JSON as
  the audit trail;
- `brief.lifecycleMarkers` shows sanitized pause, review and stop-event markers
  for the job. Treat them as operator context, not as token-bearing logs;
- `brief.progressUpdatedAt` comes from the runner heartbeat and may be fresh
  even when stdout is quiet. Treat a quiet log as stale only when progress,
  result and process evidence are all stale;
- `overview.workspaceConflicts` means multiple stored jobs can write to the
  same workspace. Do not continue either job until one writer is chosen;
- provider output invalid, unknown runtime, code failure, test failure or
  benchmark failure: do not switch accounts automatically;
- dirty worktree means the next attempt must understand it is mid-task;
- never run two writer workers in one worktree;
- never print `auth.json`, access tokens, refresh tokens, id tokens or raw
  provider payloads.

## Flexible integrations

Use tools in this order:

1. Native MCP tools for agents.
2. CLI MCP fallback: `subscription-runtime-codex-goal tool <name>`.
3. CLI direct run/status commands for shell/tmux scripts.
4. `runCodexGoal()` TypeScript API for host apps that own scheduling or UI.
5. `FileBackendCodexSafeExecutor` only for advanced custom account or policy
   control.

Direct API integrations must preserve the same safety gates:
`safeToContinue`, single writer, capacity-aware account status and manual
inspection for unknown or dirty failures.

For full details, read `docs/codex-worker-pool-operations.md`.
