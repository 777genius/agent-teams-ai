# Smart schedules: one agent or whole team

Status: Draft plan. Scope: Electron desktop scheduler only, backward-compatible. Base: `main` at `2dd3eec`.

## Goal
Expose exactly two choices for **new** schedules:
1. **One agent** (default): if the team is offline, run the existing isolated one-shot CLI job; if the team is live, create an assigned Kanban task using the existing task API and its owner notification (do not duplicate provider-specific messaging).
2. **Whole team**: if the team is offline, use the existing team launch/provisioning API; if live, assign the scheduled task to the existing team lead without relaunching.

Preserve every already-saved schedule's execution, retry, CLI arguments, logs, edit behavior and pause/resume semantics. No data migration.

## Compatibility contract (P0)
- Add optional `executionMode?: 'agent' | 'team'` and `targetMember?: string` to `Schedule` and input/patch types.
- **Missing `executionMode` means `legacy_one_shot`**, not the new default. An existing JSON record continues to execute via `ScheduledTaskExecutor`; do not rewrite records on read/save. Updating a legacy schedule's prompt/time must not change its mode.
- New schedule creation persists the selected execution mode explicitly: `agent` by default, or `team` when Whole team is selected. Legacy edits display a clear “Existing one-shot behavior” notice and allow deliberate opt-in to a new mode; never silently switch on Save.
- Keep `launchConfig` as-is; persist no extra serialized team launch state. Existing JSON repository, cron timing and historical runs remain readable.
- No new recurring daemon, databases, IPC surface for team operations, scheduler rewrite, or speculative orchestration framework.

## Dispatch policy
| Condition | One agent | Whole team |
| --- | --- | --- |
| Team not running | Existing `ScheduledTaskExecutor` one-shot (separate process) | Existing team provisioner `launchTeam` with scheduled prompt |
| Team running; target member alive and ready | Create a task with `startImmediately: true` and the existing owner-notification flow | Send prompt to current lead through existing message service |
| Team running; target member offline | Use non-destructive `attachLiveRosterMember` only when snapshot proves no live/pending runtime; await readiness, then create the assigned task | Assign a new task to the live lead (team is already running) |
| Team running; member cannot be safely restarted | Mark run skipped with explicit reason, never restart entire team | Assign to lead only when live, otherwise skip |
| Team launching, stopping, ambiguous liveness | Refuse destructive action and record skipped/failed reason | Refuse competing launch and record pending/skipped; never force-stop |
| Cron overlap for same schedule or same team | Skip, no duplicate dispatch | Skip, no duplicate launch |

Notes:
- `targetMember` defaults to the resolved team lead for new one-agent schedules; member selection must resolve to a currently configured team member. Removed/renamed/missing members are a safe skip, not a guessed substitute.
- When a live team receives work, create a **Kanban task** via the existing `TeamDataService.createTask` flow, using a run-stable `commandId` / `idempotencyKey` and `startImmediately: true`. The already-present assignment/start notification wakes the owner. No new messaging implementation. A stopped team in one-agent mode still gets a standalone one-shot CLI execution with no Kanban card.
- For a team launch, pass the prompt **once in the launch request**, never also send it after a newly initiated launch. For `already_running`, send it to lead only if the runtime is confirmed ready.
- Never call destructive `restartMember` from a schedule. Use `attachLiveRosterMember` only for a configured non-lead member with authoritative *absent* runtime evidence (not `stale_metadata`, `shell_only`, `runtime_process_candidate`, a pending spawn, or a shared primary lane); re-read snapshot after it returns. If not safe/ready, skip without touching another process.
- Persist only a grounded result: “task created / owner notified” or “team launch requested” does not prove the model completed work. A launch request is not a success of the full team bootstrap.
- Running team checks must use authoritative main-process state (`processAlive`, member runtime/launch snapshot), not renderer stale caches or PID alone.

## Minimal design
- Preserve `SchedulerService` as cron owner, run history, retry policy and locks.
- Introduce a small `ScheduleDispatchService` application use case with a narrow injected `ScheduleRuntimePort` for: inspect team/member state, read saved team settings, launch team, attach absent member, create idempotent task. Keep Electron/provisioning/CLI details in main-process adapters. No new inheritance, generic workflow engine or duplicate user-message routing.
- Existing `ScheduledTaskExecutor` remains the one-shot adapter for legacy and offline one-agent cases.
- `SchedulerService` chooses legacy or new dispatch once per run; use the same run/history model. Add `skipped` for safe non-execution and a summary that clearly distinguishes task creation / launch request from actual one-shot process exit.
- Never auto-retry a smart dispatch after an uncertain side effect. Assign a stable task-command idempotency key derived from the schedule run ID; the existing task system owns notifications. Preserve legacy one-shot retries unchanged.
- Serialize conflicting schedule dispatches per team and recheck authority immediately before side effects; reuse provisioning's admission and member-lifecycle locks instead of reinventing lifecycle.
- Reuse existing IPC `ScheduleAPI`; only its request/response types gain optional fields. No new user-triggerable privileged endpoint.

