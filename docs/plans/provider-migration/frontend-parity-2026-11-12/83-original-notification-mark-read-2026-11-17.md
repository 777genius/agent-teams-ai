# Plan83 — Prove the original notification Mark as read action

Status: prospective source selection on closed Plan82 source `baba8b311438aadde77afbe6eb9b88d0f3463cec`, tree `0199dbcddf9c7a6c32da485b183f2b3612766558`. No source afterimages exist. This is the bounded M14 notification quick-action continuation of the existing task-board-only acceptance journey.

## Existing gap and selected behavior

The original notification proof already binds its UI-created Task and exercises View in session and Delete. Its Mark as read branch is conditional, so an already-read row does not prove a positive unread-to-read transition. Preserve that proof and add a separate required `taskNotificationMarkReadUiProof`.

Exactly one bare canonical TEST Task is additional setup on the same captured owner and handle, after every original Taskboard and Trash/Restore check has passed. Then click the existing Mark as read UI control once and require the same notification to change from actual false to true. Setup is not an additional UI Create claim. Only `task-board-ui` receives this phase; combined and cross-only modes receive no additional Task.

The pre-Main seed cannot guarantee this notification: the producer seeds first/recovered snapshots as history. The global Tasks sidebar has no separate caller-independent Create route. Neither rejected approach is used. This selection is an explicit +1 TEST Task and +1 task-create command amendment, followed by one Mark as read effect. Navigation, hover and wheel input remain individually recorded; no claim is made that the total UI-input delta is one.

## Exact writable scope

| Path | Parent Git blob | Selected change |
| --- | --- | --- |
| `scripts/legacy-agent-host/desktop-backend-smoke.ts` | `a311c7420a17ed1df8e230caae69e49c15f74fa5` | Move only the existing F08/Trash tail into the existing offline dispatcher; remove now-unused imports. |
| `scripts/legacy-agent-host/desktop-task-board-cross-team-ui-smoke.ts` | `db4d98b333e1fb1103c82cf7851a252c0ecff3a5` | Preserve the complete old journey and append the positive phase only in task-board-only mode after Trash/Restore. |
| `scripts/legacy-agent-host/desktop-task-review-cycle-ui-smoke.ts` | `df76ce10ba52725b11fea48659b4cb516fc6fddf` | Extract the existing notification function into its cohesive owner; leave the review cycle unchanged. |
| `scripts/legacy-agent-host/desktop-task-notification-ui-smoke.ts` | Absent | Own the original notification journey and the separate positive phase; privately share notification-specific bounded reads and UI controls. |
| `scripts/legacy-agent-host/desktop-proof-supplementary-sources.ts` | `5a05f7a8bee998c40275b5ff428ffedee2cb9a2a` | Append four exact paths to the common source freeze. |
| `.github/workflows/host-emulated-acceptance.yml` | `706f83a6052a4879dfe587c330f093cb188c2e59` | Append two existing fast-lint operands and require the new task-board-only receipt evidence. |

No production owner, API, protocol, dependency or native helper changes. Keep original Taskboard helper `7707de6f387471609df97f0e1d93b93fbd4a1f77` (799 LF lines), main roster `a8be2617b2c765091cecce789f028ef2bf67af60` (800 LF lines), all Plan82 source, and all other paths unchanged. Every touched/new TypeScript file stays within 800 LF lines without packing or cap/baseline changes. The smoke and review files shrink naturally through the selected moves. Add no generic framework.

## Original order is an acceptance constraint

The existing smoke calls F08/Trash after its dispatcher returns. Move those existing calls into that dispatcher with the same CDP instance, argument keys/values, captured callback, mode guards and action counts. Retain the still-used HostRouting import and the original Taskboard failure observation/rethrow.

- Task-board only: board, original notification navigation/Delete, Trash/Restore, new positive Mark-read phase, unchanged generic Host/sentinel/Quit/cleanup.
- Combined: board, review cycle, original notification, cross-Team, oversized cold-reload comment, F08, Trash/Restore, unchanged generic cleanup. No additional setup.
- Cross-only: the same early return and cross-Team behavior.

The old two-Task totals and group/dependency counters remain true at their original boundaries. Do not globally change old expected totals from two to three.

## Positive phase and exact accounting

Initialize the separate proof as INCOMPLETE before any additional setup and require the original board, notification and Trash/Restore proofs to be PASS. Retain the old original Task and notification identities separately.

