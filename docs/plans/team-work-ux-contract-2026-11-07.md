# Team tasks and schedules: one intent, one recipient, one truthful result

**Decision status:** Proposed for implementation (2026-11-07)
**Scope:** Agent Teams desktop, new task/schedule flows. No runtime rewrite, schema migration, or change to old schedules.

## User-facing contract

The app has only three primary intents:

1. **Start team** — start or resume the configured runtime without issuing a new work item. No prompt is requested by default. Configure roster, provider, model and worktree in Team settings, not in the ordinary start form.
2. **Assign task** — choose a recipient and give a durable instruction with a board task. The task can be created now or configured to repeat on a schedule. The same recipient is responsible whether the team is currently live or stopped.
3. **Message** — a conversation, not automatically a task or a process launch. Preserve existing Chat Ask/Do/Delegate controls; do not turn each chat message into a Kanban card.

The _recipient picker_ contains **Team (lead coordinates and delegates)** plus the team's actual non-lead teammates. Do not add both "Team" and "Lead" with indistinguishable semantics. A solo team has **Lead (does the work)**. Directly asking a lead to do work itself remains an explicit Chat / Do action; it must not silently override the current delegation-first lead policy. Resolve saved roster identities, not free-text names. Show avatar, name, role, provider/model and compact, accurate runtime availability (do not show speculative presence). Reuse existing MemberSelect and member identity resolvers; represent "Team" as a local tagged choice, not a fictitious member in persisted roster.

The **new task form** contains recipient, required instruction and **Now / Schedule**. Team is preselected from the invoking context. If Schedule: reveal only frequency, local time and timezone; hide cron syntax under Advanced. A short title can be derived from the instruction; users may edit it under Details. Settings such as model, permissions, worktree and CLI args remain with the team/member. Do not duplicate CreateTaskDialog's existing advanced Kanban fields in the schedule form. The footer uses contextual verbs: "Assign task", "Start team and assign", "Create schedule", "Save task". Explicit summary appears once when a stopped team would be started, including "starts configured teammates" and potential provider usage; don't repeatedly warn on a live team.

**Start team** is a separate compact action: project, current configured member/provider summary, primary Start, secondary Settings. If already live show task/chat actions instead; never interpret Start as message sending. Changing models/roster is an explicit edit/relaunch, not a by-product of task assignment. Remove the stale June 15, 2026 billing-warning assertion. Anthropic's Oct 7 update says SDK/claude -p on plan login continues to use subscription limits; linked API-key execution uses linked Console API credits. Do not introduce a new billing warning unless grounded in authoritative runtime billing identity.

## Execution contract (new opt-in behavior only)

- **Start / stopped:** launch the saved team in **bootstrap-only** mode (no old work prompt replay). Show runtime starting, ready or error.
- **Start / live:** open the existing team without relaunch or reissuing a prompt. Show already running.
- **Assign teammate / live and ready:** persist exactly one task for the selected roster member, notify through the existing task path. Show handed off, **not** finished.
- **Assign Team / live and ready:** persist one lead-owned coordination task; the desktop must not create subtasks itself. Lead handles delegation on the board.
- **Assign / stopped:** persist a pending task **first**, start the saved team bootstrap-only, wait for authoritative **same-run/same-member** readiness and deliver once. Do not repeat work in bootstrap. Show pending → handoff or pending with actionable failure.
- **Recipient busy:** persist a pending task without interrupting current work or falsely marking the agent executing. Existing proven work sync/agenda may take it later. Show queued/waiting with a task link.
- **Recipient absent, removed or unsafe:** never retarget or forcibly restart. Keep an already accepted task visible with a reason and safe retry.
- **Team launching or stopping:** respect lifecycle admission and stop generation; no second launch or mid-stop delivery. Wait for confirmed run or skip safely.
- **Previous occurrence unfinished:** default to **skip** a new occurrence of the same schedule, show the previous task and reason rather than accumulating duplicate active work.
- **Desktop not running:** don't promise offline cron execution or catch-up; the UI explicitly says scheduling requires the app to be running.

