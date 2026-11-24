# Attention Inbox — atomic user-answer handoff

**Date:** 2026-11-24  
**Status:** Implementation + review revisions, seven design passes  
**Base:** `0ccfe7726d96e8bad11f58119cde63804c64d952`  
**Scope:** task-scoped answers in the existing Task Detail comment composer, opened directly from Attention Inbox. Preserve existing Messenger semantics; do not infer answers from unrelated chat messages.

## Goal

A user who responds to a task that is **Awaiting your decision** should not then have to click **Mark Resolved**. Once their task-scoped answer has been durably recorded, the same task-file mutation hands the action back to the agent. The existing Attention event subscription removes the decision automatically. No automatic task completion or human-review approval.

## Current facts

- The authority is `needsClarification: 'user'` in the persisted task, not the Inbox UI.
- The main app's `TeamDataService.addTaskComment` calls controller `taskBoard.addTaskComment`. The controller already holds the team board lock for the task comment, writes the task atomically and notifies an owner through the existing comment path.
- Today `taskStore.addTaskComment` **never** clears clarification (`clarificationCleared: false`). The current `Mark Resolved` is a separate `setTaskNeedsClarification(null)` call.
- Task Detail comment submission can identify the exact task. Generic Messenger quotes retain only sender + text and may have zero/multiple `taskRefs`; there is no authenticated, cycle-specific task answer identity. **Never guess from timestamp, text, teammate or a free-form acknowledgement.**

## Final design

1. **Request generation.** Introduce optional `clarificationRequestId` (UUID) on the canonical task. Create once upon entering `needsClarification='user'`, both for controller-owned and existing main-owned task creation/writes. Keep it unchanged for repeated `user` setters; remove it when leaving user clarification. Expose via the existing typed task reader; old tasks without a generation remain readable and manually resolvable, with no guessed identity.
2. **Answer intent.** Bind the answer identity to the **first edit** of the Task Detail draft, not to the later submit click. Persist it with the existing draft storage and retain it through task refresh, failed submit, reopening and recovery. On a newer active question, block a stale draft submission without mutating the task and preserve the draft text; user explicitly clears the old draft before starting a new answer. Legacy drafts with no generation stay unbound. Include the captured identity as `answerClarificationRequestId` in the existing `AddTaskCommentRequest`. No new data store, IPC endpoint or per-team watcher. This only applies to a task-scoped user comment, not arbitrary Messenger sends, task comments by agents, quoted messages, or notifications.
3. **Single authoritative write.** After IPC validates the optional expected ID, verify the team belongs to the current app profile (otherwise reject without mutation, because this profile cannot safely notify its owner). The controller authenticates the comment author as `user`, adds the comment **and clears the matching user clarification in one `withTeamBoardLock` / `updateTask` write**. Reject a stale/missing/new request ID, deleted task, wrong author or invalid comment before any mutation; never clear a different generation.
4. **Idempotency.** For a user-answer submission use an ID derived from its request generation, e.g. `clarification-answer-<UUID>`. When the task has **no newer outstanding clarification**, an identical retry returns the previously saved answer. If cycle B is awaiting input, a retry from cycle A **fails closed**, even if A was previously saved. Differing payloads for the same answer ID always conflict. No duplicate notifications or second answer table.
5. **Durable handoff.** Reuse the existing task-comment notification journal for the explicitly identified, user-authored answer only. The controller suppresses its separate best-effort immediate owner notice on this path. The main process queues a stable, idempotent notification to the task owner (or lead if unassigned) with `messageId=task-comment-forward:<team>:<task>:<comment>`, and journal state `pending_send` survives a failure/restart. The main process attempts it immediately after the task write, but notification failure never rolls back the answer; startup/file-watcher/retry recovers the pending send. Cold journal initialization must not seed these new user answers as historical noise. Other task comments keep existing lead-forwarding policy. No new notification system or false claim of task-file plus inbox-file atomicity. Task `status` and review state are unchanged.
6. **Live UI.** Continue to use current event-driven Attention snapshot and the existing 60-second visibility/focus reconciliation. A successful write removes the task from `Awaiting your decision`; a failed write leaves it there. The existing **Mark Resolved** remains for legacy tasks and exceptional/manual resolution.

## Out of scope, intentionally

- Automatically inferring a task from an unbound chat message or a quoted message, or silently closing every open clarification in a conversation.
- Using an LLM to decide whether a user reply is sufficient, changing task status to `completed`, changing human approvals or review flow.
- Rewriting Messenger, changing notification providers, adding a queue/database/poller, migrating old task files in bulk, or making notifications the source of truth.
- Pretending the ordinary Messenger send has task-answer semantics; a future opt-in, exact task+generation link could route such sends through this **same** atomic command, but should be separately qualified.

## Safety invariants