1. Capture the post-Trash baseline: exactly the seed UUID and original UI-created Task UUID, both current byte images, group/dependency state and the bounded original command inventory. Require the same offline profile, captured owner/handle and TEST-human authority, with no Runtime allocation.
2. Open the actual Notifications pane with its existing UI control and await its loaded view. Normal focused-pane synchronization clears the viewed Team. Do not call setViewedTeam, write notifications/isRead, mutate the renderer store, force blur or exploit startup timing.
3. Record a unique setup commandId and bare TEST subject before exactly one existing public `window.electronAPI.agentBackend.invoke` task.create invocation on the captured handle. No assignee, dependency, group or provider prompt is supplied. Require a completed canonical receipt with matching commandId, principal, binding, operation, payload and effect Task UUID. Join the actual public result to that original receipt. Missing/refused/UNKNOWN/ambiguous outcomes fail without another invocation.
4. Require exactly the original two Task UUIDs plus the new UUID, one additional task-create command and one additional total command. Prior Task bytes and command bytes are unchanged. The new Task has no group, so the old group-task membership/counts are unchanged. Preserve original dependency evidence. Account for this intentional setup separately from UI effects.
5. Use the existing bounded public notification read to require exactly one task_created row with the captured owner selection key and new Task UUID. Require a distinct notification UUID and actual `isRead === false`. Already-read fails; absence times out; neither is optional or a skip.
6. Freeze canonical Task bytes, kanban bytes and the full bounded command inventory after setup. Reuse the real hover/action machinery to click Mark as read once. Require the same notification UUID and target, now `isRead === true`. Compare all other fields and neighboring notifications; no additional notification or unrelated change is admitted. Do not navigate to the Task or replay a mutation to manufacture the transition.
7. Require every frozen canonical byte and command to remain unchanged across that UI action, the exact final three-Task set, preserved original identities, and empty Runtime sessions. Only then set the separate proof PASS.

Keep the extra Task/notification as explicitly accounted TEST evidence. No extra delete or synthetic cleanup is selected. All original physical cleanup, captured process witnesses, sentinel refusals and source-freeze checks remain mandatory; incomplete proof still follows the original failure/cleanup path.

## Feasibility and provenance

The unchanged background chain already supports notification production while Notifications is focused. Renderer main `0df14ce0092a7e19dd36dbcd17eb3530faee36ff` installs listeners before React. API index `1c0623475dd6cf9f9d735d784e4aaf3ab8a9c158` captures context epoch, not viewed Team. Public renderer index `3eb12d58f885046e9c8152ab32eae5c7f3ceb56d` and composer `0f03a6b142723d81ac2e7ce76b3cc60fbcec5b2b` select HostTeamsApi `bad0a18f7749717dc2bf2ddba051c4d55b7b6c38`. HostTeamChanges `daf8ec603a9d0a5b5990232d7617b9a4a67b10e1` polls all captured bindings, with its original cursor/epoch guards. Store index `99619bb7c8645c62f8c59b4d04d428f35ae2ba93` schedules global fetch before the visible-Team return. Team slice `df9dd8391bdd9fcd2edc05057fa18a8cbd787dad` invokes producer `1ab82b5ca43f14720a0ffc08c44d4de25012bdf7` on the accepted snapshot. Viewed-Team sync `4c360febfaacf5a832e3054faa36460b00c4c306` returns null for Notifications. This establishes source feasibility; the actual false-to-true observation remains mandatory.

Reuse the existing 20-second product-read helper, UI-controls budgets, 12-page hover bound and 100ms observation pauses. Preserve original clocks, currentness checks and ambiguity failures. No new polling framework, independent timer, retry, deadline increase or forced refresh.

Append exactly these four paths once to the common supplementary array, preserving every original entry's relative order:
- `scripts/legacy-agent-host/desktop-task-notification-ui-smoke.ts`
- `src/renderer/store/viewedTeamNotificationSync.ts`
- `src/renderer/store/slices/notificationSlice.ts` (unchanged blob `17211d8261cc45a66d8cf5ca410ee63961aa4958`)
- `src/renderer/store/team/teamGlobalTaskNotifications.ts`

The separate Windows-retry roster does not feed the common main vector. Common composition grows by exactly four unique paths; all other arrays and the main roster remain unchanged. Preserve the existing 145 fast-lint operands in order, append the dispatcher then the new module, and require 147 unique operands. Smoke/review-cycle are already included.

## Existing CI verification and publication

Extend only the existing task-board-only verifier to require both original notification and Trash/Restore proofs, the separate positive proof, exact original/new owner/Task/notification joins, one setup receipt/new Task, actual false-to-true state, final three-Task accounting and canonical immutability. Add explicit binding of the notification proof sourceSha256 to the new module bytes; no such old explicit hash comparison is assumed. Keep every old verifier, source-freeze, Runtime and cleanup gate. Combined/cross-only modes must not require or inherit the new proof. Jobs, matrix, routes, type/lint commands and runtime budgets remain unchanged.

Root R1 and independent prospective R2 must close on this exact plan. Publish documentary selection and R2 first, read back actual docs/tree and close independent review, then author and review the exact six-source-path child. Root alone uses normal expected-SHA delivery publication, followed by independent actual-source readback. Primary advances only after all source gates and a fresh sole-observer useful-job guard. No local project/native/GUI execution or manual Actions mutation.

This root rebind condenses the fully read prospective draft (SHA256 `49448ecd3c55760e62053712f0b8728087da76b3ca5a2f37dcdbed2cd2481153`) without changing its six-path behavior selection and corrects its assumption of an existing explicit notification source-hash check. Full source feasibility report SHA256 `0cf00b86553a4da2acb97726cf7517eebdf34de4524d395bcc325c58f87b9913` was read; no root rehash of that report is claimed. Actual source, E2E, visual and cleanup qualification remain pending. Plan40's owner decision, missing historical originals, genuine-provider restrictions and release/Stage2 holds remain unchanged.