### Special admission cases (keep the UI honest)

- **Config-only draft:** a newly configured team may have metadata but no runnable config/authoritative roster. Do not create a board task against a non-existent runtime configuration or fabricate a lead. Show "Finish team setup" and use the existing draft-create/provisioning path first; preserve task instruction in the form until it is safe to persist.
- **Project/workspace trust:** if the saved project directory is missing, already running under a conflicting team, or workspace trust/permissions require user action, stop before irreversible launch/delivery. Reuse current Launch preflight and trust controls as an inline actionable step, not a permanent stack of diagnostic banners.
- **Existing Kanban create:** a plain "Save task" on a stopped team must continue to create TODO without secretly starting processes. Auto-start applies only to the explicit "Start team and assign" intent. Never silently change the current CreateTaskDialog checkbox semantics for old entry points.
- **Different owner identity across runtime generations:** a stopped/relaunched team is not a continuation of the previous run for message delivery. Reconcile task owner against the latest saved roster and current run token immediately before sending; once stale, leave the task pending rather than delivering to a reused name or prior process.

### Prompt and identity boundaries

- Current launch admission substitutes persisted team metadata prompt when request.prompt is absent: TeamProvisioningRequestAdmission.ts (`request.prompt ?? meta?.prompt`). Launch persistence also keeps it. **A new bootstrap-only start cannot be implemented by sending empty string**: IPC currently normalizes empty strings to undefined, causing old prompt replay. Add one explicit internal launch intent to suppress _execution_ of persisted work prompt without deleting/changing the stored field. Preserve current public/legacy launch behavior unless caller opts in. Cover draft-create redirect, manual start, scheduler, deterministic and OpenCode paths.
- Distinguish persistent **role/workflow instructions** from a one-time **work task**. Bootstrap may hydrate team identity, current board and readiness, but not execute any old work prompt. Normal task delivery must be on the existing board/message path, not on a CLI argument or arbitrary stdin.
- Stable identity is **(team, resolved member, current runtime run/generation)**, not display name alone, OS PID alone or an old status snapshot. A live process with no bootstrap/recipient proof is not ready. Never auto-attach uncertain OpenCode secondary lanes; preserve the existing fail-closed rule.
- Direct worker assignment must not be transformed into "lead delegates" when the team is stopped. Team is an explicit recipient distinct from a named teammate. A non-solo lead receiving a Team task should delegate, not implement by default.
- Do not assume `startImmediately: true` means processing began. Current CreateTaskRequest/TeamDataService may set in_progress and send a best-effort notification without confirmed consumption. UI must separate persisted task, dispatch submitted, confirmed delivery (if evidence exists), actual agent work and completed task.

### Legacy prompt review (one-time only, no automatic inference)

Some saved team prompts mix lasting lead rules with an earlier one-time user task. Silently dropping the whole prompt loses useful rules; replaying the whole prompt executes obsolete work. On the **first explicit switch to bootstrap-only**, when a legacy saved prompt is nonempty, show a one-time review: original prompt unchanged, an editable **Keep as team/lead instructions** field, and an explicit acknowledgement that old task text will not run. The user selects/copies only the lasting rules; **never let an LLM auto-split or auto-persist this**. Save the confirmed standing rules through the existing TeamPromptManagement/lead-instructions editing contract, retaining the original raw legacy prompt until the user commits. If existing lead instructions differ, show both and require explicit confirmation rather than overwriting. Cancel preserves the old team and its behavior; do not silently start in the new mode until the review is complete. Do not show this prompt to teams without legacy content or on every later start.

### Idempotency / crash behavior

