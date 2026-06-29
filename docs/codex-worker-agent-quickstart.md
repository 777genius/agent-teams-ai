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

## Default loop

1. Get the `jobId`.
2. Call `codex_goal_get_job({ jobId })`.
3. Call `codex_goal_brief({ jobId })`.
4. If the worker is alive, do not start another writer. Monitor later.
5. If `brief.safeToContinue === true`, call
   `codex_goal_continue({ jobId, confirmContinue: true })`.
6. If `brief.hasAvailableAccount === false`, call
   `codex_goal_accounts_status({ jobId })`.
7. If account status shows invalid auth, call
   `codex_goal_accounts_relogin_instructions({ jobId, account })` and ask the
   human to login.
8. If the status is dirty, provider output invalid, unknown runtime, test
   failure or benchmark failure, inspect the worktree and logs manually before
   retrying.
9. After completion, review diff and verification evidence, then call
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
  "accounts": ["account-a", "account-b", "account-c"],
  "tmuxSession": "my-task",
  "model": "gpt-5.5",
  "reasoningEffort": "xhigh",
  "serviceTier": "fast",
  "taskTimeoutMs": 259200000,
  "maxAccountCycles": 3
}
```

Then call:

```txt
codex_goal_create_job(...)
codex_goal_brief({ jobId: "my-task" })
codex_goal_continue({ jobId: "my-task", confirmContinue: true })
```

## Recovery rules

- quota, capacity, auth broken or reconnect: use the pool continuation path;
- no available accounts: use `codex_goal_accounts_status`, then relogin or
  wait for cooldown;
- provider output invalid, unknown runtime, code failure, test failure or
  benchmark failure: do not switch accounts automatically;
- dirty worktree means the next attempt must understand it is mid-task;
- never run two writer workers in one worktree;
- never print `auth.json`, access tokens, refresh tokens, id tokens or raw
  provider payloads.

## Flexible integrations

Use tools in this order:

1. MCP tools for agents.
2. CLI `subscription-runtime-codex-goal` for shell/tmux scripts.
3. `runCodexGoal()` TypeScript API for host apps that own scheduling or UI.
4. `FileBackendCodexSafeExecutor` only for advanced custom account or policy
   control.

Direct API integrations must preserve the same safety gates:
`safeToContinue`, single writer, capacity-aware account status and manual
inspection for unknown or dirty failures.

For full details, read `docs/codex-worker-pool-operations.md`.
