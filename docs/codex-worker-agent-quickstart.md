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
  "serviceTier": "fast",
  "executionEngine": "app-server-goal",
  "taskTimeoutMs": 259200000,
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

Controller manifest requirements:

- `accessBoundary: "project_scoped_control"`;
- `networkAccess: "restricted"`;
- `projectAccessScope.registryRoot` points at the worker registry;
- `workspaceRoots` and `worktreeRoots` include only this project's roots;
- `jobIdPrefixes` and `tmuxSessionPrefixes` are project-specific;
- `allowedBranches`, `allowedGitRemotes` and optional `allowedAccountIds` are
  explicitly scoped;
- never set `allowDangerFullAccess` for a controller or child job.

Controller actions must use brokered MCP tools:

```txt
codex_goal_project_create_worktree({ controllerJobId, ... })
codex_goal_project_create_job({ controllerJobId, ... })
codex_goal_project_start({ controllerJobId, jobId, confirmStart: true })
codex_goal_project_mark_reviewed({ controllerJobId, jobId })
codex_goal_project_integrate_commit({ controllerJobId, ... })
codex_goal_project_push_branch({ controllerJobId, ... })
```

Child jobs created by `codex_goal_project_create_job` inherit a narrowed scope
from the controller. They default to
`accessBoundary: "isolated_workspace_write"` and cannot request
`project_scoped_control` or `danger_full_access` through the controller path.

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