- Reuse existing TaskBoardCommandFacade and application command ledger. Each schedule occurrence obtains a stable runId **before** side effects; use the same command id and idempotency key when reconciling a lost ACK. Save the linked board task ID (optional schedule-run field), without a new queue/table. Do not mint a fresh job ID just to retry a potentially committed write.
- Never report completion because launchTeam returns `started` or scheduler reports `dispatched`. Those acknowledge launch/handoff, not model output. Render schedule-attempt status from existing ScheduleRun plus linked Kanban task, and show the task link rather than two contradictory status labels.
- On crash between task creation, launch, and send: leave the task discoverable. On next open, show "task saved, delivery unconfirmed" with a manual **Continue** action after reconciling ledger + task + fresh runtime evidence. Do not replay uncertain delivery blindly or create another task. This is safer than adding a new persistent background worker in this scope.
- For an already busy recipient, the existing MemberWorkSync/task briefing is the only candidate to advance queued work. Test it end-to-end before claiming "will automatically run later"; otherwise say "saved, not started" and expose Start. No new task queue or implicit retries.
- No automatic provider fallback, no unannounced restart, no duplicate prompt sent through both bootstrap and inbox. Stop/cancel prevents _new_ side effects; existing saved tasks remain visible. Avoid promising exactly-once model execution: make durable task creation idempotent and delivery observable instead.

## UI consistency rules

- **One identity UI:** reuse MemberSelect, memberAvatarMap, role display and current team roster from selected team; clear invalid selection on team changes (do not select a same-named member of another team).
- **One meaning:** Team means lead coordinates; teammate means exact teammate. The selection does not change with liveness or provider. The special Team option is not persisted as a fake teammate.
- **One task owner:** board is source of truth for owner, task status, comments and artifacts. Schedule is a _trigger_ and its run is an attempt; link to the board task, don't duplicate task history inside the scheduler.
- **One feedback message:** show the decisive actionable next step near the primary button; technical provider/provisioning diagnostics live behind Details, not as stacked warnings.
- **Accessible controls:** full-width searchable selection with avatar, keyboard, screen-reader label, empty/removed state; focus/IME-safe editor; localized time with explicit timezone and DST behavior; no color-only health cues. Preserve all 29 locales; never delete locale trees for a minor UI change.
- **No blocking preflight on form open:** use current cached provider/roster summaries; verify exactly selected providers and project scope on actual Start/Assign authorization. Do not fetch every model/provider catalogue merely for an avatar dropdown.

## Minimal architecture / order of delivery

Keep **SchedulerService + Croner + JsonScheduleRepository**, **TeamProvisioning** runtime ownership and **TeamDataService + TaskBoardCommandFacade** as-is wherever possible. No second orchestrator, queue, database, transport or generic provider framework. Add at most one narrow _AssignWork_ application operation that coordinates existing ports: roster/launch-state read, task creation, team launch/ready and task wake. The domain is a small pure decision function for `Start | AssignTeam | AssignMember` and `live | stopped | transitional | uncertain`; policy must not import Electron, React, CLI, fs or cron. Main process adapters call the current services; renderer components only collect intent and display observed outcomes. An abstraction is justified only by a real dependency/test seam (DIP); no per-provider ceremony or parallel state source (DRY).

Implement as small independent steps:

1. **Copy/picker (P0, low-risk):** remove stale billing banner and `claude -p` one-shot explanation from unrelated team UX; use existing MemberSelect with real roster/avatars on schedules. Keep old execution behavior explicit while migration is pending. Do not touch unrelated creation PR #1125 or team-header PR #1130.
2. **New opt-in work-intent contract (P0, high-risk):** bootstrap-only launch, stable task identity, exact teammate vs Team delegation, safe ready/stop gates, task-first delivery. Existing schedule records with missing/old `executionMode` keep byte-compatible behavior. Introduce one small optional behavior marker for _new_ schedules only; never reinterpret old `agent` or `team` entries on read/save. Existing manual launch with prompt is unchanged until intentionally migrated.
3. **Compact new schedule flow and truthful statuses (P0/P1):** new schedule editor shows recipient / instruction / time; use existing Task/Member fields and existing linked board card. Preserve full old edit form for legacy schedules; switching is explicit and reversible before save. No big-bang extraction from 3,000+ LOC LaunchTeamDialog.
4. **E2E and polish:** real Croner + JSON repo + IPC, mocked process provider adapters; Electron visual tests on supported platforms for narrow/wide, keyboard, light/dark. Native logged-in provider smoke only where credentials exist, clearly distinguished from mocks. Review and merge small PRs in order, verifying exact HEAD and post-merge.

