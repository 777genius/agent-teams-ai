---
title: Troubleshooting – Agent Teams Docs
description: Fix team launch issues, missing agent replies, rate limits, CLI auth problems, and lane bootstrap stalls with local diagnostics.
---

# Troubleshooting

Most team issues fall into one of four buckets: runtime setup, launch confirmation, task parsing, and provider limits.

## Team does not launch

Check each item in order:

1. **Runtime available** — the selected CLI (`claude`, `codex`, `opencode`) is installed
2. **PATH reachable** — the binary is available in the environment `PATH`
3. **Model access** — the provider has access to the requested model string (especially for OpenCode, exact provider/model names matter)
4. **Project path** — the project directory exists and is readable
5. **Network / VPN** — some providers drop traffic when a VPN is active

::: tip
Run the runtime binary in a terminal to verify `PATH` and auth. Example: `claude --version` or `opencode --version`.
:::

### OpenCode: registered but bootstrap unconfirmed

If OpenCode shows `registered` but bootstrap is unconfirmed, inspect artifacts first before changing team prompts.

Contributor/debugging details live in [Contributor Architecture](/reference/contributor-architecture), which links to the canonical agent team debugging runbook.

Look at the newest launch failure artifact:

```bash
~/.claude/teams/<team>/launch-failure-artifacts/latest.json
```

The manifest inside includes:

- `classification` — why the launch was considered a failure
- `bootstrapTransportBreadcrumb` — delivery path used
- Member spawn statuses
- Redacted logs and traces

Also check the lane manifest:

```bash
jq '.lanes' ~/.claude/teams/<team>/.opencode-runtime/lanes.json
jq '.activeRunId, .entries' ~/.claude/teams/<team>/.opencode-runtime/lanes/<lane>/manifest.json
```

::: tip Do not guess from the UI
Always correlate UI diagnostics with persisted files (`launch-state.json`, `bootstrap-journal.jsonl`) and runtime-specific evidence.
:::

## General diagnostics

Start with persisted files on disk rather than the UI alone.

### Team root

```bash
~/.claude/teams/<team>/
```

Key files and what they tell you:

- `launch-state.json` — member launch/liveness state (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — ordered bootstrap events from CLI/runtime (`tail -80`)
- `bootstrap-state.json` — bootstrap phase summary
- `config.json` — provider, model, and project configuration
- `inboxes/*.json` and `sentMessages.json` — message delivery state

```bash
jq '.teamLaunchState, .summary, .members' ~/.claude/teams/<team>/launch-state.json
tail -80 ~/.claude/teams/<team>/bootstrap-journal.jsonl 2>/dev/null
```

### OpenCode runtime evidence

For OpenCode teammates, session proof is in the lane runtime store:

- `.opencode-runtime/lanes.json` — lane index with state
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` and evidence entries
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — committed session records

Expected healthy state: lane state `active`, manifest has `activeRunId` with at least one evidence entry, member has `bootstrapConfirmed: true`.

```bash
jq '.lanes' ~/.claude/teams/<team>/.opencode-runtime/lanes.json 2>/dev/null
find ~/.claude/teams/<team>/.opencode-runtime -maxdepth 3 -type f | sort
```

### Launch failure artifacts

When a launch is marked as a failure, inspect `latest.json`:

```bash
~/.claude/teams/<team>/launch-failure-artifacts/latest.json
```

The manifest includes:
- `classification` — why the launch was considered a failure
- `bootstrapTransportBreadcrumb` — delivery path used
- Member spawn statuses and redacted logs/traces

## Agent replies are missing

Open task logs and teammate messages. Missing replies often come from:

- **Runtime delivery retry** — the agent may have answered, but the message was not delivered to the app. Check the delivery ledger.
- **Parsing or filtering** — the agent output did not include expected markers or task references.
- **Task attribution** — the work happened during the session but was not linked to the task because the correct task id was missing from the output.

::: warning Do not assume silence means ignoring
Do not assume the model ignored the message until logs confirm it.
:::

## Tasks are not linked to changes

Use task-specific logs and code review links. If a diff appears detached:

- Check whether the task id or task reference was included in the agent output.
- Verify the agent called `task_add_comment` before making edits.
- Ensure the agent called `task_start` so the board knows work began.

For OpenCode teammates, the authoritative proof that a session belongs to a task is in `opencode-sessions.json` and the lane manifest entry, not only the UI message stream.

## Rate limits

If a provider reports a known reset time, Agent Teams can nudge the lead to continue after cooldown. If reset time is unknown, wait or switch provider/runtime path.

| Provider behavior | Suggested action |
| --- | --- |
| Known reset time displayed | Wait for cooldown and continue |
| No reset time shown | Switch provider or runtime path |
| Repeated 429s | Lower concurrency or use a different model lane |

## CLI auth issues

### `claude login` does not persist

If the CLI is authenticated in one terminal but the app says it is not, verify the auth is saved to the expected config path and that the app process sees the same `$HOME`.

### OpenCode provider key rejected

- Double-check the provider name in `config.json` matches the provider prefix in the model string
- Ensure the key is not expired or revoked in the provider dashboard

### Auth diagnostic log

Each call to `CliInstallerService.getStatus()` appends one line to `claude-cli-auth-diag.ndjson` in the Electron log folder (usually `~/Library/Logs/<product-name>/` on macOS). If the file exceeds **512 KiB**, it is truncated to empty before the next write.

Check this file if you see "Not logged in" or auth errors in the packaged app.

## Lane bootstrap stuck

For OpenCode secondary lanes:

- A missing `inboxes/<member>.json` is not automatically a bug. OpenCode lanes do not have to be primary-inbox-created before they start.
- If the UI shows the team still launching while primary members are already usable, "all teammates joined" is waiting for secondary lanes.
- If `Prepared communication channels for X/Y members` hangs, verify whether `Y` incorrectly includes secondary OpenCode members.

### Lane manifest empty entries

If the bridge says bootstrap succeeded but `manifest.json` shows `entries: []`, the issue is **evidence commit**, not model behavior. The member must not be considered deliverable until `opencode-sessions.json` and its manifest entry exist.

## Common member states

| State | Meaning |
| --- | --- |
| `confirmed_alive` + `bootstrapConfirmed` | Healthy and ready |
| `registered` / `runtime_pending_bootstrap` | Process or lane exists, but bootstrap proof has not been committed yet |
| `failed_to_start` + `runtime_process` | Process exists, but launch gate failed. Check diagnostics |
| `failed_to_start` + `stale_metadata` | Saved pid/session is stale or dead |

::: warning
`member_briefing` by itself is NOT runtime evidence. For OpenCode, authoritative proof is committed runtime evidence such as `opencode-sessions.json` and the manifest entry.
:::

## Runtime debug mode

For local debugging, you can force teammates to run in tmux panes:

```bash
# Launch from a terminal
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev

# Or add to custom CLI args
--teammate-mode tmux
```

Use this to inspect interactive CLI behavior. Do not consider this fully equivalent to the process backend.

## Safe cleanup

When cleaning up stale processes:

1. Identify the pid and confirm it belongs to the current team / lane.
2. Stop only processes explicitly belonging to a smoke test or the launch you are debugging.
3. **Do not kill** all OpenCode or shared host processes as a shortcut.

## When to collect evidence

Before asking for help, collect:

- Task id (short or full)
- Team name
- Runtime path (`claude`, `codex`, or `opencode`)
- Launch log excerpt (from `latest.json` or `bootstrap-journal.jsonl`)
- Provider / model string
- Exact time window when the issue occurred

This data is usually enough to debug launch and task lifecycle issues.

::: tip
If the issue persists, open the team's persisted files under `~/.claude/teams/<teamName>/` and correlate UI diagnostics with the live process state before changing code.
:::
