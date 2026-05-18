---
title: Troubleshooting – Agent Teams Docs
description: Fix team launch issues, missing agent replies, rate limits, CLI auth problems, and lane bootstrap stalls with local diagnostics.
---

# Troubleshooting

Most team issues fall into one of four buckets: runtime setup, launch confirmation, task parsing, and provider limits.

## Quick evidence setup

For any team lifecycle issue, define these variables first and reuse the same shell:

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

Then confirm the expected files exist before interpreting UI state:

```bash
test -d "$TEAM_DIR" && find "$TEAM_DIR" -maxdepth 2 -type f | sort | sed -n '1,80p'
test -d "$TASKS_DIR" && find "$TASKS_DIR" -maxdepth 1 -name '*.json' | sort | sed -n '1,40p'
```

::: warning Evidence first
Do not fix prompts, provider settings, or process cleanup based only on a stuck badge. First correlate the UI with persisted files, launch artifacts, and runtime evidence.
:::

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
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
MANIFEST_PATH="$(jq -r '.manifestPath' "$LATEST_FAILURE")"
jq '.classification, .bootstrapTransportBreadcrumb, .memberSpawnStatuses' "$MANIFEST_PATH"
```

`latest.json` points to the newest packed artifact directory and its `manifest.json`. The manifest includes:

- `classification` — why the launch was considered a failure
- `bootstrapTransportBreadcrumb` — delivery path used
- Member spawn statuses
- Redacted logs and traces

Also check the lane manifest:

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 2 -name manifest.json -print -exec jq '.activeRunId, .entries' {} \; 2>/dev/null
```

::: tip Do not guess from the UI
Always correlate UI diagnostics with persisted files (`launch-state.json`, `bootstrap-journal.jsonl`) and runtime-specific evidence.
:::

## General diagnostics

Start with persisted files on disk rather than the UI alone.

### Team root

```bash
printf '%s\n' "$TEAM_DIR"
```

Key files and what they tell you:

- `launch-state.json` — member launch/liveness state (`.teamLaunchState`, `.summary`, `.members`)
- `bootstrap-journal.jsonl` — ordered bootstrap events from CLI/runtime (`tail -80`)
- `bootstrap-state.json` — bootstrap phase summary
- `config.json` — provider, model, and project configuration
- `inboxes/*.json` and `sentMessages.json` — message delivery state

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

### OpenCode runtime evidence

For OpenCode teammates, session proof is in the lane runtime store:

- `.opencode-runtime/lanes.json` — lane index with state
- `.opencode-runtime/lanes/<lane>/manifest.json` — `activeRunId` and evidence entries
- `.opencode-runtime/lanes/<lane>/opencode-sessions.json` — committed session records

Expected healthy state: lane state `active`, manifest has `activeRunId` with at least one evidence entry, member has `bootstrapConfirmed: true`.

```bash
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
```

### Launch failure artifacts

When a launch is marked as a failure, inspect `latest.json`:

```bash
LATEST_FAILURE="$TEAM_DIR/launch-failure-artifacts/latest.json"
jq '.' "$LATEST_FAILURE"
jq '.' "$(jq -r '.manifestPath' "$LATEST_FAILURE")"
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

Use the persisted message state to separate "not sent" from "sent but not rendered":

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

Check `from`, `to`, `messageId`, `relayOfMessageId`, and `taskRefs`. For OpenCode teammates, also inspect runtime delivery evidence before assuming the model ignored the prompt.

## Tasks are not linked to changes

Use task-specific logs and code review links. If a diff appears detached:

- Check whether the task id or task reference was included in the agent output.
- Verify the agent called `task_add_comment` before making edits.
- Ensure the agent called `task_start` so the board knows work began.

For OpenCode teammates, the authoritative proof that a session belongs to a task is in `opencode-sessions.json` and the lane manifest entry, not only the UI message stream.

### Task log triage

When a task log looks incomplete, search by task id across task JSON, inboxes, and bootstrap events:

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

Interpret the result carefully:

| Evidence | What it proves | What it does not prove |
| --- | --- | --- |
| Message delivered | The app wrote or relayed a prompt | The agent made progress |
| Task comment | The agent posted board-visible text | The comment is meaningful progress |
| Native tool rows | The runtime did work in a session | The work belongs to this task unless attribution matches |
| Change ledger entry | The app recorded file changes | The implementation is correct |

For OpenCode, a healthy task log usually includes native runtime rows like `read`, `bash`, `edit`, or `write` plus Agent Teams MCP rows. If you only see `agent-teams_*` rows, confirm task attribution and session bounds before widening log matching.

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

## Smoke checks

Use the desktop Electron app for normal validation. Browser/web dev mode does not include the full desktop runtime, IPC, provider auth, terminal, or team lifecycle behavior.

### Docs-only changes

From the repo root:

```bash
pnpm --dir landing docs:build
git diff --check -- landing/product-docs
```

### Team lifecycle changes

Start narrow, then expand:

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

### Live team smoke

Use a small team and a Git-tracked disposable project:

1. Start the desktop app with `pnpm dev`.
2. Create one lead plus one builder.
3. Ask for a tiny change with an explicit verification command.
4. Confirm the task moves `pending` -> `in_progress` -> `completed`.
5. Open task logs and verify tool rows, task comments, and file changes line up.
6. Stop only the smoke-owned team/processes when cleaning up.

::: warning Narrow cleanup only
Do not kill all OpenCode hosts, unrelated tmux panes, or user teams while cleaning up a smoke run.
:::

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
