# Attention Inbox — atomic user-answer handoff

**Date:** 2026-11-24  
**Status:** Implementation plan, reviewed in four design passes  
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
2. **Answer intent.** When submitting a comment in Task Detail on a currently user-blocked task with a valid `clarificationRequestId`, include `answerClarificationRequestId` in the existing `AddTaskCommentRequest`. No new data store, IPC endpoint or per-team watcher. Retain the comment draft and show a useful error for stale requests. This only applies to a task-scoped user comment, not arbitrary Messenger sends, task comments by agents, quoted messages, or notifications.
3. **Single authoritative write.** After IPC validates the optional expected ID and the controller authenticates the comment author as `user`, add the comment **and clear the matching user clarification in one `withTeamBoardLock` / `updateTask` write**. Reject a stale/missing/new request ID, deleted task, wrong author or invalid comment before any mutation; never clear a different generation.
4. **Idempotency.** For a user-answer submission use an ID derived from its request generation, e.g. `clarification-answer-<UUID>`. The controller detects the same already-written answer before processing a retry and returns the original comment; differing payloads for the same identity are a conflict, not silent overwrite. No duplicate notifications. Do not create an additional persisted answer table.
5. **Handoff.** Reuse the existing task comment notification and Task Board events; do **not** introduce a second direct-message write or claim two-file atomicity. Task status remains unchanged; only the user clarification flag clears. The agent can reply with another specific question using a new request ID if needed.
6. **Live UI.** Continue to use current event-driven Attention snapshot and the existing 60-second visibility/focus reconciliation. A successful write removes the task from `Awaiting your decision`; a failed write leaves it there. The existing **Mark Resolved** remains for legacy tasks and exceptional/manual resolution.

## Out of scope, intentionally

- Automatically inferring a task from an unbound chat message or a quoted message, or silently closing every open clarification in a conversation.
- Using an LLM to decide whether a user reply is sufficient, changing task status to `completed`, changing human approvals or review flow.
- Rewriting Messenger, changing notification providers, adding a queue/database/poller, migrating old task files in bulk, or making notifications the source of truth.
- Pretending the ordinary Messenger send has task-answer semantics; a future opt-in, exact task+generation link could route such sends through this **same** atomic command, but should be separately qualified.

## Safety invariants

- **I1:** Only a verified user-origin task-scoped answer changes `user -> null`; never changes `lead`, another task, another context or the review state.
- **I2:** `comment persisted` and `user clarification cleared` happen in the **same canonical task-file write**, under the existing team lock. Neither may happen alone on this path.
- **I3:** Request ID is unique per new user-waiting cycle. Stale submissions fail closed and preserve the draft, current state and newer question.
- **I4:** Repeating an accepted answer must neither create another comment nor another owner notification. A different answer body for the same ID must not overwrite the first.
- **I5:** No successful UI state is shown until a durable write succeeds; errors do not decrement Attention.
- **I6:** Existing agent and generic comment paths remain unchanged, including notification/fallback behavior and Task Board status.
- **I7:** No broad filesystem scan, new background process, new lock implementation or external service.

## Verification / acceptance

1. Unit: new initial user request has ID; repeated `user` retains ID; clear/re-ask changes ID; `lead` does not carry ID; legacy no ID is safe.
2. Controller: user comment + clear atomic and idempotent; stale/malformed/agent-authored/non-user/after deletion rejected without mutation; normal comments retain prior behavior; canonical board lock in effect.
3. Main/IPC: validation, correct task/ID scoping, existing result type, and error retains user draft; no path traversal/foreign-context bypass.
4. Renderer: only task-scoped submissions with matching current user request pass the optional marker; normal comments unaffected; state changes after accepted write.
5. Actual isolated **Linux Electron/IPC/filesystem/renderer E2E**: two teams; one user clarification via official setter; submit answer through Task Detail; verify persisted comment, cleared flag, unchanged task status, Attention disappears without manual Refresh, double submit is idempotent, new cycle rejects stale retry while still showing the new decision. E2E screenshot/evidence. Do not touch real user teams.
6. TypeScript 7.0.2 typecheck, relevant Vitest/controller tests, lint, required GitHub CI, CodeQL, independent review and PR merge only after final-HEAD evidence; skipped/queued/pending ≠ PASS.

## Design review and revisions

**Pass 1 — semantics:** Auto-clear-on-any-message was rejected: there may be several pending tasks and ordinary Messenger quotes do not prove a specific question. Scope narrowed to Task Detail's explicitly identified task.

**Pass 2 — crash consistency:** A separate `addComment` followed by `setClarification(null)` was rejected (partial failure or crash). Use a single canonical task mutation under the existing board lock. Reuse existing task comment notifications, do not invent a second delivery transaction.

**Pass 3 — races and retries:** Checking only `clarificationRequestedAt` was rejected (legacy missing timestamps and rapid cycles can collide). Use a unique request generation and stable answer identity. Old/stale request and differing retry content reject rather than silently mutating a newer question.

**Pass 4 — scope and operations:** Automatic background reconciliation, speculative group-chat matching and full Messenger refactor were rejected as over-engineering. The durable task comment is already an agent-visible mechanism. Preserve Task Detail's existing composer and fail-safe UI/error behavior; test real Electron readback and event propagation.

## Size / risk estimate

- Production: **220–420 LOC**, plus limited task-reader/type mapping and small Task Detail wiring.
- Tests/E2E: **250–500 LOC**.
- Value: 9/10, correctness goal 9/10, implementation complexity 5/10, confidence before E2E 7/10.
- If a real integration constraint makes the single-write guarantee impossible, stop rather than swapping in an unsafe two-write approximation.

## Delivery

Draft PR first, then scoped commits pushed as they are made. Inspect review threads and source-backed CI; correct real failures without weakening assertions. Merge only after real final-HEAD proof and verify `main`.