## Required acceptance cases

- **Legacy schedules:** opening, editing and running old legacy/smart schedules preserves their exact behavior; no implicit migration or provider change.
- **Named teammate, live team:** one idempotent board task for that member, not an extra process or lead task.
- **Named teammate, stopped team:** one task and bootstrap-only team start, correct member receives after authoritative ready, no old prompt replay.
- **Team recipient, live or stopped:** one lead-owned delegation task, respecting the existing delegation-first instructions.
- **Race/unsafe runtime:** launching/stopping state, stale OpenCode proof or unavailable provider leads to safe wait/skip, not guessed recipient or destructive restart.
- **Busy or outstanding work:** no interruption or duplicate active work, explicit waiting or skipped outcome.
- **Overlapping same-schedule ticks:** hold the first occurrence before task creation, fire another Cron/Run Now attempt, then release; at most one persisted task and one handoff, other occurrence safely skipped/waiting.
- **Crash after commit/launch/send:** same task ID upon reconciliation, no blind retry, no false completion.
- **Roster changes:** removed/renamed teammate or switching team clears selection or errors, never redirects silently to a same-named recipient.
- **Manual start with historic prompt:** no old user task replay, roles/settings preserved; existing explicit legacy launch remains compatible.
- **UI/a11y/i18n:** desktop responsive in light/dark, keyboard-accessible; 29 locale catalogues preserved, no heavy provider fetch on open.

## Decisions against scope creep

**Do not:** make every chat message a task; refactor all provisioning paths; replace processes with tmux/one-shot; add distributed execution/catch-up; build a new durable worker; auto-upgrade old schedules; auto-select another model/teammate; label task `in_progress` as proof of real model activity; change team creation and runtime/provider migration PRs in this work.

**Implementation estimates, not commitments:** approximately 250–450 LOC for P0 UI/copy; 600–1,100 LOC for safe bootstrap/dispatch (largest risk); 300–600 LOC for compact schedule/status UI plus 700–1,400 LOC focused tests; localization effort across 29 catalogues is additional. Narrow scope after exact-code review; avoid speculative adapters. Success is fewer choices _and_ zero ambiguous side effects, not lines of UI deleted.

## Grounded code references

- `src/renderer/components/team/dialogs/LaunchTeamDialog.tsx` — combines launch, relaunch and schedule; prompt field, billing banner, old mode state.
- `src/renderer/components/team/schedule/SmartScheduleFields.tsx` — plain Select for teammate and `agent | team` selector.
- `src/renderer/components/ui/MemberSelect.tsx` — existing avatar/role/search picker.
- `src/renderer/components/team/dialogs/CreateTaskDialog.tsx` / `SendMessageDialog.tsx` — existing distinct task/message forms.
- `src/main/services/schedule/SmartScheduleDispatcher.ts` — today `agent` stopped is isolated one-shot, live is assigned board task; `team` stopped launches team, live targets lead.
- `src/main/services/schedule/SchedulerService.ts` / `JsonScheduleRepository.ts` — Croner, run IDs/history, `dispatched` handoff semantics.
- `src/main/services/team/provisioning/TeamProvisioningRequestAdmission.ts` — implicit fallback to persisted prompt.
- `src/main/services/team/provisioning/TeamProvisioningPromptBuilders.ts` — delegation-first lead policy and hydration prompt.
- `src/main/services/team/TeamDataService.ts` — idempotent board commands, startImmediately, best-effort notify.
- `src/features/member-work-sync` — existing agent work coordination, do not duplicate.
- Anthropic, _Use the Claude Agent SDK with your Claude plan_ (updated 2026-10-07): https://support.claude.com/en/articles/15036540-use-the-claude-agent-sdk-with-your-claude-plan