## UI (small, explicit)
- In existing `LaunchTeamDialog` schedule mode, show a two-option selector: **One agent** (default) / **Whole team**.
- For One agent show configured member choice (default lead), existing prompt, cron and timezone. Do not take a member name from the currently selected unrelated team; hydrate roster for the chosen team. Explain offline fallback: “Runs one standalone agent when team is off.”
- For Whole team show team and prompt, schedule/timezone; explain that the team launches only when off, otherwise the lead receives the instruction. Reuse the team provider launch settings already persisted; do not copy the entire launch flow UI.
- For legacy schedules, show a legacy badge/explanation and a deliberate “Switch to new behavior” affordance; a normal Edit/Save does not convert.
- Run history shows concise outcomes: completed one-shot; Kanban task created (execution not yet proved); team launch requested; skipped (reason); failed. Never label an inbox write as “task completed.”
- Existing Pause, Run now, Delete and logs continue to work.

## Safety and edge cases (must pass before merge)
1. Legacy JSON without new fields: schedule list/edit/save/run reproduces identical one-shot args; two existing overlapping jobs honor existing locks.
2. Newly created one-agent schedule: team off -> exactly one CLI spawn; live target -> zero spawn, exactly one task and its existing notification; live team + proven-absent target -> one non-destructive attach and exactly one task after readiness.
3. Member offline and non-restartable, deleted member, stale snapshot, missing team, team stopping -> no guessed process restart/message; clear skipped/failed record.
4. Whole-team schedule: team off -> exactly one launch using saved team settings + scheduled prompt; starting/online -> no additional launch; successful new launch does not also inbox-deliver the prompt.
5. Two schedules at the same time; manual launch/restart/stop races; same tick duplicate; retries; app shutdown mid-dispatch -> no double launch or send, no false success.
6. Validate `teamName`, target member, prompt, cwd and supported provider before any mutation. No dynamic CLI string interpolation.
7. Cross-provider source-level tests for Anthropic, Codex, and OpenCode runtime snapshots; do not assume that every member runtime is independently restartable.
8. No change to pre-existing team launch dialog outside its `mode="schedule"` conditional branches; no new install requirements.

## Critical plan reviews (before implementation)
- **Pass 1 — compatibility:** Optional mode must not be defaulted on load, and an ordinary edit must preserve legacy one-shot. New default applies to *creation only*.
- **Pass 2 — lifecycle:** `restartMember` is not a safe “start if absent” primitive; it can destroy a live runtime. Changed to guarded non-destructive attach of confirmed-absent non-lead members; ambiguous observations skip.
- **Pass 3 — delivery:** Reimplementing the UI's Anthropic/Codex/OpenCode direct-send and relay paths would duplicate complex protocol behavior. Changed to existing idempotent task creation/notification while team is online; no transport recreation.
- **Pass 4 — startup/races:** Start a stopped team from its **current saved team launch profile** (`getSavedRequest`), overriding only the one scheduled prompt; do not accidentally switch the team's provider to the one-shot selector. Avoid a second post-launch message; treat acceptance as “requested”, not “completed”.

## Test strategy (minimum valuable E2E)
- Pure dispatch-policy table tests including ambiguous liveness and idempotency.
- Existing `SchedulerService` and `ScheduledTaskExecutor` regression tests (legacy cron, history, retry, cancellation, stop/start).
- Renderer create/edit tests with legacy record and explicit new default.
- Main-process integration using real JSON schedule repository and mocked process/team lifecycle, verifying a full cron tick → correct dispatch → persisted history → UI-consumable outcome. No external model subscription.
- GitHub Actions: typecheck, targeted tests, relevant end-to-end/integration suite; verify workflow conclusion on exact PR HEAD.
- Independent review passes: (1) backward compatibility + UX, (2) runtime ownership + race safety, (3) cross-provider/protocol + error handling, (4) diff/DRY/testing. Fix findings and rerun focused tests, then final CI and merge.

## Not in scope
- Kanban-card auto-creation, conditions/webhooks, background execution after Electron closes, missed-job replay, automatic unlimited retries, modifying runtime internals, full task workflow engine, data migrations, new infrastructure.
- No claim of model performing work based solely on message/launch acceptance.

## Delivery and merge gates
- Draft PR from the outset; commit and push each logical increment.
- Four critique rounds against code and tests; seek configured GitHub review bots where possible, distinguish independent bot feedback from self-review.
- Merge only if no unresolved actionable P0/P1 reviews, exact HEAD CI is green, no startup/stop regressions, and new + old schedules are covered by end-to-end verification.
