# Schedules: reliability, UX and E2E qualification (2026-11-09)

Status: approved implementation plan, **one Draft PR** on `fix/schedule-reliability-ux-e2e-20261109`.
Base: `main` after #1137 (bootstrap-only), #1138 (task-first), #1143 (task-first UI).

## Goal and acceptance criteria

Make new task-first schedules understandable and safe, preserve every existing legacy schedule, and qualify real user actions in the desktop UI. **No new scheduler, persistence schema, queue, feature flag, or agent runtime.**

1. A user cannot create an active schedule with an invalid cron expression, non-resolvable timezone, or no future occurrence. This is enforced at UI and service boundaries. An invalid update retains the prior durable record and live cron job unchanged. An already-invalid historic JSON record does not break scheduler startup or unrelated schedules.
2. The create/edit dialog shows the selected team, the specific assignee or lead, the intended prompt and schedule/timezone with clear next-run preview. Errors do not appear before interaction on an untouched new form. Previously saved one-time startup instructions receive a clear pre-submit acknowledgement, do not replay.
3. The global schedules page and team schedules section clearly distinguish task-first vs legacy behavior, show the actual assignment target, give visible success/failure feedback for run-now and edit/delete/pause/resume, and confirm destructive deletion. No false "completed" claim at task handoff; navigate to the linked task where available.
4. The user's current IANA timezone works even when it is absent from preset values. Common presets remain quick. Localized date and cron descriptions should not be hardwired to English.
5. Visual desktop checks of creation, edit, run history and error/warning states in light/dark theme, narrow width and 200% zoom. Assert labels, focus, scroll and click targets; collect actual screenshots.
6. Tests cover valid/invalid cron, timezone, atomic update failure, restart/legacy compatibility, task-first running/stopped team, incomplete prior task, run-now errors, deletion and navigation. CI and review clean before merge.

## Implementation in layers (minimum changes)

### P0. Schedule validity and atomic updates

- Add one small pure helper under `src/main/services/schedule` for cron/timezone validation using existing **Croner**. Validate a real IANA zone via `Intl.DateTimeFormat`; require a future `Cron.nextRun()`. Do **not** build a second cron parser or change existing one-shot semantics.
- Call validation **before** `SchedulerService.createSchedule` writes, and before `updateSchedule` mutates the persisted schedule or existing job. Build the new paused Cron job before replacing old live timers if needed, then activate it only when valid. Keep errors explicit. Reuse same validation for `triggerNow` only when required by invariants; old invalid JSON should be recoverable through edit.
- Use existing `CronScheduleInput` validation to disable submit and display field-level feedback. Keep source-of-truth enforcement in main process.
- Regression cases: bad syntax, bad timezone, syntactically valid but exhausted schedule, invalid edit on active record, valid update, corrupt legacy record, app restart.

### P1. Behavior clarity and user feedback

- Both schedule lists: show execution path (`Assigned to <member>` / `Via team lead` / `Standalone legacy`) and last-run result alongside next-run. Preserve compact layout; don't add new columns if narrow.
- Replace misleading `Whole team` copy **for new task-first only** with "Via team lead". Keep existing persisted mode and original legacy descriptions.
- Share small confirmation/feedback UI where existing app primitives allow. Deletion asks for confirmation; run-now/pause/resume/delete failures render a toast or inline actionable message, not just console error. Do not invent retry semantics or promise that dispatched means finished.
- Respect keyboard and ARIA labels for icon actions and expanded run rows. Avoid duplicated schedule business logic.

### P2. Polish

- Timezone selector: current zone always available, and search across canonical supported IANA zones if an existing combobox can be reused; no third-party timezone package. Preserve persisted arbitrary valid zones.
- Confirmation of historic team prompt is visible before final submission, and bound to exact team + prompt content. Never silently modify saved prompt.
- Use existing i18n keys/helpers; fix Russian and English source labels/dates and keep locale fallback/typing valid. Do not redesign all translations or the global theme.
- Reduce overly tiny critical text only where it obstructs comprehension, keep consistent existing design tokens.

## E2E/test qualification plan

1. Run focused unit/integration tests on `SchedulerService`, `SmartSchedules.safe-e2e`, `SmartScheduleDispatcher`, `LaunchTeamDialog`, `SmartScheduleFields`, and schedule run navigation; preserve existing fixtures and regression tests.
2. Add coverage to existing desktop E2E harness for creating/editing/deleting a **test-only** schedule, status feedback, invalid cron/timezone, navigation, confirmation and screenshots at light/dark/200%/narrow width. Do not use a real user's schedules or tokens.
3. Test app restart / persisted JSON with real Croner and an isolated fake provider process. This proves process and scheduler wiring, **not** an authenticated provider inference.
4. Where an authorized and safely isolated provider is available, qualify one real team lifecycle `stopped -> started -> exact member -> task`; report this separately from fixture tests. Never inject or read real credentials.
5. Review rounds: structural correctness, regression/safety, keyboard/visual UX, and full diff/CI. Fix every actionable finding; re-run on exact HEAD; merge only once green.

## Scope boundaries, explicit exclusions

- **In:** schedules UI and underlying cron validation; schedule-specific tests, a minimal existing CI/harness extension, locale strings for modified surfaces.
- **Out:** new scheduling queues, worker processes, backend services, persistence migrations, blanket localization rewrite, redesign of team creation, new providers, app-wide notifications, unrelated runtime recovery, and changes to legacy task dispatch defaults.
- No work against user data. No unsafe autopublishing. A running task must not be retried blindly after uncertain acknowledgement.
- A schedule run status `dispatched` means handoff only; Kanban task is the outcome authority.

## Estimated effort and risks

- P0: ~160-280 lines implementation + tests; complexity **5/10**, reliability gain **9/10**.
- UX P1/P2: ~250-500 lines + tests/i18n; complexity **5/10**, UX gain **8/10**.
- Desktop qualification: ~200-450 test/harness lines; complexity **7/10**, confidence gain **9/10**.
- Approx total 600-1,200 lines changed, variable due to test fixtures. Minimize deviations.

## Four plan review rounds

1. **Scope / DRY:** use existing Croner, status badges, dialog/alert and notification primitives; zero new packages or persistence abstractions. No new global scheduler.
2. **Compatibility / failure modes:** preserve old JSON and `taskFirst` create-only semantics; reject bad updates before touching existing cron timers; no swallowed user-visible exceptions; no blind retries.
3. **UX / accessibility:** one obvious recipient, honest dispatch status, visible validation, non-destructive legacy edit, confirmation for delete; keyboard and zoom checks.
4. **Verification feasibility:** fixture-based E2E stays isolated, never claim real AI execution from mocked tests; screenshots must be from schedule UI not team-create UI; exact SHA checks before merge.

## Stop / merge gates

- Review the complete diff twice and all GitHub review comments. Fixed issues must have reproducing tests where practical.
- Typecheck, lint, focused suites and required full CI passing on the final PR HEAD, plus desktop checks and screenshots if the harness permits.
- If native/visual E2E or authenticated AI execution cannot be run, document the *specific* missing evidence and keep the PR Draft; do not silently call it E2E-complete.