- **I1:** Only a verified user-origin task-scoped answer changes `user -> null`; never changes `lead`, another task, another context or the review state.
- **I2:** `comment persisted` and `user clarification cleared` happen in the **same canonical task-file write**, under the existing team lock. Neither may happen alone on this path.
- **I3:** Request ID is unique per new user-waiting cycle and is captured/persisted when the user starts composing a draft. Stale submissions fail closed and preserve the draft, current state and newer question; no silent rebinding at send time.
- **I4:** Before a new cycle, an identical retry returns the old comment; during a newer awaiting-user cycle an old retry rejects without mutation. No duplicate comments or owner notifications. A different payload for the same ID never overwrites the first.
- **I5:** No successful UI state is shown until a durable write succeeds; errors do not decrement Attention.
- **I6:** Existing agent and generic comment paths remain unchanged, including notification/fallback behavior and Task Board status.
- **I7:** A committed user answer is discoverable by the existing durable notification journal even if its first owner notification failed. Retry/recovery is idempotent by stable messageId; a rejected/declined inbox write is never marked delivered. A task from another app profile cannot be auto-cleared by this profile. No broad new filesystem scan, background process, lock or external service.

## Verification / acceptance

1. Unit: new initial user request has ID; repeated `user` retains ID; clear/re-ask changes ID; `lead` does not carry ID; legacy no ID is safe.
2. Controller: user comment + clear atomic and idempotent; stale/malformed/agent-authored/non-user/after deletion rejected without mutation; normal comments retain prior behavior; canonical board lock in effect.
3. Main/IPC: validation, correct task/ID scoping, existing result type, and error retains user draft; no path traversal/foreign-context bypass. Reject a bound answer from another app profile before task mutation. Inject owner-notification failure/declined write after committed answer; assert `pending_send`, recovery to `sent` and single owner message. Repeat on cold journal initialization and after restart/retry.
4. Renderer: capture the generation with the first draft edit; persist it across restart; reject A's unsent/failed draft after B becomes active and preserve text; a deliberate fresh draft binds B. Only task-scoped answers pass the marker; ordinary comments are unaffected. State changes after accepted write.
5. Actual isolated **Linux Electron/IPC/filesystem/renderer E2E**: two teams with official synthetic profile ownership markers; one user clarification via official setter; submit answer through Task Detail; verify persisted comment, cleared flag, unchanged task status, **durable owner/lead inbox notification**, Attention disappears without manual Refresh, double submit has one comment and one owner notice, new cycle rejects stale retry while still showing the new decision. E2E screenshot/evidence. Do not touch real user teams.
6. TypeScript 7.0.2 typecheck, relevant Vitest/controller tests, lint, required GitHub CI, CodeQL, independent review and PR merge only after final-HEAD evidence; skipped/queued/pending ≠ PASS.

## Design review and revisions

**Pass 1 — semantics:** Auto-clear-on-any-message was rejected: there may be several pending tasks and ordinary Messenger quotes do not prove a specific question. Scope narrowed to Task Detail's explicitly identified task.

**Pass 2 — crash consistency:** A separate `addComment` followed by `setClarification(null)` was rejected (partial failure or crash). Use a single canonical task mutation under the existing board lock. Reuse existing task comment notifications, do not invent a second delivery transaction.

**Pass 3 — races and retries:** Checking only `clarificationRequestedAt` was rejected (legacy missing timestamps and rapid cycles can collide). Use a unique request generation and stable answer identity. Old/stale request and differing retry content reject rather than silently mutating a newer question.

**Pass 4 — scope and operations:** Automatic background reconciliation, speculative group-chat matching and full Messenger refactor were rejected as over-engineering. The durable task comment is already an agent-visible mechanism. Preserve Task Detail's existing composer and fail-safe UI/error behavior; test real Electron readback and event propagation.

**Pass 5 — reviewer challenge on notification failure:** A best-effort owner ping alone was rejected: the user handoff can commit while owner is unaware. Use the existing persisted task-comment notification journal, previously restricted to teammate→lead comments, for exact `clarification-answer-UUID` user messages. Suppress controller's concurrent direct notice, preserve journal recovery and stable ID deduplication. A cold-start baseline must not mark these new answers as already forwarded. Old-cycle retries after a new cycle begins must reject rather than returning the old answer.

**Pass 6 — independent reviewer challenge on draft rebinding:** Reading the request ID when the user clicks Send is unsafe: the question can change after the user wrote text. Capture the ID at first nonempty edit in the existing scoped draft state and persist alongside the draft. Preserve across retry/restart, refuse a stale A draft when B is active, allow explicitly cleared drafts to bind the new cycle. Fix the real Electron E2E's post-stale test cleanup to clear B only after proving stale rejection.

**Pass 7 — crash and profile-isolation challenge:** Saving draft text and cycle ID as separate storage keys risks mismatched recovery after a partial write; persist one versioned draft bundle through existing serial draft storage, migrate old text/chip drafts as unbound (never guessed). The existing notification journal only operates on teams that belong to the current app profile; reject an automatic answer for foreign teams before mutation instead of silently clearing without routing. The real E2E claims test-only team ownership using the app's existing profile-scope hash and asserts one durable notification in the recipient inbox.

## Size / risk estimate

- Production: **550–850 LOC** including scoped journal reuse, atomic draft bundle, profile guard and main IPC/Task Detail.
- Tests/E2E: **500–800 LOC**.
- Value: 9/10, correctness goal 9/10, implementation complexity 5/10, confidence before E2E 7/10.
- If a real integration constraint makes the single-write guarantee impossible, stop rather than swapping in an unsafe two-write approximation.

## Delivery

Draft PR first, then scoped commits pushed as they are made. Inspect review threads and source-backed CI; correct real failures without weakening assertions. Merge only after real final-HEAD proof and verify `main`.
