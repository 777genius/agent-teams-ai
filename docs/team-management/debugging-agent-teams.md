# Debugging Agent Teams

Use this runbook when a team launch hangs, a teammate is marked `registered` or `failed_to_start`, messages do not appear, or OpenCode participants look online but do not answer.

## First Rule

Do not guess from the UI alone. Always correlate:
- UI diagnostics copied from the launch/member detail panel
- persisted team files under `~/.claude/teams/<teamName>/`
- live process table
- runtime-specific evidence, especially OpenCode lane manifests

## Key Files

Team root:

```bash
TEAM="<team-name>"
TEAM_DIR="$HOME/.claude/teams/$TEAM"
TASKS_DIR="$HOME/.claude/tasks/$TEAM"
```

Important files and folders:
- `config.json` - configured members, provider/model selection, project path
- `members.meta.json` - member metadata, removed members, worktree settings if present
- `launch-state.json` - current app-side truth for member launch/liveness
- `bootstrap-state.json` - bootstrap phase summary when present
- `bootstrap-journal.jsonl` - ordered bootstrap events from the CLI/runtime
- `inboxes/*.json` - durable inbox messages for user, lead, and native teammates
- `sentMessages.json` - app-side sent-message records
- `$TASKS_DIR/*.json` - task board state
- `.opencode-runtime/lanes.json` - OpenCode lane index
- `.opencode-runtime/lanes/<encoded-lane-id>/manifest.json` - lane-scoped runtime store manifest
- `.opencode-runtime/lanes/<encoded-lane-id>/opencode-sessions.json` - committed OpenCode session evidence

Quick inspection:

```bash
jq '.teamLaunchState, .summary, .members' "$TEAM_DIR/launch-state.json"
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime" -maxdepth 3 -type f | sort
tail -80 "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

## Launch Phases

Primary launch and OpenCode secondary lanes are different paths.

- Primary CLI members are created by the main provisioning process.
- OpenCode secondary members are launched as side lanes after primary filesystem readiness.
- Missing `inboxes/<opencode-member>.json` is not automatically a launch bug. OpenCode side lanes do not have to be primary inbox-created before they start.
- The UI can show the team still launching while primary members are already usable, because "all teammates joined" waits for secondary lanes too.

When a launch hangs at `Prepared communication channels for X/Y members`, check whether `Y` incorrectly includes secondary OpenCode members. The filesystem monitor should wait for `effectiveMembers`, not every requested member.

## Teammate Runtime Debug Mode

Desktop launches use the app-managed process backend by default. That is the supported default for
normal app launches because the app owns the process lifecycle, runtime logs, cleanup, and bootstrap
evidence.

For local debugging, force pane-backed teammates through `tmux`:

```bash
CLAUDE_TEAM_TEAMMATE_MODE=tmux pnpm dev
```

For a single launch from the UI, add this to custom CLI args:

```bash
--teammate-mode tmux
```

Expected behavior:
- `tmux` mode should remove `CLAUDE_TEAM_FORCE_PROCESS_TEAMMATES` from the launch env.
- The desktop app should pass `--teammate-mode tmux` to the runtime CLI.
- The orchestrator should report `backend_type: "tmux"` and `tmux_pane_id` like `%1`.
- If `tmux` is unavailable, the launch dialog should block explicit tmux mode with a tmux readiness message.

Use this mode to inspect interactive CLI behavior, terminal prompts, and pane output. Do not treat it
as equivalent to the process backend for recovery semantics; persisted pane IDs can help discovery,
but app restart does not make old panes a fully app-owned runtime again.

## Member State Meanings

Common `launch-state.json` cases:

- `confirmed_alive` with `bootstrapConfirmed: true` - member is usable.
- `registered` / `runtime_pending_bootstrap` - process or lane exists, but bootstrap proof is not committed yet.
- `registered_only` - app has persisted metadata, but no live runtime proof.
- `runtime_process_candidate` - process/session was observed, but committed runtime evidence is incomplete or pending.
- `failed_to_start` with `runtime_process` - a process exists, but the launch gate still failed. Inspect diagnostics and runtime evidence.
- `failed_to_start` with `stale_metadata` - persisted pid/session is old or dead.

Do not treat `member_briefing` alone as runtime evidence. For OpenCode, the authoritative proof is committed bootstrap/session evidence in the lane runtime store.

## OpenCode Debug Flow

For an OpenCode teammate:

```bash
MEMBER="<member-name>"
jq --arg member "$MEMBER" '.members[$member]' "$TEAM_DIR/launch-state.json"
jq '.lanes' "$TEAM_DIR/.opencode-runtime/lanes.json" 2>/dev/null
find "$TEAM_DIR/.opencode-runtime/lanes" -maxdepth 3 -type f | sort
```

Expected healthy OpenCode lane:
- `lanes.json` has the lane state `active`
- lane `manifest.json` has `activeRunId`
- lane manifest has at least one runtime evidence entry, usually `opencode.sessionStore`
- lane directory has `opencode-sessions.json`
- `launch-state.json` member has `runtimeRunId`, `runtimeSessionId`, and `bootstrapConfirmed: true`

If the bridge says bootstrap succeeded but the manifest has `entries: []`, the issue is evidence commit, not model behavior. The member must not be considered deliverable until `opencode-sessions.json` and its manifest entry exist.

OpenCode bridge ledger, if needed:

```bash
LEDGER="$HOME/Library/Application Support/claude-agent-teams-ui/opencode-bridge/command-ledger.json"
jq --arg team "$TEAM" '.data[] | select(.teamName == $team)' "$LEDGER" 2>/dev/null
```

Live process checks:

```bash
pgrep -af "opencode serve"
ps -p <pid> -o pid,ppid,etime,command
```

Do not kill all OpenCode processes as a debugging shortcut. First identify whether the pid belongs to the current team/lane. Some OpenCode temp `libopentui.dylib` files are held by live `opencode serve` processes and should only be cleaned after those processes are stopped.

## Messaging Debug Flow

Lead and teammates use different delivery paths:

- Lead reads stdin. Messages to lead go through `relayLeadInboxMessages()`.
- Native teammates read their inbox files directly.
- OpenCode teammates receive prompts through runtime delivery and must reply via `agent-teams_message_send`.
- Teammate-to-user replies should appear in `inboxes/user.json` or app sent-message projections.

If a notification appears but the Messages UI does not show it:

```bash
jq '.' "$TEAM_DIR/inboxes/user.json" 2>/dev/null
jq '.' "$TEAM_DIR/sentMessages.json" 2>/dev/null
```

Check `from`, `to`, `messageId`, `relayOfMessageId`, and `taskRefs`. Unknown authors should be rejected or normalized at the write boundary, not silently rendered as fake teammates.

For OpenCode "message saved but not delivered" cases, inspect the OpenCode prompt-delivery ledger and response proof. Do not synthesize visible replies in the frontend.

## Task And Work-Stall Debug Flow

For task stalls:

```bash
TASK="<short-or-full-task-id>"
rg -n "$TASK" "$TASKS_DIR" "$TEAM_DIR/inboxes" "$TEAM_DIR/bootstrap-journal.jsonl" 2>/dev/null
```

Important distinctions:
- Delivery proof means the agent received the message.
- Task progress proof means the agent made meaningful task progress.
- A weak comment like "starting work" is not strong progress.
- `task_add_comment` should be evaluated from the actual persisted comment text, not only from the tool call.

Task-stall monitor defaults:
- General task-stall monitor is for all agents.
- OpenCode direct remediation is provider-specific and should nudge the OpenCode owner first.
- If OpenCode remediation is not accepted, fallback to lead alert.
- Watchdog/remediation must not auto-start new OpenCode processes.

## Task Log Stream Debug Flow

Task Log Stream is a projection, not a separate source of truth.

For OpenCode tasks, a healthy stream should show native tool rows such as `read`, `bash`, `edit`, `write`, plus Agent Teams MCP rows. If it only shows `agent-teams_*` calls:
- confirm the task has OpenCode attribution for the member/session
- confirm the OpenCode transcript contains native tools inside the bounded task window
- check whether the task was assigned after the native work happened
- do not widen attribution so far that unrelated session work is pulled into the task

If Changes says "No file changes recorded" while native `write`/`edit` rows exist, inspect the ledger/backfill path. Task logs can show runtime tools even when `.board-task-changes/**` was not created.

## Safe Fix Checklist

Before changing launch or runtime logic:
- Preserve stale-run, tombstone, stopped-team, and removed-member guards.
- Do not make `member_briefing` runtime evidence.
- Do not make delivery/watchdog auto-launch a fresh OpenCode lane.
- Keep primary launch readiness separate from secondary OpenCode lane readiness.
- Keep runtime evidence lane-scoped. Never let one OpenCode lane satisfy another lane.
- Add a regression test for the exact state shape you found in `launch-state.json`.

Recommended verification:

```bash
pnpm test -- test/main/services/team/TeamProvisioningService.test.ts
pnpm test -- test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
pnpm typecheck
git diff --check
```

Use narrower test commands first when editing a focused path, then run the broader suite that covers launch, delivery, and liveness.
