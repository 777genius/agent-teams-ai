# OpenCode Delivery And Task Log Phased Hardening Plan

**Status:** implementation plan
**Scope:** OpenCode secondary teammates, message delivery latency, task log attribution, member-work-sync wakeups
**Primary repo:** `claude_team`
**Secondary repo:** `agent_teams_orchestrator`
**Key decision:** keep `TeamTask.workIntervals` unchanged as status-time intervals
**Related docs:**

- `docs/team-management/member-work-sync-control-plane-plan.md`
- `docs/team-management/member-work-sync-opencode-turn-settled-plan.md`
- `docs/team-management/member-work-sync-runtime-stop-hook-plan.md`
- `docs/team-management/member-work-sync-debugging.md`
- `docs/FEATURE_ARCHITECTURE_STANDARD.md`

---

## 1. Summary

Do not change `workIntervals`.

`workIntervals` should continue to mean:

```text
time while task.status === "in_progress"
```

That is a board/status interval, not proof that a runtime is actively executing tools. Keeping this invariant makes behavior provider-neutral for Claude, Codex, OpenCode, and future runtimes.

The actual OpenCode problem observed in `comet-hub` is different:

1. A task was created as `in_progress`, so `workIntervals` began immediately.
2. The OpenCode teammate did not start task execution until several minutes later.
3. Delivery spent time repairing stale OpenCode session/MCP state and waiting inside the bridge command.
4. The app treated some sends as acceptance-unknown after bridge timeout, so watchdog/retry logic became conservative.
5. Task Log Stream can miss logs from recreated OpenCode sessions because current transcript lookup is lane/member oriented, not session-evidence oriented.

The fix should be phased:

```text
Phase 0 - diagnostic baseline and invariants
Phase 1 - clarify UI copy around status-time
Phase 2 - session-evidence based OpenCode task log lookup
Phase 3 - accept-fast OpenCode delivery with async durable turn observation
Phase 4 - targeted retry/recreate tuning and live validation
```

Recommended total implementation:

`🎯 9   🛡️ 8   🧠 7`, roughly `1250-2150 LOC` across both repos including tests.

The highest-risk phase is Phase 3 because it touches OpenCode delivery acceptance semantics. It must be implemented after Phase 2 gives better visibility and after targeted tests prove idempotency.

---

## 2. Core Invariants

These must remain true throughout all phases.

### 2.1 `workIntervals` Invariant

`TeamTask.workIntervals` remains status-time:

- start when a task enters `in_progress`;
- close when it leaves `in_progress`;
- reopen on later `in_progress`;
- do not try to represent "model actively working";
- do not special-case OpenCode.

Why:

- `workIntervals` are already used by task change scoping, reviewability, member timers, task logs, and diagnostics.
- Changing them to "actual runtime work" would break established semantics and create provider-specific behavior.
- The board truth should be provider-neutral.

### 2.2 Delivery Invariant

OpenCode delivery must remain idempotent:

- one app-level `messageId`;
- one `relayOfMessageId`;
- bounded attempts;
- deterministic ledger record;
- no duplicate prompt after endpoint acceptance unless existing watchdog/retry rules explicitly decide it is safe.

### 2.3 Member Work Sync Invariant

Runtime turn-settled events are wake-up signals only.

They must not:

- mark tasks complete;
- mark messages read;
- count as semantic task progress;
- bypass busy/cooldown/rate-limit guards;
- conflict with `TeamTaskStallMonitor`.

### 2.4 Task Log Invariant

Task Log Stream may show less data when evidence is insufficient, but must not pull unrelated runtime work into a task.

Safety order:

```text
correct task/member/session > complete logs > pretty UI
```

### 2.5 Rollout Invariant

Do not add a long-lived production feature flag for this hardening.

Instead:

- ship phases in small commits;
- keep each phase independently testable;
- preserve old behavior as fallback inside the implementation where needed;
- use env gates only for expensive live E2E tests;
- use explicit command/API mode fields for semantic differences, for example `settlementMode`, not global hidden flags.

Why:

- this avoids another permanent state combination;
- rollback stays simple by commit/revert;
- the behavior is a correctness fix, not an experimental user preference.

---

## 3. Current Failure Model

Observed with OpenCode teammates:

```text
task created in_progress
-> foreground inbox assignment saved
-> OpenCode send starts
-> stale session or MCP not ready
-> orchestrator recreates session or reattaches MCP
-> prompt_async may be accepted late
-> app bridge may time out around 45 seconds
-> ledger marks acceptance unknown
-> watchdog retries later
-> actual task_start appears minutes after task created
```

This makes the UI look like:

```text
Work time 6m 28s
```

even though the runtime first touched the task much later.

That number is not wrong under current `workIntervals` semantics. The label is misleading if a user reads it as "active agent execution time".

---

## 4. Source-Audit Findings To Preserve

This section records the fragile seams found in the current code. Treat these as implementation constraints, not background notes.

### 4.1 `OpenCodeReadinessBridge` Already Has Timeout Recovery

Current file:

```text
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
```

Current behavior:

- `sendOpenCodeTeamMessage()` executes `opencode.sendMessage` with a default `45_000ms` timeout.
- On command timeout, it calls `opencode.commandStatus`.
- `commandStatus` is matched by:
  - `originalRequestId`;
  - `deliveryAttemptId`;
  - `teamId`;
  - `teamName`;
  - `laneId`;
  - `memberName`;
  - `messageId`;
  - `payloadHash`;
  - `projectPath`;
  - `runId`.

Do not remove this recovery path.

Phase 3 must extend it so an acceptance-fast command can still be recovered after a timeout. The command status response must remain strict about precondition mismatch, otherwise a stale outcome from another team/lane/message could be accepted.

### 4.2 Delivery Is Serialized Per OpenCode Member

Current file:

```text
src/main/services/team/TeamProvisioningService.ts
```

Current behavior:

- `deliverOpenCodeMemberMessage()` checks the active ledger record for the member/lane.
- If another message is still active, the next delivery is queued behind it.
- The active record is rechecked for visible reply proof before deciding whether to unblock the next message.

Do not bypass this queue.

Phase 3 accept-fast must not make every `accepted` record immediately eligible for the next prompt. "Prompt accepted" is not the same as "response proof complete". The active delivery slot should stay occupied until one of these is true:

- visible reply proof is sufficient;
- task progress proof is sufficient for that action mode;
- record is terminal failure;
- existing retry/observation policy explicitly allows moving forward.

### 4.3 Ledger Schema Does Not Track Runtime Prompt Message ID Yet

Current file:

```text
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
```

Current ledger record has:

- `runtimeSessionId`;
- `prePromptCursor`;
- `deliveredUserMessageId`;
- `observedAssistantMessageId`;
- visible reply fields;
- `attempts`;
- `acceptanceUnknown`;
- status and response state.

It does not currently have a first-class list of OpenCode `runtimePromptMessageId` values.

Phase 3 should add this carefully because exact observation needs it:

```ts
runtimePromptMessageIds: string[];
lastRuntimePromptMessageId: string | null;
lastDeliveryAttemptIdWithAcceptedPrompt: string | null;
```

Migration rule:

- schema stays backward compatible;
- missing fields default to empty/null;
- do not invalidate old ledger files;
- keep retention/pruning behavior unchanged.

Why this matters:

- `messageId` is app-level logical delivery identity.
- `runtimePromptMessageId` is OpenCode runtime prompt identity.
- Mixing them can create duplicate prompt or wrong correlation bugs.

Write rules:

- append a runtime prompt ID only after `prompt_async` endpoint acceptance;
- never append on failed-before-accept;
- keep insertion order by attempt;
- dedupe if commandStatus recovery sees the same prompt ID twice;
- include the latest prompt ID in observe calls, but preserve older IDs for late visible proof correlation.
- increment `attempts` for a new delivery attempt, not for the same accepted prompt recovered twice through commandStatus/observe.

Current app-side bridge result also does not expose `runtimePromptMessageId`. Additive fields must be threaded through:

```text
orchestrator send response
-> OpenCodeReadinessBridge recovery response
-> OpenCodeTeamRuntimeAdapter result
-> TeamProvisioningService ledger write
```

Do not store the runtime prompt ID only in diagnostics. Diagnostics are not a durable contract.

### 4.4 Orchestrator Outcome Store Has Status Ordering Semantics

Current file:

```text
agent_teams_orchestrator/src/services/opencode/OpenCodeCommandOutcomeStore.ts
```

Current behavior:

- status order is controlled by `STATUS_RANK`;
- `safeToRetry` is derived from status;
- `prompt_submitting` with a runtime prompt ID is protected against downgrading to `failed_before_accept`;
- prune removes records only when `completedAt` exists and is old.

Phase 3 must be explicit about any new outcome status.

If adding an acceptance-fast status, for example:

```ts
"acceptance_returned"
```

then define:

- rank relative to `prompt_accepted`, `turn_observed`, `reconciled`;
- `safeToRetry=false`;
- whether `completedAt` is set;
- whether `commandStatus` reports it as accepted;
- retention behavior so pending accepted outcomes do not leak forever.

Do not overload `reconciled` for "accepted but not observed". That would make `sendMessageData.responseObservation` look more complete than it is.

### 4.5 Task Log Attribution Currently Loses Exact Session Records

Current file:

```text
src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource.ts
```

Current behavior:

```ts
const transcript = await getOpenCodeTranscript({ teamId, memberName });
if (record.sessionId && transcript.sessionId !== record.sessionId) {
  continue;
}
```

This means an attribution record with an exact `sessionId` can still be lost if `getOpenCodeTranscript()` returns the current member/lane transcript instead of that exact session.

Phase 2 must fetch by exact `sessionId` before applying this comparison. Otherwise the new evidence source will not fix recreated-session gaps.

### 4.6 Task Log Cache Key Must Include New Evidence

Current cache key:

```text
teamName::stableTaskWindowKey(task)::stableAttributionKey(attributionRecords)
```

Current TTL:

```text
1500ms
```

If Phase 2 adds ledger/session evidence, the cache key must include a stable evidence key or the source must intentionally bypass/rebuild cache when evidence changes.

Recommended:

```ts
const cacheKey = [
  teamName,
  stableTaskWindowKey(task),
  stableAttributionKey(attributionRecords),
  stableOpenCodeSessionEvidenceKey(sessionEvidence),
].join("::");
```

Without this, a task log opened just before ledger evidence appears can keep returning null until TTL expiry. TTL is short, but a deterministic cache key is still safer and makes tests predictable.

### 4.7 Runtime Transcript CLI Resolves Only Stored Records

Current file:

```text
agent_teams_orchestrator/src/cli/handlers/runtime.ts
```

Current behavior:

- CLI resolves an OpenCode session by `team/member` and optional `lane`;
- if multiple records exist, `--lane` is required;
- there is no `--session-id`.

Phase 2 must decide how exact session lookup works when the session is no longer the latest stored record.

Safe resolver rule:

```text
--session-id may select a stored record by opencodeSessionId only if it also matches team/member and optional lane.
```

If no stored record exists for that session:

- do not guess from arbitrary filesystem paths in v1;
- return a structured not-found diagnostic;
- let task log source fall back to current behavior.

This avoids a broad and risky historical-session scan.

### 4.8 Turn-Settled Review Findings Are Regression Gates For Phase 3

Before changing acceptance semantics, the OpenCode turn-settled observer must satisfy these rules:

- same-session `session.error` during `submitting` is buffered until endpoint acceptance;
- premature SSE EOF before terminal idle is distinguishable from ordinary timeout;
- observed wrapper rejects `noReply` at the wrapper boundary;
- `session.status idle` and deprecated `session.idle` do not double-emit;
- error wins over later idle for the same accepted prompt.

Current code already appears to have tests and implementation for several of these cases. Treat this section as a regression gate, not a mandate to rewrite working observer code.

Rule for implementation:

```text
if a current test already proves the invariant, keep it and add only missing coverage.
```

If these regress, accept-fast delivery can make diagnostics less reliable and can produce false member-work-sync wakeups.

### 4.9 `observeMessageDelivery` Is Also Current-Session Oriented

Current files:

```text
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts
```

Current app-side observe input carries:

- `teamName`;
- `laneId`;
- `memberName`;
- `messageId`;
- `prePromptCursor`.

It does not carry:

- `runtimeSessionId`;
- `runtimePromptMessageId`;
- `deliveryAttemptId`;
- `payloadHash`.

That is risky after session recreate:

```text
prompt accepted in session A
-> session/lane registry later points to session B
-> watchdog calls observeMessageDelivery
-> observe inspects session B and reports not observed
```

Phase 3 must make observation exact when acceptance produced runtime identity. The observe command should prefer:

```text
runtimeSessionId + runtimePromptMessageId
```

then fall back to:

```text
prePromptCursor in current member/lane session
```

only when old ledger records do not have runtime prompt identity.

Do not add exact transcript lookup in Phase 2 but leave observe path current-session-only in Phase 3. That would fix UI logs while keeping delivery proof fragile.

### 4.10 Attributed Task Logs Currently Cache And Segment By Member

Current file:

```text
src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource.ts
```

Current attributed path uses:

```ts
const transcriptCache = new Map<string, Transcript | null>(); // key: memberName
const projectedByParticipant = new Map<string, MemberProjectedMessages>(); // key: participant
```

This is unsafe when one member has multiple OpenCode sessions:

```text
record 1 -> bob / session A
record 2 -> bob / session B
```

If cache key is only `bob`, the second record can reuse the first transcript and be skipped or merged incorrectly. If segment key is only participant, messages from multiple runtime sessions can be merged under one actor/session.

Phase 2 must isolate by session:

```ts
type TranscriptCacheKey = `${memberKey}::${laneId ?? ""}::${sessionId ?? "current"}`;
type ProjectionGroupKey = `${participantKey}::${sessionId ?? "current"}`;
```

Renderer filters can still show one participant named `bob`, but segment identity and actor session must remain exact. This preserves provenance without changing user-facing participant labels.

### 4.11 Ledger `accepted` Is Still An Active Delivery Slot

Current file:

```text
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
```

Current `getActiveForMember()` excludes only terminal records, and `isTerminalForAutomaticSelection()` treats:

```text
failed_terminal
responded
```

as terminal, except a special plain-text response case that still needs read/proof handling.

Phase 3 must not make `accepted` terminal. A record with:

```text
status = accepted
responseState = pending | not_observed | tool_error | prompt_delivered_no_assistant_message
```

must continue blocking later prompts for the same member/lane until proof, terminal failure, or existing retry policy says it is safe.

This mirrors production queue patterns: prompt acceptance is like a visibility lease, not job completion. SQS and BullMQ style systems require idempotent processing because delivery can be at-least-once or a lock can stall; our ledger must keep the active slot until completion proof, not just endpoint acceptance.

### 4.12 Existing Inline Observation And Materialization Are Safety Nets

Current file:

```text
src/main/services/team/TeamProvisioningService.ts
```

Current delivery path has several proof passes:

- visible destination proof before sending a new prompt;
- plain-text materialization before sending a new prompt;
- observe-before-retry for non-pending records;
- inline observe after a prompt for direct user manual/tool-error cases;
- visible proof and materialization after every observation.

Phase 3 must not delete these as "old watchdog code". They are the code that clears stale banners, unblocks queued deliveries, and prevents duplicate prompts when a reply already exists.

If accept-fast adds a new observation path, route the result through the same proof/materialization functions instead of duplicating read-commit logic.

### 4.13 Normal Delivery And Work-Sync Have Different Proof Contracts

Current files:

```text
src/features/team-management/adapters/opencode/OpenCodeTeamRuntimeAdapter.ts
src/main/services/team/TeamProvisioningService.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
```

Normal OpenCode runtime delivery currently instructs the model to:

```text
call agent-teams_message_send
include source="runtime_delivery"
include relayOfMessageId
include exact taskRefs when present
if message_send is unavailable/not connected/missing, write the concise reply as plain assistant text once
```

Work-sync nudges are intentionally different. They are not normal user-visible replies. A valid proof can be:

- `member_work_sync_report`;
- concrete task progress;
- a blocker/clarification update;
- in narrow cases, a visible message if the nudge explicitly asks for one.

Phase 3 must preserve this distinction. Do not make a generic "assistant output exists" rule for all delivery types.

Required DTO propagation:

```ts
interface OpenCodeDeliveryProofContext {
  messageKind?: string;
  actionMode?: "do" | "ask" | "delegate";
  taskRefs: string[];
  relayOfMessageId: string;
  workSyncIntent?: "board_sync" | "task_progress" | "unknown";
}
```

Rules:

- normal user/member delivery still needs visible/tool proof according to current read-commit policy;
- work-sync nudge proof must not be used to mark an unrelated normal delivery as responded;
- plain text fallback remains a last-resort materialization path, not a broad success path;
- accept-fast may return early only for prompt acceptance, not for proof;
- exact observe must pass enough context to preserve these proof rules.

Tests must include:

- normal delivery with `message_send` tool error plus plain assistant text remains pending unless materialization/semantic proof passes;
- work-sync nudge with valid `member_work_sync_report` does not require `message_send`;
- work-sync nudge proof does not unblock a previous normal delivery for the same member;
- missing `taskRefs` in normal task-linked delivery stays retryable/pending.

### 4.14 `BoardTaskLogStreamService` Merge Can Drop Unsafe Segment IDs

Current file:

```text
src/main/services/team/taskLogs/stream/BoardTaskLogStreamService.ts
```

Runtime fallback is merged by `segment.id`. If OpenCode fallback emits:

```text
opencode-attributed:<team>:<task>:bob
```

for two different sessions, the second segment can be dropped or merged incorrectly.

Phase 2 must make segment IDs session-aware:

```text
opencode-attributed:<team>:<task>:bob:<sessionId>
opencode-heuristic:<team>:<task>:bob:<sessionId-or-current>
```

Also watch the service-level layout cache. It is keyed around team/task/transcript discovery generation, while OpenCode fallback has its own short cache. If exact session evidence appears after the first empty render, the stream must not keep serving a stale "only MCP" or empty summary.

Source-audit confirmation:

```text
BoardTaskLogStreamService.shouldMergeRuntimeFallback()
  returns false when any activity record has linkKind === "execution"
```

This is too coarse for the exact-session OpenCode fix. A primary transcript can contain an execution slice from a different session/provider while the OpenCode owner session still needs fallback projection.

Rules:

- session-specific fallback segments must have stable session-specific IDs;
- merge dedupe should still remove identical tool/message rows by source ID or native tool signature;
- OpenCode merge dedupe must include `sessionId` before source ID; native tool signatures are only safe inside the same session;
- cache key must include OpenCode evidence generation/session candidate identity;
- runtime fallback suppression must be session/member/provider-aware, not just "any execution record exists";
- an unrelated execution slice must not hide exact-session OpenCode native tools;
- no user-visible debug rows for cache misses;
- diagnostics should say `exact_session_candidate_cache_miss` or `fallback_segment_deduped` only in developer metadata/logs.

Tests must include:

- primary stream plus OpenCode fallback with same participant but different sessions preserves both safe segments;
- existing execution record from another session/provider does not suppress exact OpenCode fallback;
- exact session evidence appearing after a previous empty render invalidates the OpenCode source cache;
- duplicate retry MCP markers do not duplicate native tool rows;
- native tools from session B are not merged into session A's segment.

### 4.15 Member-Work-Sync Already Has Rate And Busy Controls

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.ts
src/renderer/utils/teamMessageFiltering.ts
```

Current timings:

```text
turn_settled/tool_finished -> runAfter about 5s
task_changed/inbox_changed/runtime_activity -> runAfter about 15s
startup/config/member_spawned -> runAfter about 30s
```

The dispatcher also has:

- recent-delivery rate limits;
- busy-signal suppression;
- watchdog cooldown checks;
- a short delivery wake after a nudge is scheduled.

This is good. Do not bypass it from accept-fast or task-log work.

Important UI invariant:

```text
WORK SYNC messages are hidden from the normal Messages feed by default.
```

`filterTeamMessages()` currently excludes member-work-sync nudges unless `includeMemberWorkSyncNudges=true`. Keep that behavior. Sync pings are control-plane activity and belong in audit/debug details, not the user's main conversation.

Rules:

- turn-settled can enqueue member-work-sync reconcile;
- member-work-sync should not be used as normal delivery response proof;
- delivery watchdog owns normal response proof retry;
- task-stall watchdog owns semantic task progress stalls;
- if delivery watchdog already nudged the same member/task recently, member-work-sync should stay suppressed;
- if work-sync already nudged a member/fingerprint recently, task-stall should avoid immediate duplicate "please continue" copy when possible.

Tests must include:

- turn-settled event enqueues reconcile but does not itself send a visible message;
- member-work-sync nudge stays hidden in normal Messages filtering;
- a work-sync nudge does not mark a normal OpenCode delivery read/responded;
- watchdog cooldown suppresses immediate duplicate work-sync nudge.

### 4.16 Timeout Recovery Must Preserve Runtime Prompt Identity

Current file:

```text
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
```

Current timeout recovery calls `opencode.commandStatus`. If `status.sendMessageData` is present, it returns that data. If not, it synthesizes an accepted response from status fields.

Fragile point:

```text
synthesized accepted response must include runtimePromptMessageId when status has it
```

Otherwise the app records:

```text
accepted=true
sessionId=...
runtimePromptMessageId missing
```

That breaks exact observe and task-log session evidence precisely in the timeout-recovery path, which is the path accept-fast is supposed to make safer.

Required contract:

```ts
interface OpenCodeSendMessageCommandData {
  accepted: boolean;
  sessionId?: string;
  runtimePromptMessageId?: string;
  prePromptCursor?: string | null;
  // existing fields...
}
```

Rules:

- `opencode.commandStatus` accepted response always returns runtime prompt identity if known;
- `OpenCodeReadinessBridge.recoverTimedOutSendMessage()` copies it into the synthesized response;
- `OpenCodeTeamRuntimeAdapter.sendMessageToMember()` exposes it to `TeamProvisioningService`;
- tests cover timeout recovery with and without `sendMessageData`.

### 4.17 Turn-Settled Spool Schema Is Consumed By Member-Work-Sync

Current files:

```text
agent_teams_orchestrator/src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.ts
agent_teams_orchestrator/src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.ts
src/features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer.ts
```

The normalizer accepts a narrow schema:

```text
provider = opencode
source = agent-teams-orchestrator-opencode
eventName = runtime_turn_settled or hookEventName = Stop
sessionId
teamName/memberName
runtimePromptMessageId -> threadId
```

Phase 3 must not rename these fields casually. If the orchestrator changes event names or source strings, member-work-sync will silently stop receiving OpenCode turn-settled wakeups.

Rules:

- keep `schemaVersion: 1` backward compatible unless both sides migrate in one cut;
- keep `source` stable;
- keep `hookEventName: "Stop"` even though this is orchestrator-native, because the shared normalizer intentionally treats runtime-turn-settled like a provider stop/settled event;
- include `runtimePromptMessageId` when known so `threadId` remains stable;
- include `outcome` but do not let member-work-sync treat outcome as delivery proof.

Tests must cover:

- current emitted payload normalizes to a member-work-sync turn-settled event;
- missing/renamed `source` is rejected;
- missing `runtimePromptMessageId` still creates a session-level event, but cannot be used for exact prompt proof.

### 4.18 Advisory Banners Depend On Terminal/Error Classification

Current files:

```text
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy.ts
src/main/services/team/TeamMemberRuntimeAdvisoryService.ts
src/main/services/team/TeamDataService.ts
```

The advisory policy suppresses or defers generic/proof-missing issues, but hard states such as `tool_error`, `session_error`, `permission_blocked`, and `reconcile_failed` can surface quickly.

Phase 3 must avoid mapping ordinary post-acceptance observation lag to a hard error.

Additional fragile point:

```text
TeamMemberRuntimeAdvisoryService caches member/team advisories for 30 seconds.
```

The service already exposes:

```ts
invalidateMemberAdvisory(teamName, memberName)
invalidateTeamAdvisories(teamName)
```

and `TeamDataService` wraps them as:

```ts
invalidateMemberRuntimeAdvisory(teamName, memberName)
invalidateTeamRuntimeAdvisories(teamName)
```

This is important because a stale warning can remain visible even after the member replied, unless the proof write path invalidates this cache. Do not rely on the cache TTL for correctness.

Current app bootstrap already wires:

```ts
teamProvisioningService.setMemberRuntimeAdvisoryInvalidator((teamName, memberName) => {
  teamDataService?.invalidateMemberRuntimeAdvisory(teamName, memberName);
  getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName, memberName);
});
```

Phase 3 must keep using this boundary. If async observation/proof code is extracted out of `TeamProvisioningService`, it should receive a small invalidation port instead of importing `TeamDataService` directly.

Source-audit warning:

```text
TeamDataWorkerClient.invalidateMemberRuntimeAdvisory()
  silently returns when teamName/memberName does not match SAFE_NAME_RE.
```

That is safe for IPC, but fragile for cache consistency. If a future member name contains spaces or other characters that fail the worker-safe regex, a member-scoped invalidation can update only the in-process cache and leave the worker cache stale.

Rules:

- keep member names canonical and worker-safe at the invalidation boundary;
- if member name validation fails or canonicalization is uncertain, fallback to team-scoped invalidation rather than doing nothing;
- do not reuse attribution-store name regexes for unrelated user-visible member validation;
- add one test where member-scoped worker invalidation is rejected and the invalidation port falls back to team-scoped invalidation.

Rules:

- `turn_observation_timeout` after prompt acceptance should stay pending/deferred, not `failed_terminal`;
- `stream_unavailable` is a diagnostic and retry signal unless response proof also fails;
- `tool_error` remains hard because it means the model actually hit a broken tool;
- if visible reply/task progress proof arrives after a warning candidate, `hasSupersedingOpenCodeRuntimeDeliveryProof()` must suppress the advisory;
- successful proof should clear the UI banner without waiting for a full cache TTL.
- every ledger transition that creates proof, materializes a visible reply, marks read after proof, or records task progress proof must invalidate the affected member advisory cache;
- invalidation must be member-scoped when the member is known, team-scoped only when the proof path cannot safely identify the member;
- renderer code must not clear the banner optimistically without backend proof, because that hides real tool/session failures.

Tests must include:

- accepted prompt + observation timeout does not immediately surface a user warning;
- accepted prompt + tool_error can surface after proof grace/policy says so;
- visible reply after an error candidate suppresses advisory;
- task progress after a proof-missing candidate suppresses advisory when policy allows.
- warning candidate cached first, then visible reply proof arrives, then the next team snapshot has no runtime advisory without waiting 30 seconds;
- proof for `bob` invalidates `bob` only and does not erase unrelated hard advisory for `jack`.

### 4.19 Task Log Stream Is Not The File-Change Ledger

Current file:

```text
src/main/services/team/ChangeExtractorService.ts
```

Task Log Stream answers:

```text
what did the runtime/tool transcript show for this task?
```

The Changes panel answers:

```text
what file changes can be proven for this task?
```

These are related but not interchangeable. OpenCode native `write`/`edit` tool rows can help a user understand activity, but they are not a reliable file-change ledger by themselves. The existing changes path uses task-change ledgers, persisted summaries, worker computation, and OpenCode backfill with its own cache/in-flight behavior.

Rules:

- Phase 2 must not synthesize file changes directly from task-log tool rows;
- if Changes needs improvement, do it through `ChangeExtractorService`/task-change ledger/backfill in a separate cut;
- task-log native tool visibility can be used as a diagnostic that work happened, not as an authoritative diff;
- avoid coupling task-log cache invalidation to task-change summary cache unless intentionally designed.

Tests for this plan should assert task-log stream rows appear, not that Changes panel file diffs become non-empty.

### 4.20 Payload Hash Is An Idempotency Contract, Not A Debug Detail

Current files:

```text
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
```

Current behavior:

```ts
function buildSendPayloadHash(input: OpenCodeSendMessageCommandBody): string {
  const { payloadHash: _payloadHash, ...hashable } = input;
  return stableHash(hashable);
}
```

The prompt delivery ledger also fails an existing logical message terminally if the current inbox row payload hash no longer matches the existing ledger payload hash.

Fragile point:

```text
adding transport-only fields to OpenCodeSendMessageCommandBody can change payloadHash
```

Examples of fields that should not change the logical delivery payload:

- `settlementMode`;
- local timeout budget;
- observation mode;
- debug flags;
- runtime prompt identity returned after acceptance.

Rules:

- define a canonical send payload hash shape explicitly;
- hash user-visible/logical delivery fields and idempotency fields, not observation transport knobs;
- do not include `runtimePromptMessageId` in send payload hash because it is produced after acceptance;
- if `settlementMode` is added, decide explicitly whether it is excluded from `payloadHash`;
- add contract tests for hash stability before and after adding new optional fields.

Recommended shape:

```ts
type OpenCodeSendPayloadHashShape = Pick<
  OpenCodeSendMessageCommandBody,
  | "runId"
  | "laneId"
  | "teamId"
  | "teamName"
  | "projectPath"
  | "memberName"
  | "text"
  | "messageId"
  | "deliveryAttemptId"
  | "fileParts"
  | "actionMode"
  | "messageKind"
  | "taskRefs"
  | "agent"
  | "noReply"
>;
```

If this shape changes, update both app-side recovery tests and orchestrator precondition mismatch tests.

### 4.21 Versioned JSON Stores Make "Optional" Fields Still Risky

Current files:

```text
src/main/services/team/opencode/store/VersionedJsonStore.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
```

`VersionedJsonStore.updateLocked()` validates the whole next data set before writing. A new field can break old data if the validator becomes stricter than the migration.

Rules for ledger fields like `runtimePromptMessageIds`:

- parser accepts missing fields on old records;
- writer normalizes missing fields into safe defaults only when the record is touched;
- schema version stays compatible unless a real migration is required;
- no existing ledger file should be quarantined only because it lacks new optional fields;
- tests must read an old schema-1 fixture, update one record, and verify old untouched records still validate.

Do not rely on TypeScript optionality alone. The runtime validator is the real compatibility boundary.

### 4.22 Acceptance Unknown Is A Separate State From Accepted

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy.ts
```

Current delivery path can mark:

```text
acceptanceUnknown = true
status = retry_scheduled
reason = opencode_prompt_acceptance_unknown_after_bridge_timeout
```

Phase 3 must not collapse this into accepted. Acceptance unknown means:

```text
the app does not know whether prompt_async reached OpenCode
```

It is not the same as:

```text
prompt_async accepted and runtimePromptMessageId known
```

Rules:

- if commandStatus cannot prove acceptance, keep `acceptanceUnknown`;
- do not write a fake `runtimePromptMessageId`;
- observe/status recovery can later upgrade it to accepted if exact prompt evidence is found;
- retry policy must still avoid duplicate prompt as much as possible, but it cannot use exact observe without a prompt ID.

Tests:

- bridge timeout with no commandStatus acceptance stays `acceptanceUnknown`;
- bridge timeout recovered with `runtimePromptMessageId` upgrades to accepted and clears `acceptanceUnknown`;
- accepted state never has `acceptanceUnknown=true`.

### 4.23 There Are Two Payload Hash Layers

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
```

The source audit shows two different hash concepts:

```text
app ledger logical payload hash:
  hashOpenCodePromptDeliveryPayload()

bridge command precondition hash:
  OpenCodeReadinessBridge.buildSendPayloadHash()
```

They solve different problems.

The app ledger hash decides whether the same inbox message still represents the same logical delivery. It currently hashes:

```text
text, replyRecipient, actionMode, taskRefs, attachments metadata, source
```

The bridge command hash protects commandStatus recovery and orchestrator precondition matching. It currently hashes almost the full OpenCode send command body except `payloadHash` itself.

Risk:

If Phase 3 adds `settlementMode`, observation timeout, runtime prompt fields, or debug flags to the bridge command body, only the bridge hash should be considered for precondition recovery. The app ledger hash must not change unless the user-visible/logical delivery changes.

Rules:

- do not reuse the app ledger payload hash as the orchestrator command hash;
- do not add transport/observation fields to `hashOpenCodePromptDeliveryPayload()`;
- define a canonical bridge send-hash shape before adding `settlementMode`;
- `runtimePromptMessageId` must not be in either send hash because it is produced after acceptance;
- if app logical payload changes, keep existing terminal payload mismatch behavior;
- if only observation transport knobs change, neither app ledger hash nor bridge precondition hash should create a false logical mismatch.

Tests:

- changing `settlementMode` does not change app ledger hash;
- changing observation timeout/debug fields does not create app ledger payload mismatch;
- changing text/taskRefs/actionMode still changes app ledger hash;
- commandStatus recovery still rejects a truly different bridge command.

### 4.24 Task Progress Proof Is Coarse And Must Stay In Its Lane

Current files:

```text
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader.ts
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching.ts
src/main/services/team/TeamProvisioningService.ts
```

`OpenCodeRuntimeDeliveryProofReader` can compute `taskProgressAt` from task comments/history by the same member and task after the prompt time. This is useful for advisory suppression, because it proves the member did some board-visible work after the runtime delivery.

It is not the same as normal message delivery proof.

Risk:

For a user/member visible message, a task comment by the owner can be enough to suppress a stale warning, but it must not automatically mark the original inbox row read/responded unless the existing `TeamProvisioningService` read-commit policy says that response state/action mode/task refs make it acceptable.

Rules:

- `taskProgressAt` can suppress runtime advisory candidates when policy allows;
- `taskProgressAt` cannot replace `agent-teams_message_send` proof for normal direct replies;
- `taskProgressAt` cannot clear a peer relay that required a visible reply to a specific recipient;
- weak start-only comments should not be treated as strong progress by any new fast path;
- work-sync and task-stall paths may use board progress, but only under their own proof contracts;
- keep final read/responded decision centralized in `TeamProvisioningService` proof helpers.

Tests:

- task comment after prompt suppresses advisory but does not mark a normal direct message read unless read-commit policy allows;
- peer relay with task comment but no correct recipient reply stays pending;
- weak start-only task comment does not count as strong completion proof;
- work-sync report/progress does not unblock unrelated normal delivery.

### 4.25 OpenCode Task-Log Attribution Store Is A Compatibility Boundary

Current files:

```text
src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionStore.ts
src/main/services/team/taskLogs/stream/OpenCodeTaskLogAttributionService.ts
```

The attribution store is deliberately tolerant on read and strict on write:

```text
read side:
  supports schemaVersion=1
  supports both tasks[taskId] and legacy records[]
  ignores malformed/oversized/timeout records by returning []

write side:
  validates team/task/member names
  validates task_session requires sessionId
  validates member_session_window requires since or startMessageUuid
  writes canonical tasks{} shape
  caps file size at 512KB
```

Phase 2 must preserve this behavior. Exact session evidence should be added through the attribution service or a narrow evidence source, not by sprinkling raw file writes in task-log projection code.

Rules:

- keep read compatibility for both `tasks` and legacy `records`;
- keep malformed attribution files non-fatal for user task logs;
- keep writer validation strict and explicit;
- do not increase the 512KB file cap without a separate performance review;
- exact delivery-ledger evidence can be read separately, but if persisted into attribution, use `OpenCodeTaskLogAttributionService`;
- attribution audit fields (`createdAt`, `updatedAt`, `source`) must not be used as segment identity.

Tests:

- legacy `records[]` attribution file still reads;
- malformed attribution file returns fallback/empty without crashing stream;
- `task_session` without sessionId is rejected on write;
- oversized attribution file does not block normal task-log response;
- changing only attribution audit fields does not create duplicate segments.

### 4.26 Message Kind Enums Drift Across Boundaries

Current files:

```text
src/shared/types/team.ts
src/main/services/team/TeamInboxReader.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/renderer/utils/teamMessageFiltering.ts
src/shared/utils/teamAutomationMessages.ts
```

Source-audit finding:

```text
InboxMessageKind includes task_stall_remediation
OpenCodeSendMessageCommandBody includes task_stall_remediation
OpenCodePromptDeliveryLedger validator currently does not accept task_stall_remediation
TeamInboxReader currently does not preserve task_stall_remediation from stored rows
```

This is easy to miss because normal runtime delivery mostly uses `member_work_sync_nudge`, `task_comment_notification`, or default messages. But any plan that relies on message kind as proof context must keep all boundary whitelists in sync.

Rules:

- every new or existing `InboxMessageKind` used by OpenCode delivery must be accepted by:
  - shared type;
  - inbox reader;
  - ledger validator;
  - bridge command contract;
  - renderer filtering helpers;
- do not add proof policy that depends on a message kind before the kind survives read/write roundtrip;
- if a kind is intentionally not supported by OpenCode delivery ledger, document and reject it before ledger creation with a structured diagnostic;
- add enum parity tests rather than relying on TypeScript types.

Tests:

- `task_stall_remediation` round-trips through inbox reader when persisted;
- OpenCode delivery ledger either accepts `task_stall_remediation` or rejects it before store validation with a clear reason;
- renderer automation filtering still hides automation rows by default after message kind roundtrip;
- adding a future `InboxMessageKind` fails a parity test until all whitelists are updated.

### 4.27 Repair Control Text Must Not Become The Logical Payload

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy.ts
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
```

Source-audit finding:

```text
hashOpenCodePromptDeliveryPayload() is computed from original logical input.text
buildOpenCodePromptDeliveryAttemptText() prepends retry/control text later
```

This order is important. Repair control text is transport/retry instruction, not a new user-visible logical message. If the implementation starts hashing the final `deliveryText`, every retry can look like a payload mismatch for the same inbox row.

Rules:

- keep app ledger payload hash based on the original logical message, not retry control text;
- bridge command hash may include actual prompt text sent to OpenCode, because it protects one concrete command attempt;
- `deliveryAttemptId` must distinguish retry attempts when control text changes;
- retry control text must never be persisted as the user message text or shown as the original inbox message;
- tests must assert that adding retry control text does not mutate the app ledger payload hash.

### 4.28 `message_send` Tool Error Needs Transport Repair, Not Only Better Prompt Text

Current files:

```text
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy.ts
src/main/services/team/TeamProvisioningService.ts
```

Current OpenCode runtime prompt intentionally says:

```text
If message_send returns an unavailable, not connected, or missing-tool error,
write the exact concise reply as plain assistant text once, then stop.
```

That is useful as a last-resort semantic fallback, but it also means a broken MCP connection can produce a plausible assistant response that is still not visible in the app.

Rules:

- before every retry prompt, run the same MCP/session readiness gate as first delivery;
- if readiness repair fails, do not send another repair prompt into the broken session;
- `message_send` tool error should stay a hard transport/protocol signal until visible reply materialization or exact proof succeeds;
- plain-text materialization remains allowed only through the existing direct-user semantic gate;
- do not broaden plain-text materialization to peer relays or task-linked replies without exact recipient/task proof.

Tests:

- `message_send` tool error with plain assistant text still triggers MCP/session repair before any retry prompt;
- failed readiness repair keeps the ledger pending/retryable and does not send another prompt;
- direct-user semantically sufficient plain text can materialize as visible proof;
- peer relay plain text with no correct recipient stays pending.

### 4.29 Visible Reply Recovery Can Overmatch Old Inbox Rows

Current files:

```text
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
isOpenCodeRecoveredVisibleReplyCandidate()
  accepts message.source === undefined for compatibility
  allows timestamp up to 5 seconds before inboxTimestamp
  can recover by taskRefs without relayOfMessageId
```

These are useful compatibility paths for older inbox rows and missing `relayOfMessageId`, but they are intentionally weaker than exact relay correlation.

Rules:

- exact `relayOfMessageId` and expected visible message ID win over taskRefs-only recovery;
- taskRefs-only recovery is a fallback, never a replacement for exact correlation when exact fields exist;
- if multiple taskRefs-only candidates exist, prefer the first eligible candidate only when all candidates point to the same member/recipient/task set and none contradict source/timestamp rules;
- do not widen the 5 second timestamp grace without a separate false-positive review;
- source-missing compatibility should be allowed only with strong taskRefs/semantic proof, and should add a diagnostic like `visible_reply_missing_runtime_delivery_source`;
- taskRefs-only recovery can attach missing taskRefs to a relay-correlated message, but must not attach unrelated taskRefs to a different visible reply.

Tests:

- relay-correlated reply beats an older taskRefs-only candidate;
- two taskRefs-only candidates with different recipients do not auto-commit read/responded;
- source-missing recovered reply records diagnostic and still requires semantic sufficiency;
- message just outside the timestamp grace does not recover.

### 4.30 Member-Work-Sync Inbox Idempotency Is Split Across Outbox And Inbox

Current files:

```text
src/features/member-work-sync/core/domain/MemberWorkSyncNudge.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
src/features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
```

Source-audit finding:

```text
JsonMemberWorkSyncStore.ensurePending()
  detects payloadHash conflict for same outbox id

MemberWorkSyncInboxNudgePort.insertIfAbsent()
  accepts payloadHash

TeamInboxMemberWorkSyncNudgeSink.insertIfAbsent()
  currently checks only existing messageId
```

That is mostly safe when the nudge ID includes enough agenda identity, but it is still a contract split. If payload text or intent semantics change while messageId stays stable, the inbox sink can return `inserted=false` for an old row and the dispatcher can treat it as delivered/existing.

Rules:

- `buildMemberWorkSyncNudgeId()` must include every field that can change the intended work-sync action, or the inbox sink must detect payload conflict;
- if inbox rows do not store payload hash, compare stable visible payload fields (`text`, `taskRefs`, `workSyncIntent`, `workSyncIntentKey`, review request IDs) before treating an existing message as equivalent;
- never schedule a delivery wake for an existing nudge whose payload no longer matches;
- if conflict is detected after inbox insertion, mark outbox terminal or retryable according to whether a new deterministic message ID can be generated safely;
- keep this separate from OpenCode prompt delivery ledger; work-sync idempotency must not reuse OpenCode delivery record IDs.

Tests:

- same work-sync messageId and same payload returns existing without duplicate inbox row;
- same work-sync messageId and different payload returns conflict;
- conflict does not schedule OpenCode delivery wake;
- review-pickup intent key changes produce a different nudge identity.

### 4.31 Member-Work-Sync Is Not Foreground Assignment Delivery

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncReconciler.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/core/domain/SyncDecisionPolicy.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
MemberWorkSyncReconciler plans nudges only from queue reconciliation.
MemberWorkSyncNudgeActivationPolicy can block nudges while phase2 metrics are collecting or unhealthy.
MemberWorkSyncNudgeDispatcher revalidates cooldown, busy signals, lifecycle, and agenda fingerprint before delivery.
Foreground unread assignments intentionally suppress duplicate work-sync nudges.
```

This means member-work-sync is not a reliable first-start transport for a newly assigned task. It is a reconciliation and anti-stall backstop after the authoritative board/inbox state exists.

Rules:

- initial task assignment and direct teammate messages must still use the normal delivery path;
- accept-fast cannot depend on work-sync to wake a member after foreground assignment delivery fails;
- work-sync can reconcile after turn-settled, task changes, inbox changes, or runtime activity, but it must not replace delivery watchdog retries;
- phase2 readiness, rate limits, busy signals, lifecycle state, and watchdog cooldowns remain valid reasons to skip a sync nudge;
- if a user sees a task assigned but no runtime logs for several minutes, debug normal delivery acceptance/observation first, then work-sync state;
- launch/bootstrap should not trigger user-visible work-sync chatter while teammates are still confirming readiness;
- sync nudges during launch must be suppressed unless they are delayed until bootstrap confirmed and no foreground unread assignment is already active.

Tests:

- foreground assignment delivery accepted but no visible proof remains owned by delivery watchdog, not member-work-sync;
- foreground unread assignment suppresses work-sync nudge even when agenda state is `needs_sync`;
- phase2 collecting metrics can skip generic sync nudge without blocking normal task assignment delivery;
- launch/bootstrap pending state does not insert visible work-sync messages;
- after a real turn-settled event and no active foreground unread assignment, work-sync may plan one idempotent nudge.

### 4.32 Task Log Stream Live Refresh Is Event-Scoped

Current files:

```text
src/renderer/components/team/taskLogs/TaskLogStreamSection.tsx
src/renderer/components/team/taskLogs/TaskLogsPanel.tsx
src/renderer/utils/teamChangeEvents.ts
src/renderer/store/index.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
TaskLogStreamSection reloads on:
  event.type === "log-source-change"
  or isTaskLogActivityChangeEvent(event) for the same taskId

isTaskLogActivityChangeEvent(event) accepts:
  taskSignalKind === "log"
  or detail starts with "opencode-runtime-task-event:"

TeamProvisioningService.recordOpenCodeRuntimeTaskEvent()
  emits task-log-change with taskSignalKind "log"
```

This means the stream is not a continuous poller. If backend exact-session evidence is written but no task-scoped event is emitted, the fixed backend can still look late or empty until another task marker, visibility change, or manual refresh.

Rules:

- when delivery ledger/session evidence becomes sufficient to query a task-scoped OpenCode session, emit a narrow `task-log-change` for each affected taskRef;
- use `taskSignalKind: "log"` for log-only refresh so renderer does not trigger unnecessary full team-data refresh;
- do not emit one event per native tool row; emit on evidence creation/update, attribution upsert, or settled observation that changes the task-log candidate set;
- include `teamName`, `taskId`, and `runId` when known;
- do not broadcast to all tasks in the team;
- hidden sections should still avoid immediate reload because the renderer already checks visibility/open state;
- summary count refresh should use the same event path as full stream reload, otherwise the badge can remain `0` while logs are available.

Tests:

- exact session evidence write emits one task-log log signal for every referenced task;
- native tool rows appearing in an exact session can be loaded after that signal without waiting for another board MCP tool;
- hidden Task Log Stream does not start heavy loading just because the signal fired;
- task log badge count updates after the signal when the task logs panel has been opened;
- unrelated taskRef does not reload the current task stream.

### 4.33 OpenCode Inbox Relay Is A Single-Member Queue

Current file:

```text
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
relayOpenCodeMemberInboxMessages()
  coalesces by team/member in openCodeMemberInboxRelayInFlight
  sorts unread messages by priority and timestamp
  gives member_work_sync_nudge lower priority than normal foreground messages
  breaks the relay loop when delivery is accepted but response is still pending

getOpenCodeMemberDeliveryBusyStatus()
  treats unread foreground messages as busy
  treats active prompt ledger record as busy
```

This is the queue boundary that prevents multiple prompts from being pushed into one OpenCode teammate at once.

Rules:

- accept-fast delivery must still break the relay loop after the accepted pending message;
- do not continue relaying later unread inbox rows just because the endpoint accepted the prompt;
- work-sync delivery wakes must go through the same relay queue and should stay behind foreground assignment/user messages;
- `onlyMessageId` wake should not bypass an in-flight relay for the same member;
- active ledger record remains the source of busy state until proof or terminal failure;
- do not introduce a separate "fast path" for member-work-sync review pickup that skips foreground/busy checks.

Tests:

- two unread foreground messages for one OpenCode member send only the first while its ledger record is accepted/pending;
- work-sync nudge waits behind unread foreground assignment;
- `onlyMessageId` wake during in-flight relay does not start a parallel prompt;
- active ledger record makes `getOpenCodeMemberDeliveryBusyStatus()` return busy for work-sync.

### 4.34 Cross-Repo OpenCode Bridge Capability Is A Hard Boundary

Current files:

```text
src/main/services/runtime/ClaudeMultimodelBridgeService.ts
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandClient.ts
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts
/Users/belief/dev/projects/claude/agent_teams_orchestrator/src/services/opencode/OpenCodeSessionBridge.ts
```

Source-audit finding:

```text
claude_team and agent_teams_orchestrator are deployed as two repos.
The app can run with an older dev runtime root.
Existing provider capability code exists, but accept-fast OpenCode delivery needs a more specific bridge command capability.
```

This is a hard compatibility boundary. If `claude_team` sends exact observe fields to an older orchestrator that silently ignores them, the app can believe it is observing the accepted prompt while the orchestrator is still using current lane/session fallback.

Rules:

- accept-fast must be enabled only when the orchestrator explicitly supports the needed OpenCode bridge capability;
- required capability should cover at least `promptAsyncWithTurnSettled`, exact `runtimePromptMessageId`, exact `runtimeSessionId`, command outcome recovery, and no-reply protection;
- add an explicit bridge protocol field, for example `opencodeDeliveryAcceptanceContractVersion`, instead of overloading generic `supportedCommands`;
- validate that contract version in the same handshake path that already validates app-managed bootstrap contracts;
- prefer an explicit capability probe or bridge status field over version-string parsing;
- if capability is missing, fall back to current observed behavior and emit a developer diagnostic like `opencode_accept_fast_capability_missing`;
- do not send required-only new fields to older commands unless the command schema is additive and old runtimes ignore them safely;
- if the app requests acceptance mode and the orchestrator returns a response without accepted runtime prompt identity, classify as `acceptanceUnknown`, not accepted;
- contract tests must simulate old orchestrator responses with missing fields, unsupported command errors, and stale commandStatus output;
- live E2E must log the detected orchestrator capability snapshot so debugging does not depend on guessing which binary was running.

Tests:

- old orchestrator fixture without accept-fast capability uses observed mode;
- orchestrator missing `runtimePromptMessageId` never upgrades ledger to accepted;
- unsupported exact observe command returns structured diagnostic and no duplicate prompt;
- capability-supported orchestrator preserves exact prompt identity through commandStatus recovery;
- no-reply call path is rejected by the observed wrapper even if a future caller bypasses the command handler.

### 4.35 Lane Registry Lock And Current-Lane State Must Not Own Exact Evidence

Current files:

```text
src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader.ts
src/main/services/team/opencode/store/VersionedJsonStore.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
lanes.json is protected by withFileLock.
OpenCode launch, reattach, stale cleanup, advisory, and recovery paths all read or write the same lane index.
Previous live failures included lanes.json lock timeout and lane registry loss while runtime pid/session evidence still existed elsewhere.
```

The exact session evidence introduced by this plan must reduce dependence on the current lane registry, not make it stronger.

Rules:

- lane registry remains the active-lane and lifecycle index, not the source of truth for an already accepted prompt;
- accepted prompt identity must be stored in the delivery ledger or command outcome store under its own bounded lock before optional lane diagnostics;
- exact observe and exact task-log lookup must try recorded `runtimeSessionId` first, even if current lane now points to a newer session;
- if lane index read fails after prompt acceptance, keep the accepted identity and record diagnostic `opencode_lane_index_unavailable_after_acceptance`;
- if lane index read fails before delivery and there is no exact runtime evidence, block delivery with structured runtime diagnostic rather than guessing a lane;
- do not hold the lane index lock while reading transcripts, writing task-log attribution, emitting renderer events, or doing network calls to OpenCode;
- lane index writes should be bounded and sequential per team, never spawned in unbounded `Promise.all` from multi-taskRef fanout;
- task-log evidence writes must not require lane index write success;
- stale or empty lane registry must not delete exact prompt evidence until existing retention and team cleanup rules say it is safe.

Tests:

- accepted prompt survives simulated `lanes.json` lock timeout during post-send diagnostics;
- exact task log lookup reads session evidence when current lane points elsewhere;
- missing lane index before first delivery returns structured blocked result;
- multi-taskRef evidence update does not issue unbounded parallel lane index writes;
- stale lane cleanup does not remove delivery ledger exact prompt identity.

### 4.36 Runtime Delivery Inbox Dedupe Must Stay A Correlation Aid

Current file:

```text
src/main/services/team/TeamInboxWriter.ts
```

Source-audit finding:

```text
sendMessage()
  uses findRuntimeDeliveryDuplicateIndex()

findRuntimeDeliveryDuplicateIndex()
  dedupes only source="runtime_delivery"
  requires same relayOfMessageId, normalized from/to, and normalized text
  returns the existing inbox messageId
  merges taskRefs into the existing row
```

This is useful for repeated visible replies after retries, but it must not become an independent proof mechanism or hide exact relay correlation bugs.

Rules:

- runtime-delivery dedupe can merge duplicate visible rows, but proof commit still belongs to the delivery ledger/watchdog correlation path;
- if inbox write returns `deduplicated=true`, downstream proof code must use the returned existing `messageId`, not the attempted new `messageId`;
- dedupe must never cross different `relayOfMessageId`;
- dedupe must never apply to `member_work_sync_nudge`, task-stall remediation, or system notifications;
- taskRef merge is safe only after same relay/from/to/text match;
- a deduped visible reply should still clear advisory and unblock the active delivery record once ledger correlation validates it;
- do not add broader text-only dedupe for OpenCode plain-text fallback;
- keep duplicate rows in debug artifacts identifiable by original delivery attempt ID when possible.

Tests:

- two identical runtime-delivery replies with the same relay dedupe and merge taskRefs;
- identical text with different `relayOfMessageId` creates separate rows;
- deduped row returns existing messageId and ledger proof uses it;
- member-work-sync nudge with the same text is not deduped as runtime delivery;
- text-only plain assistant fallback cannot satisfy runtime-delivery dedupe without relay/source proof.

### 4.37 Bridge Command Idempotency Must Survive Accept-Fast Tuning

Current files:

```text
src/main/services/team/opencode/bridge/OpenCodeStateChangingBridgeCommandService.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandLedgerStore.ts
src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts
```

Source-audit finding:

```text
createOpenCodeBridgeIdempotencyKey()
  hashes command, team, lane, run, and body

OpenCodeBridgeCommandLedger.begin()
  rejects same idempotencyKey with different requestHash
  rejects retry while status is unknown_after_timeout

OpenCodeReadinessBridge.recoverTimedOutSendMessage()
  recovers by originalRequestId, deliveryAttemptId, messageId, payloadHash, team/lane/member/run
```

Accept-fast adds transport behavior to the same send command. If `settlementMode`, observe timeout, or retry-control fields drift between retries, the bridge ledger can treat the same logical delivery as a different command or fail recovery after a timeout.

Rules:

- choose `settlementMode` before the first bridge send attempt and persist it on the app delivery ledger record;
- do not switch a pending delivery from observed to acceptance mode during retry unless a new delivery attempt ID is created and duplicate prompt risk is explicitly accepted;
- fields that are purely local observation options should not enter the bridge command body if they do not need to affect orchestrator idempotency;
- fields that the orchestrator must honor, such as acceptance mode and exact observation contract, should enter the bridge body and be part of bridge idempotency;
- `originalRequestId` must be stored before command execution so commandStatus recovery can query the exact attempt after timeout;
- orchestrator success data must echo `idempotencyKey`; otherwise `assertBridgeEvidenceCanCommitToRuntimeStores()` will reject state mutation;
- timeout recovery must preserve returned `runtimePromptMessageId` and `runtimeSessionId`, not synthesize accepted without identity;
- app ledger payload hash and bridge command request hash must be documented as different contracts and tested separately.

Tests:

- retrying the same delivery with the same persisted settlement mode reuses the same bridge idempotency semantics;
- changing settlement mode for the same delivery attempt is rejected or forces a new attempt ID;
- commandStatus timeout recovery with matching originalRequestId returns exact runtime prompt identity;
- commandStatus recovery with mismatched payloadHash or messageId does not accept;
- result without echoed idempotencyKey is rejected before ledger/advisory mutation.

### 4.38 Runtime Delivery Journal Is Separate From Prompt Delivery Ledger

Current files:

```text
src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts
src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
deliverOpenCodeRuntimeMessage()
  resolves lane and verifies runtime evidence
  calls RuntimeDeliveryService.deliver()

RuntimeDeliveryService.deliver()
  normalizes RuntimeDeliveryEnvelope
  computes payloadHash from provider/run/team/member/session/to/text/summary/taskRefs/createdAt
  builds destinationMessageId from idempotencyKey/run/team
  verifies destination before and after write
  emits team change only after verified write

RuntimeDeliveryJournalStore.begin()
  treats same idempotencyKey with different payloadHash as conflict
```

This is the OpenCode agent-to-app path used by `agent-teams_message_send`. It is not the same as the app-to-OpenCode prompt delivery ledger.

Rules:

- prompt acceptance can never be treated as runtime delivery commit;
- runtime delivery commit can be used as visible reply proof only after the destination write is verified;
- if `message_send` returns `idempotency_conflict`, do not classify it as MCP disconnected or missing tool;
- same `idempotencyKey` with changed text/taskRefs/createdAt must be rejected or explicitly re-keyed, not silently overwritten;
- if the runtime generates a retry after tool error, either preserve the same payload exactly or use a new idempotency key;
- `createdAt` is part of the current payload hash, so retry instructions and tests must not assume it is ignored;
- destination change events should stay destination-specific: `lead-message` for user messages, `inbox` for member/cross-team rows;
- runtime delivery journal reconciliation can prove a missing destination write, but it must not re-prompt OpenCode;
- do not store runtime delivery journal state in member-work-sync or prompt delivery ledger records.

Tests:

- repeated identical runtime delivery idempotencyKey returns duplicate/committed without duplicate visible row;
- same idempotencyKey with different `createdAt` or text returns conflict and no visible overwrite;
- runtime delivery commit emits the expected destination change event after verification;
- committed runtime delivery can clear a prompt delivery advisory only through the visible proof correlation path;
- runtime delivery reconciliation reports recovery needed without sending another OpenCode prompt.

### 4.39 Visible Proof Reader Must Read The Same Stores Runtime Delivery Writes

Current files:

```text
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader.ts
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching.ts
src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts
src/main/services/team/TeamSentMessagesStore.ts
src/main/services/team/TeamInboxReader.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
RuntimeDeliveryService user_sent_messages port
  writes visible user replies to sentMessages.json

OpenCodeRuntimeDeliveryProofReader
  reads inbox candidates through TeamInboxReader
  skips candidate rows whose source is not runtime_delivery
```

If direct replies to the user are stored in `sentMessages.json`, proof logic that only scans inbox rows can miss a real visible reply. That leaves advisory/watchdog state pending even though the user saw the answer.

Rules:

- visible proof reader must cover every destination kind that `RuntimeDeliveryService` can commit;
- direct user replies should be recovered from `sentMessages.json` or from committed runtime delivery journal location, not only from a synthetic user inbox;
- if runtime-delivery user messages are meant to satisfy proof by source, either write `source="runtime_delivery"` or make proof use committed journal location instead of source string;
- do not weaken proof by accepting arbitrary `lead_process` sent messages;
- `replyRecipient="user"` and lead-recipient fallback must have separate tests;
- member inbox proof remains inbox-based and must not scan sentMessages;
- cross-team proof should use its own committed location semantics, not user inbox fallback;
- advisory clearing must happen after proof reader sees the actual committed destination, not just after `RuntimeDeliveryService.deliver()` returns.

Tests:

- OpenCode direct reply to user written to `sentMessages.json` is visible to proof reader;
- unrelated `lead_process` user message does not satisfy OpenCode runtime proof;
- member-to-member runtime delivery remains inbox-only proof;
- committed runtime delivery journal location can recover proof after a missed change event;
- user proof and lead-recipient fallback do not double-count the same visible message.

### 4.40 Sent Messages Writes Need Inbox-Level Safety For Runtime Delivery

Current files:

```text
src/main/services/team/TeamSentMessagesStore.ts
src/main/services/team/TeamInboxWriter.ts
src/main/services/team/opencode/delivery/RuntimeDeliveryService.ts
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
TeamInboxWriter.sendMessage()
  uses withFileLock and withInboxLock
  verifies writes and runtime_delivery dedupe

TeamSentMessagesStore.appendMessage()
  reads sentMessages.json
  appends in memory
  writes atomically
  does not use a file lock
  trims to MAX_MESSAGES

RuntimeDeliveryService user_sent_messages port
  writes direct OpenCode replies through TeamSentMessagesStore.appendMessage()
```

That is safe enough for low-volume lead output, but it is fragile for concurrent OpenCode runtime deliveries to the user. Two members can reply at the same time, both read the old file, and the later write can drop the earlier visible proof.

Rules:

- direct user runtime delivery should use a locked append path equivalent to inbox writes;
- destinationMessageId should be checked under the same lock before appending;
- append result should tell whether the row was inserted, already existed, or could not be verified;
- trim-to-`MAX_MESSAGES` must keep the just-written row and must not silently evict a just-committed proof row;
- proof/advisory clearing should not rely only on an unlocked write result;
- do not make `TeamSentMessagesStore` own OpenCode proof semantics; expose safe append/read primitives and keep proof policy in delivery services;
- if a locked sent-message writer is added, update normal lead writes carefully so live lead overlay behavior does not duplicate sent rows;
- tests should include concurrent appends, duplicate destinationMessageId, and trim boundary.

Tests:

- two concurrent `appendMessage()` calls with different message IDs preserve both rows;
- duplicate destinationMessageId does not create duplicate sent rows;
- runtime user delivery verifies the row after locked append;
- trim at `MAX_MESSAGES` preserves the newest committed row;
- ordinary lead_process sent message behavior remains unchanged.

### 4.41 Runtime Delivery TaskRefs Shape Must Be Strict

Current files:

```text
src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
```

Source-audit finding:

```text
normalizeRuntimeDeliveryEnvelope()
  accepts taskRefs only when each item is a string
  silently filters non-string taskRefs

runtimeTaskRefs()
  maps each string to { teamName, taskId: ref, displayId: ref }

teamToolTaskRefs()
  supports structured taskRefs elsewhere, but runtime delivery does not use it
```

This is a contract boundary with the OpenCode MCP tool. If the tool prompt or future schema sends structured task refs, runtime delivery can silently drop them. That weakens visible proof matching, task links in Messages, and task-log attribution.

Rules:

- runtime `message_send` taskRefs schema must be explicit: either string IDs only or structured `TaskRef[]`, not ambiguous;
- invalid taskRefs must be rejected with a structured tool error or preserved through a normalizer, not silently filtered;
- if string refs are accepted, define whether they are real task IDs or display IDs and resolve consistently;
- prompt text and MCP schema must match the app normalizer;
- proof matching should not depend on displayId when taskId is available;
- tests must include string taskRefs, structured taskRefs, invalid mixed taskRefs, and missing taskRefs;
- if structured taskRefs are adopted, update `hashRuntimeDeliveryEnvelope()` so equivalent refs hash deterministically.

Tests:

- string taskRefs preserve task links in user and member destinations;
- structured taskRefs are either accepted and preserved or rejected with a clear error;
- mixed invalid taskRefs do not silently produce an empty taskRefs array;
- taskRefs normalization is stable across runtime delivery hash and visible proof matching;
- OpenCode prompt artifact test matches the accepted taskRefs schema.

### 4.42 Runtime Control Calls Must Not Default Unknown Secondary Member To Primary

Current file:

```text
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
deliverOpenCodeRuntimeMessage()
recordOpenCodeRuntimeTaskEvent()
recordOpenCodeRuntimeHeartbeat()
  resolve lane through resolveOpenCodeRuntimeLaneId(teamName, runId, memberName)

resolveOpenCodeRuntimeLaneId()
  checks primary runtime run
  checks in-memory secondary runtime runs
  checks tracked mixed lanes
  checks persisted launch-state member laneId
  falls back to "primary"
```

Fallback to `primary` is acceptable for true primary OpenCode teams, but risky for mixed secondary teammates when lane metadata is missing or stale. A secondary member control call should not write delivery, task-log evidence, or heartbeat under the wrong lane.

Rules:

- runtime control calls with a non-lead `memberName` should require a resolved lane that is known to belong to that member, or reject with structured stale-evidence diagnostic;
- fallback to `primary` is allowed only when the run is the primary OpenCode runtime run or the member is the configured OpenCode lead;
- if persisted lane registry is missing but committed session evidence contains the exact `runtimeSessionId/memberName/runId`, use that exact evidence rather than blind primary fallback;
- if neither lane nor exact session evidence exists, fail closed and do not write runtime delivery journal, task-log attribution, or heartbeat;
- rejection reason must distinguish `lane_unresolved`, `run_tombstoned`, and `member_not_configured`;
- recovery/debug artifacts should include the attempted memberName/runId/runtimeSessionId/lane resolution source.

Tests:

- secondary member runtime delivery with missing lane metadata rejects instead of writing under `primary`;
- primary OpenCode lead runtime delivery can still use primary lane;
- exact committed session evidence can recover lane for a secondary member when launch-state is stale;
- tombstoned run rejects runtime delivery before destination write;
- task event and heartbeat follow the same lane resolution rules as message delivery.

### 4.43 OpenCode Inbox Relay Priority Must Keep Foreground Work First

Current file:

```text
src/main/services/team/TeamProvisioningService.ts
```

Source-audit finding:

```text
getOpenCodeInboxRelayPriority()
  member_work_sync_nudge -> 30
  system_notification -> 20
  normal foreground -> 0

relayOpenCodeMemberInboxMessages()
  sorts ascending by priority, then timestamp
  delivers at most one message before breaking
  stops the loop when delivery is accepted but response proof is pending

getOpenCodeMemberDeliveryBusyStatus()
  excludes member_work_sync_nudge from foreground blockers
  blocks work-sync when unread/recent foreground messages exist
```

This is the main anti-delay invariant for OpenCode teammates. Work-sync can help after a turn settles, but it must not jump ahead of task assignment, review request, direct user message, or normal foreground teammate message.

Rules:

- keep the relay sort order explicit and covered by tests: lower priority number means earlier delivery;
- foreground messages should beat work-sync nudges unless `onlyMessageId` intentionally targets one exact automation row;
- `onlyMessageId` must be used only by controlled paths that already know the target message, not as a broad "wake this member" shortcut;
- when a foreground delivery becomes accepted-pending, the relay loop must stop and keep later work-sync messages unread;
- busy-status checks should still ignore work-sync as foreground noise, but only for deciding whether to schedule more work-sync;
- if a future work-sync path needs urgent review pickup, it must use a distinct intent and tests, not invert the global priority order;
- diagnostics should include `activeMessageKind` so skipped work-sync can be explained without showing automation rows in Messages.

Tests:

- normal unread task assignment is delivered before older `member_work_sync_nudge`;
- accepted-pending foreground delivery stops the loop and leaves later work-sync unread;
- `onlyMessageId` can deliver the targeted work-sync row without reordering the whole inbox;
- busy status reports `opencode_foreground_inbox_unread` when foreground exists and a work-sync nudge is also pending;
- review-pickup exception stays narrow and does not make all system notifications foreground blockers.

### 4.44 Automation/Work-Sync Hiding Must Stay Presentation-Only

Current files:

```text
src/main/services/team/TeamMessageFeedService.ts
src/renderer/utils/teamMessageFiltering.ts
src/shared/utils/teamAutomationMessages.ts
src/shared/utils/teamInternalControlMessages.ts
src/main/services/team/TeamInboxReader.ts
```

Source-audit finding:

```text
TeamMessageFeedService
  builds a normalized feed from inbox, lead session, sent messages, and synthetic bootstrap
  filters only internal protocol envelopes with isTeamInternalControlMessageEnvelope()

teamMessageFiltering
  hides task_stall_remediation and member_work_sync_nudge from normal UI by default
  can include automation rows for diagnostics/activity when explicitly requested

teamAutomationMessages
  identifies task_stall_remediation by kind or legacy task-stall: id prefix
  identifies member_work_sync_nudge by messageKind
```

Hiding automation from the normal Messages feed is correct, but it must not mutate durable inbox state or starve delivery/watchdog paths. UI filtering and durable delivery are different responsibilities.

Rules:

- hide `member_work_sync_nudge` and task-stall automation in renderer/feed presentation, not by deleting or marking inbox rows read;
- `TeamInboxReader` must preserve automation `messageKind` values so renderer filtering, work-sync, watchdog, and diagnostics see the same metadata;
- if main-process feed filters additional automation in the future, it must expose a debug/audit path that can still show the hidden rows;
- feed `feedRevision` may ignore hidden rows for conversational UI, but work-sync diagnostics must not depend on that revision;
- delivery relays, prompt ledgers, watchdog, and member-work-sync must read durable inbox stores directly, not the UI-filtered message feed;
- legacy ID-prefix classification is compatibility only; new rows should rely on explicit `messageKind`;
- hiding automation must not change unread counts used by the delivery queue.

Tests:

- `member_work_sync_nudge` is hidden in normal Messages but still present in raw inbox diagnostics;
- `task_stall_remediation` round-trips through `TeamInboxReader` with its `messageKind`;
- renderer diagnostic mode can include member-work-sync rows only when explicitly requested;
- hiding a work-sync row does not mark it read and does not stop OpenCode relay from delivering it when selected;
- feed cache invalidation does not become the only way to observe hidden automation writes.

### 4.45 OpenCode File-Change Backfill Is A Separate Evidence Pipeline

Current files:

```text
src/main/services/team/ChangeExtractorService.ts
src/main/services/team/TaskChangeLedgerReader.ts
src/main/services/team/opencode/bridge/OpenCodeBridgeCommandContract.ts
test/main/services/team/ChangeExtractorService.test.ts
test/main/services/team/TaskChangeLedgerReader.test.ts
```

Source-audit finding:

```text
ChangeExtractorService.runOpenCodeBackfill()
  writes a temporary delivery context file plus deliveryContextHash
  calls backfillOpenCodeTaskLedger()
  accepts imported events or current-contract duplicates-only evidence
  invalidates task change summaries only when importedEvents > 0

TaskChangeLedgerReader
  maps opencode_toolpart_write/edit/apply_patch to UI snippets
  ranks evidence by sourceImportKey and full-text availability
  can surface metadata-only fallback as manual review / unavailable content
```

Task Log Stream rows and file-change ledger evidence are related but not interchangeable. A visible `write` row in Task Log Stream does not prove a reviewable diff, and `No file changes recorded` does not prove the model did nothing if OpenCode backfill failed or only metadata-only evidence exists.

Rules:

- accept-fast changes must preserve the delivery context fields consumed by `ChangeExtractorService`: team, task, member, lane, session, taskRefs, payload hash, and evidence contract;
- OpenCode file-change recovery should remain driven by task change ledger/backfill, not by Task Log Stream native tool rows;
- metadata-only or empty toolpart rows should render as unavailable/manual-review evidence, not as successful text diffs;
- `deliveryContextHash` must be stable for the exact delivery context and must not include transient retry-control text;
- negative backfill cache entries must be invalidated when a new OpenCode delivery context appears;
- duplicates-only results are cacheable only when `opencodeTaskLedgerEvidenceContractVersion` is current;
- summary-only change extraction should await OpenCode backfill when delivery context exists, but should not hang the UI indefinitely;
- a failed backfill should add diagnostics and preserve fallback behavior, not hide existing non-OpenCode changes.

Tests:

- summary-only change extraction triggers OpenCode backfill when exact delivery context exists;
- negative OpenCode backfill cache is not reused after delivery context appears;
- current-contract duplicates-only evidence is cacheable, old-contract duplicates-only evidence is not;
- metadata-only OpenCode evidence shows manual-review/unavailable state without claiming no changes;
- delivery context hash does not change when retry-control text changes but the logical task delivery does not.

### 4.46 Runtime Store Manifest Recovery Must Not Downgrade Canonical Evidence

Current files:

```text
src/main/services/team/opencode/store/RuntimeStoreManifest.ts
src/main/services/team/opencode/store/OpenCodeRuntimeManifestEvidenceReader.ts
src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
```

Source-audit finding:

```text
RuntimeStoreManifest descriptors
  opencode.deliveryJournal -> rebuildable_from_canonical_destination
  opencode.promptDeliveryLedger -> rebuildable_from_canonical_destination
  opencode.sessionStore -> rebuildable_from_provider
  opencode.launchState / launchTransaction -> readiness_blocking
  opencode.runtimeDiagnostics -> diagnostic_only, drop_after_quarantine
```

This is the recovery boundary after partial writes, lock timeouts, corrupted JSON, or stale lane registry. Prompt delivery ledgers and runtime delivery journals are canonical delivery evidence. They must not be treated like disposable diagnostics.

Rules:

- corrupted diagnostic stores can be dropped, but prompt/runtime delivery ledgers must be recovered from canonical destinations or quarantined with clear delivery state;
- readiness-blocking launch stores can block new delivery, but cannot delete already committed prompt/runtime delivery evidence;
- rebuilding from provider must not overwrite canonical destination evidence with older session-store data;
- manifest rebuild should preserve lane-scoped file paths and not merge secondary lane evidence into primary;
- accepted prompt identity and committed runtime delivery location should be read before lane registry fallback;
- if canonical destination verification is incomplete, keep the delivery as `acceptanceUnknown` or `pending`, not `responded`;
- artifact packs should include manifest recovery actions, quarantine paths, and rebuild source so production failures are debuggable.

Tests:

- corrupted diagnostics store is dropped without changing prompt delivery ledger;
- corrupted prompt delivery ledger is not silently dropped and reports rebuild_required or quarantine;
- rebuild from provider cannot downgrade a committed runtime delivery journal row;
- stale session store does not overwrite exact accepted prompt identity;
- secondary lane manifest recovery preserves lane-specific evidence and never rewrites it as primary.

### 4.47 Stopped Teams And Tombstoned Runs Must Fence Runtime Evidence

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/opencode/store/RuntimeRunTombstoneStore.ts
test/main/services/team/RuntimeRunTombstoneStore.test.ts
test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts
```

Source-audit finding:

```text
deliverOpenCodeRuntimeMessage()
recordOpenCodeRuntimeTaskEvent()
recordOpenCodeRuntimeHeartbeat()
  all resolve laneId
  all call assertOpenCodeRuntimeEvidenceAccepted()
  then write destination/task-log/liveness evidence

RuntimeRunTombstoneStore.assertEvidenceAccepted()
  rejects missing run id
  rejects current run missing
  rejects run mismatch
  rejects tombstoned run/evidence kind

stopTeam()
  clears tracked run state
  stops secondary OpenCode lanes
  clears lane storage
  emits process stop events
```

This is the protection against "team is stopped, but OpenCode still writes messages". It must be treated as a write-boundary invariant, not just a runtime cleanup detail.

Rules:

- every OpenCode runtime-originated write must validate team/run/lane evidence immediately before the destination write;
- destination write means sent messages, member inbox, task attribution, task activity, heartbeat/liveness, prompt delivery ledger updates, advisory clearing, and task-log refresh events;
- stopped parent team must make mixed secondary lanes non-deliverable even if a stale OpenCode process still has a live HTTP host;
- tombstoned run evidence must be rejected before any user-visible message is appended;
- old run IDs after relaunch must be diagnostic-only and must not clear current warnings or unread rows;
- clearing lane storage during stop must not delete prompt/runtime delivery ledger evidence before it can be quarantined or used for debugging;
- `RuntimeStaleEvidenceError` should surface machine-readable diagnostics (`missing_run_id`, `current_run_missing`, `run_mismatch`, `run_tombstoned`) without falling back to "provider unavailable";
- any post-stop cleanup that kills orphaned OpenCode processes must be narrow: team/run/lane matched, not global `opencode serve` cleanup.

Tests:

- stopped pure OpenCode team rejects runtime `message_send` before sent-message/inbox write;
- stopped mixed OpenCode secondary lane rejects task event and heartbeat before attribution/liveness write;
- stale old run after relaunch cannot clear current member advisory or prompt delivery ledger row;
- tombstoned run with matching evidence kind rejects delivery, heartbeat, and bridge result separately;
- missing current run produces `current_run_missing` diagnostic and no user-visible message;
- cleanup of stopped team leaves delivery ledger artifacts available for artifact pack/debug;
- stale runtime process from stopped team is not recovered from persisted lane evidence after app restart.

### 4.48 Destination Writes Must Drive Cache And Advisory Invalidation

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/TeamDataService.ts
src/main/services/team/TeamDataWorkerClient.ts
src/main/workers/team-data-worker.ts
src/renderer/store/index.ts
test/renderer/store/teamChangeThrottle.test.ts
test/main/ipc/teams.test.ts
```

Source-audit finding:

```text
renderer store
  lead-message -> refresh tracked message feed only
  inbox -> refresh message feed plus structural-safety team data refresh
  member-advisory -> refresh advisory/team detail surface

team-data-worker
  invalidateTeamMessageFeed(team)
  invalidateMemberRuntimeAdvisory(team, member?)
  invalidateTeamConfig(team)
```

Several bugs in this area look like delivery bugs but are actually stale UI/cache state: the reply exists, but warning/advisory is still visible; hidden automation row exists, but diagnostics are stale; task log row exists, but badge count was cached.

Rules:

- after a successful runtime destination write, emit the same change signal that the destination's normal writer emits;
- direct user reply in sent messages should cause `lead-message` feed refresh and member-advisory invalidation;
- member inbox write should cause `inbox` refresh and member-advisory invalidation when it can satisfy proof;
- task attribution/task event write should cause narrow `task-log-change` with taskId and runId;
- advisory invalidation must be keyed by canonical member name, and unsafe/unknown names should fall back to team-scoped invalidation;
- hiding work-sync/task-stall rows from normal Messages must not suppress diagnostic cache invalidation;
- worker cache invalidation is best-effort, but failure must not block the durable destination write;
- accept-fast should return "accepted" based on prompt acceptance, not on whether renderer cache has already refreshed.

Tests:

- direct OpenCode reply to user clears runtime advisory after feed/proof refresh;
- member inbox runtime reply emits `inbox` and invalidates the correct member advisory;
- hidden work-sync row does not appear in normal Messages, but diagnostics and advisory state refresh;
- task event emits `task-log-change` and reloads stream/count without full team refresh;
- unsafe member name in invalidation falls back to team advisory invalidation;
- worker unavailable path still writes destination and logs diagnostic only.

### 4.49 Ledger Rebuild From Durable Destinations Must Stay Conservative

Current files:

```text
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/delivery/RuntimeDeliveryJournal.ts
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader.ts
src/main/services/team/TeamInboxReader.ts
src/main/services/team/TeamSentMessagesStore.ts
```

Source-audit finding:

```text
OpenCodeRuntimeDeliveryProofReader
  accepts strict relay/source proof
  must read every destination store that RuntimeDeliveryService can write

TeamInboxReader
  normalizes messageKind values
  currently must preserve automation and runtime-delivery metadata
```

If a ledger is rebuilt after corruption or version migration, it must not invent success. Rebuild from durable destination writes can prove a visible reply exists, but it cannot prove the prompt transport was accepted unless exact prompt identity also survived.

Rules:

- rebuild can mark visible proof as found only when destination row has strict relay/source/idempotency evidence;
- rebuild cannot upgrade transport state to accepted without exact runtime prompt identity or command outcome proof;
- rebuilt rows without prompt acceptance proof should be `acceptanceUnknown`, `pending`, or `responded_with_unknown_acceptance`, not normal accepted;
- read/hidden automation state must not be changed during rebuild;
- rebuilt proof must preserve `messageKind`, `source`, `relayOfMessageId`, `taskRefs`, destination kind, and destination message ID;
- rejected/stale/tombstoned run evidence must not be used as rebuild input;
- multiple plausible destination rows should keep the ledger ambiguous and advisory visible instead of guessing.

Tests:

- rebuild from strict sent-message proof clears advisory but keeps acceptance unknown when prompt identity is missing;
- rebuild ignores UI-hidden work-sync rows for normal user reply proof unless message kind matches the delivery intent;
- duplicate plausible reply candidates do not commit a single responded ledger row;
- stale run destination row cannot rebuild current run delivery state;
- taskRefs and messageKind survive rebuild and remain available to task-log/proof readers.

### 4.50 Member-Work-Sync Scheduling Must Stay Causality-Safe

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner.ts
```

Source-audit finding:

```text
MemberWorkSyncEventQueue
  default turn_settled/tool_finished delay -> 5s
  default task_changed/inbox_changed/runtime_activity delay -> 15s
  default startup/config/member_spawned delay -> 30s
  optional queueQuietWindowMs overrides most non-manual triggers

createMemberWorkSyncFeature
  reconcile(queue) writes status
  then dispatches due nudges for ready teams
  scheduled dispatcher runs every 60s
  canDispatchNudges can filter teams before delivery

MemberWorkSyncNudgeDispatcher
  revalidates agenda/status/fingerprint before insertion
  checks phase2 activation, busy signal, watchdog cooldown, rate limit
  schedules delivery wake 500ms after inbox insertion
```

This is the area most likely to create the "logs appeared after 6 minutes" class of confusion. The queue can be correct but too slow, or fast but causally wrong. The plan must protect both.

Rules:

- do not set a broad production `queueQuietWindowMs` unless every trigger timing is explicitly revalidated;
- `turn_settled` and `tool_finished` are fast consistency checks, not normal delayed watchdog nudges;
- `startup_scan`, `config_changed`, and `member_spawned` should not deliver nudges until launch/bootstrap readiness says the team can dispatch nudges;
- nudge delivery must pass `canDispatchNudges`, agenda fingerprint revalidation, busy signal, watchdog cooldown, and rate-limit checks immediately before inbox insertion;
- foreground unread work must suppress generic work-sync nudge delivery, not just hide it from UI;
- accepted-pending OpenCode delivery must keep work-sync queued behind it, not trigger a second simultaneous prompt;
- event queue diagnostics must expose queued age, trigger reasons, runAt, maxRunAt, running age, and rerunRequested;
- scheduled dispatcher should be recovery-only for due outbox rows, not the primary latency path for fresh task assignment.

Tests:

- `turn_settled` reconcile runs on the fast policy and is not delayed by broad quiet window defaults;
- `startup_scan` during launch materializes status but does not deliver a nudge before `canDispatchNudges` is true;
- foreground unread task assignment suppresses generic work-sync nudge even when work-sync outbox row exists;
- accepted-pending OpenCode delivery causes work-sync dispatch to retry later without another prompt;
- scheduled dispatcher can recover an already due outbox row after app restart;
- queue diagnostics show the reason a member was delayed instead of leaving only "Waiting for response".

### 4.51 Delivery Latency Breadcrumbs Must Be End-To-End And Correlatable

Current files:

```text
src/main/services/team/TeamProvisioningService.ts
src/main/services/team/OpenCodeReadinessBridge.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/features/member-work-sync/core/application/MemberWorkSyncAudit.ts
src/features/member-work-sync/main/infrastructure/FileMemberWorkSyncAuditJournal.ts
test/main/services/team/openCodeLiveTestHarness.ts
```

Source-audit finding:

```text
OpenCode delivery, runtime proof, task logs, task activity, and member-work-sync
currently have separate journals/diagnostics.
That is correct architecturally, but hard to debug unless IDs are correlated.
```

If a task starts 6 minutes after assignment, we need to know which segment was slow: inbox write, relay selection, MCP repair, prompt acceptance, model turn, runtime tool failure, task log projection, or work-sync nudge dispatch.

Rules:

- keep journals separate by responsibility, but include a common correlation set: `teamName`, `memberName`, `taskId`, `messageId`, `relayOfMessageId`, `deliveryAttemptId`, `runtimeSessionId`, `runtimePromptMessageId`, `laneId`, `runId`;
- capture timestamps for key phases: task created, inbox written, relay selected, MCP-ready check, prompt accepted, turn settled, first task tool, first native tool, visible proof, task completed, work-sync queued/planned/delivered/skipped;
- diagnostics must be developer/audit metadata, not normal chat rows;
- latency report should be read-only and derived from existing ledgers where possible;
- do not add a single mega-log writer to multiple layers; each layer records its own event with shared correlation fields;
- live E2E should print a compact phase table for failures and slow passes.

Tests:

- dry fixture can build a complete timeline from ledgers without reading UI state;
- missing phase is reported as `missing:<phase>` with the previous known phase;
- slow phase detection identifies relay wait vs prompt wait vs model/tool wait;
- hidden work-sync rows do not disappear from the latency timeline;
- stale-run evidence is shown as rejected phase, not as a gap.

### 4.52 Member Status Presentation Must Not Hide Runtime Failures Behind Task Labels

Current files:

```text
src/renderer/utils/memberLaunchDiagnostics.ts
src/renderer/utils/teamProvisioningPresentation.ts
src/renderer/components/team/members/MemberHoverCard.tsx
src/renderer/components/team/TeamProvisioningBanner.test.ts
test/renderer/utils/memberLaunchDiagnostics.test.ts
test/renderer/utils/teamProvisioningPresentation.test.ts
```

Source-audit finding:

```text
member cards can show task-centric state such as "working on"
runtime launch/spawn/advisory state is computed separately
OpenCode secondary lanes can be failed_to_start, registered_only, runtime_pending_bootstrap, or confirmed_alive
```

The UI must not let a task label imply that a failed or unbootstrapped OpenCode member is actually working. This is a presentation invariant, but it protects debugging and user decisions.

Rules:

- runtime failure/bootstrap-pending/advisory state has higher visual priority than "working on";
- task label can remain visible as assigned work context, but must not replace failed/registered/bootstrap status;
- `registered_only` and `runtime_process without bootstrap` should be surfaced as runtime state, not inferred as online;
- Worktree badge remains independent from runtime health;
- member detail/hover card should expose laneId/sessionId/path diagnostics when available;
- renderer selectors should prefer canonical spawn status snapshot over stale cached roster/task data;
- stale spawn-status fetch after offline/stopped must not resurrect a member as working.

Tests:

- member with assigned task plus `failed_to_start` shows failure state and task context;
- `registered_only` OpenCode member shows registered/bootstrap warning, not working;
- current task assignment does not suppress runtime advisory;
- stale spawn-status fetch after stopped team is ignored;
- hover card shows runtime diagnostic and task label separately.

### 4.53 OpenCode Tool-Error Plain Text Fallback Must Not Become A Dead End

Current files:

```text
src/main/services/team/OpenCodePromptDeliveryRepairPolicy.ts
src/main/services/team/OpenCodeRuntimeDeliveryDiagnostics.ts
src/main/services/team/TeamMemberRuntimeAdvisoryService.ts
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader.ts
test/main/services/team/OpenCodePromptDeliveryRepairPolicy.test.ts
test/main/services/team/OpenCodeRuntimeDeliveryDiagnostics.test.ts
```

Source-audit finding:

```text
OpenCode can produce a transcript-only assistant answer after message_send returns Not connected.
The user may see the text in task logs, but the app has no durable visible reply unless runtime delivery wrote the destination.
```

This is the exact "model says it will provide summary as plain text" class of bug. It should trigger repair/retry semantics, not be accepted as a completed app delivery.

Rules:

- transcript-only plain text after `message_send` tool error is not visible proof;
- `mcp_not_connected`, `tool_missing`, `destination_write_failed`, and idempotency conflict remain separate diagnostics;
- repair prompt can reference the plain-text content, but must still require a real destination write or task progress proof;
- work-sync/task-stall may consider substantive task board changes as progress, but not a transcript-only "I will send";
- if the model completed task files but failed to notify, Changes/task ledger can show work while delivery advisory remains actionable;
- no automatic duplicate user-visible reply should be synthesized by the app from transcript text.

Tests:

- `message_send Not connected` plus assistant plain text remains pending/proof-missing;
- MCP readiness repair runs before the next retry prompt;
- existing task changes remain visible in Changes/Task Log even while reply advisory stays pending;
- idempotency conflict does not trigger MCP reattach;
- a later real `runtime_delivery` destination write clears the advisory.

### 4.54 Agenda Fingerprint Must Not Churn On Presentation-Only Changes

Current files:

```text
src/features/member-work-sync/core/domain/ActionableWorkAgenda.ts
src/features/member-work-sync/core/domain/AgendaFingerprint.ts
src/features/member-work-sync/main/adapters/output/TeamTaskAgendaSource.ts
test/features/member-work-sync/core/ActionableWorkAgenda.test.ts
```

Source-audit finding:

```text
buildActionableWorkAgenda already hashes canonical actionable items and generatedAt is not part of the fingerprint.
TeamTaskAgendaSource currently does not pass sourceRevision, so future sourceRevision use must be explicit and tested.
```

This is good for stability, but it is fragile because adding a volatile field to `items`, `evidence`, or `sourceRevision` can turn every harmless board refresh into a new fingerprint and a new possible nudge.

Rules:

- fingerprint includes only actionable work semantics, not timestamps, UI order, unread counters, activity row IDs, or display-only cache revisions;
- `generatedAt`, raw comment text, feed count, message count, work interval duration, and member-card presentation state never enter the fingerprint;
- item ordering remains stable by semantic key, not task array order;
- `blockedByTaskIds`, `blockerTaskIds`, review diagnostics, and history event IDs remain sorted before hashing;
- if `sourceRevision` is introduced later, it must be a semantic revision, not a general team-data or renderer revision;
- subject/displayId changes can be included only if the product wants them to invalidate report tokens and trigger sync;
- tests must explicitly prove no churn on task array reorder and cosmetic/presentation-only changes.

Tests:

- same tasks in different array order produce the same fingerprint;
- `generatedAt` and work-duration/presentation fields do not change fingerprint;
- changing owner/status/dependency/review obligation changes fingerprint;
- changing unrelated task for another member does not change this member fingerprint unless it affects dependency/review/lead clarification;
- future `sourceRevision` use has a dedicated test that documents exactly why it changes the fingerprint.

### 4.55 Member-Work-Sync Reports And Tokens Must Be Fingerprint-Scoped

Current files:

```text
src/features/member-work-sync/core/domain/MemberWorkSyncReportValidator.ts
src/features/member-work-sync/core/application/MemberWorkSyncReporter.ts
src/features/member-work-sync/core/application/MemberWorkSyncPendingReportIntentReplayer.ts
src/features/member-work-sync/main/infrastructure/HmacMemberWorkSyncReportTokenAdapter.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
test/features/member-work-sync/core/MemberWorkSyncReportValidator.test.ts
test/features/member-work-sync/main/HmacMemberWorkSyncReportTokenAdapter.test.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
The HMAC token binds teamName, memberName, agendaFingerprint, and expiresAt.
Reporter re-loads current agenda before accepting a report.
Pending report replay calls the same reporter, so stale intents should be rejected by the same validator.
```

This is the correct shape. The fragile part is replay and offline intents: a stale report must never suppress a newer actionable agenda just because it was stored earlier.

Rules:

- `caught_up` is accepted only when the current server agenda is empty;
- `still_working` and `blocked` are accepted only for the current fingerprint;
- `blocked` requires current board-backed blocker evidence;
- pending report replay must mark stale fingerprint/token intents rejected or superseded, not accepted;
- pending report intent ID may include token/report payload, but acceptance still depends on current agenda validation;
- rejected reports can update diagnostics/status, but cannot extend leases or clear `needs_sync`;
- token secret regeneration invalidates old tokens safely and should be diagnostic-only.

Tests:

- stale fingerprint report is rejected even if taskIds still look plausible;
- expired token report is rejected and does not extend the previous lease;
- pending replay of an old `caught_up` intent after a new task appears remains rejected;
- pending replay after member removal is superseded and does not materialize a nudge;
- `blocked` without current blocked agenda evidence is rejected;
- corrupt/regenerated token secret does not crash the reporter and forces a fresh status read.

### 4.56 Runtime Turn-Settled Spool Must Be Durable, Idempotent, And Targeted

Current files:

```text
src/features/member-work-sync/core/application/RuntimeTurnSettledIngestor.ts
src/features/member-work-sync/main/infrastructure/FileRuntimeTurnSettledEventStore.ts
src/features/member-work-sync/main/infrastructure/RuntimeTurnSettledSpoolInitializer.ts
src/features/member-work-sync/main/adapters/output/TeamRuntimeTurnSettledTargetResolver.ts
test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts
test/features/member-work-sync/main/FileRuntimeTurnSettledEventStore.test.ts
test/features/member-work-sync/main/TeamRuntimeTurnSettledTargetResolver.test.ts
```

Source-audit finding:

```text
FileRuntimeTurnSettledEventStore moves incoming -> processing -> processed/invalid and recovers stale processing files.
RuntimeTurnSettledIngestor ignores non-terminal OpenCode outcomes and resolves provider-owned events through configured active members.
Claude events are resolved by transcript/session lookup.
```

The spool is the bridge between runtime-level "turn settled" and member-work-sync. If it loses events, routes to the wrong member, or retries forever, the app will either miss sync opportunities or spam the wrong agent.

Rules:

- incoming payload write must be atomic or temporary-file based before it becomes claimable;
- processing recovery must be bounded and must not process `.meta.json` files as events;
- provider-owned `codex` and `opencode` events require explicit teamName/memberName and matching configured provider;
- Claude transcript/session lookup must reject provider mismatch, removed member, reserved member, and deleted team;
- non-terminal OpenCode outcomes remain ignored for work-sync, but still leave processed diagnostics;
- malformed/oversized/unsupported-provider payloads are quarantined, not retried forever;
- duplicate sourceId/event files must be idempotent at queue/outbox level, even if the file store sees both;
- draining stays bounded and never blocks app startup on a huge spool.

Tests:

- stale processing file is recovered once and then processed;
- invalid provider and oversized payload go to invalid with reason;
- OpenCode `timeout`/`stream_unavailable` outcomes are ignored and do not enqueue reconcile;
- OpenCode successful terminal event enqueues only the matching active OpenCode member;
- provider mismatch rejects event for the wrong configured provider;
- duplicate runtime sourceId does not produce duplicate user-visible nudges after reconcile/outbox planning.

### 4.57 Task Impact Routing Must Stay Narrow But Safe

Current files:

```text
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTeamChangeRouter.ts
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTaskImpactResolver.ts
test/features/member-work-sync/main/MemberWorkSyncTeamChangeRouter.test.ts
test/features/member-work-sync/main/MemberWorkSyncTaskImpactResolver.test.ts
```

Source-audit finding:

```text
Task/team-change routing uses taskId/detail parsing, then resolves owner, reviewer, lead clarification, broken dependencies, and dependent task owners.
If taskId is missing or resolver says fallbackTeamWide, it enqueues all active members.
```

This keeps most task changes narrow, but fallback behavior is a sharp edge: too narrow misses the agent that should wake; too broad creates unnecessary work-sync scans and possible nudge pressure.

Rules:

- task owner, current reviewer, lead for lead clarification, lead for broken dependencies, and owners of affected dependent tasks are the only normal impacted members;
- unknown task ID can fall back team-wide for status materialization, but dispatch still revalidates foreground/readiness/cooldown before sending a nudge;
- removed/inactive members are filtered before materialization;
- self-review routes to lead, not to the same owner as reviewer;
- task-log-change with a file path detail must only extract safe task JSON names, never arbitrary paths;
- team-wide fallback must be visible in diagnostics so slow/spam cases are explainable;
- resolver errors should fall back to team-wide scan, not drop the change silently.

Tests:

- owner-only task change enqueues only owner;
- review task enqueues current reviewer and not stale reviewers;
- self-review enqueues lead only;
- broken dependency enqueues lead and dependent owners;
- missing/unknown task ID uses team-wide fallback but downstream nudge planning still suppresses unsafe sends;
- removed member is not materialized or queued.

### 4.58 Busy Signal Must Be Advisory And Time-Bounded

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncToolActivityBusySignal.ts
src/features/member-work-sync/main/infrastructure/CompositeMemberWorkSyncBusySignal.ts
test/features/member-work-sync/main/MemberWorkSyncToolActivityBusySignal.test.ts
```

Source-audit finding:

```text
Tool activity busy signal tracks active tool IDs and recent finish grace in memory.
Composite busy signal returns busy on provider errors for 60 seconds.
```

Busy is a useful anti-spam signal, but it must never become a hidden correctness gate. If a finish/reset event is missed, busy can suppress nudges longer than intended unless every path is time-bounded and diagnostic.

Rules:

- busy signal is advisory only and cannot block normal foreground delivery;
- active tool IDs should have a maximum stale lifetime or reset path in addition to finish events;
- recent-finish grace stays short and tested;
- `lead-activity: offline` drops team busy state;
- busy signal errors can delay briefly, but must not suppress nudges indefinitely;
- busy diagnostics include reason and retryAfterIso;
- future persisted busy state must include TTL and team/run/member scope.

Tests:

- finish creates recent busy only until grace expires;
- reset clears one member or whole team;
- offline drops all team activity;
- busy signal error returns a bounded retryAfter and later allows dispatch;
- normal foreground delivery ignores generic busy state.

### 4.59 Nudge Outbox Must Keep Plan-Time And Claim-Time Revalidation Separate

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Source-audit finding:

```text
Planner creates an outbox row only after current status, metrics, activation, and review-pickup capability checks.
Dispatcher re-loads current agenda before delivery and supersedes stale fingerprints.
Dispatcher also re-checks lifecycle, phase2 activation, rate limit, busy signal, and watchdog cooldown.
```

This two-step design is important. Planning an outbox item is not permission to send forever. Dispatch is the safety boundary because the board can change between planning and delivery.

Rules:

- outbox rows are durable intent, not final authorization;
- dispatch must revalidate current agenda fingerprint before writing inbox;
- dispatch must re-check team lifecycle and nudge dispatch readiness;
- dispatch must re-check phase2/targeted recovery activation;
- dispatch must re-check rate limit, busy signal, and watchdog cooldown;
- stale outbox rows are superseded, not delivered;
- retryable failures must get bounded `nextAttemptAt`;
- terminal failures must not be revived unless a new fingerprint or explicitly supported intent key appears;
- review-pickup partial delivery filtering remains request-event based, not broad agenda based.

Tests:

- planned nudge is superseded when agenda becomes empty before dispatch;
- planned nudge is superseded when member reports `still_working` before dispatch;
- planned nudge is retryable when busy/cooldown/rate-limit blocks dispatch;
- planned nudge is terminal on inbox payload conflict;
- delivered review-pickup request is not sent again for the same reviewRequestEventId;
- new reviewRequestEventId after prior delivery creates only the missing event nudge.

### 4.60 Inbox Nudge Sink Must Not Mask Payload Drift

Current files:

```text
src/features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
test/features/member-work-sync/main/TeamInboxMemberWorkSyncNudgeSink.test.ts
```

Source-audit finding:

```text
TeamInboxMemberWorkSyncNudgeSink returns inserted=false when inbox already contains the stable messageId.
It currently does not compare payloadHash itself.
Outbox store checks payloadHash before dispatch, so the sink must stay behind that outbox boundary.
```

The sink is intentionally thin, but that makes the dependency important. If a future caller bypasses outbox and calls the sink directly, same messageId with different text/taskRefs can be treated as success.

Rules:

- only the outbox dispatcher should call the sink in production;
- sink idempotency by messageId is acceptable only after outbox payloadHash validation;
- if the sink becomes public or reused, it must store/compare payloadHash or reject existing-message ambiguity;
- writer result messageId must be used for outbox deliveredMessageId;
- existing messageId with incompatible messageKind/source/taskRefs is a conflict, not a delivered nudge;
- hidden automation filtering must not hide this row from the dispatcher/proof/debug stores.

Tests:

- outbox payload conflict prevents sink call;
- sink existing messageId path is covered only for identical outbox payload;
- existing inbox row with wrong messageKind/source is conflict if sink-level validation is added;
- writer returning a different messageId is either accepted intentionally and recorded, or rejected with a test;
- hidden automation row remains readable by raw inbox diagnostics after insertion.

### 4.61 Targeted Recovery Must Stay Narrow And Provider-Specific

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.ts
src/features/member-work-sync/core/application/MemberWorkSyncTargetedRecoveryPolicy.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
test/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.test.ts
test/features/member-work-sync/core/application/MemberWorkSyncTargetedRecoveryPolicy.test.ts
```

Source-audit finding:

```text
Targeted recovery bypasses full shadow readiness only for OpenCode runtime delivery and lead inbox relay.
Strict review pickup has its own bypass path.
Non-OpenCode secondary providers stay behind phase2 readiness unless the agenda is strict review pickup.
```

This protects the system from enabling broad nudges before shadow metrics are healthy. The risk is accidentally expanding OpenCode-targeted recovery into "all providers can be nudged while collecting".

Rules:

- OpenCode targeted recovery applies only to providerId `opencode`;
- lead targeted recovery applies only to canonical lead-like member names;
- Codex/Anthropic/Gemini secondary members do not use OpenCode targeted recovery;
- strict review pickup is the only cross-provider early-delivery exception;
- ambiguous review pickup evidence does not use the review-pickup bypass;
- targeted recovery still goes through dispatch-time lifecycle, busy, cooldown, rate limit, and inbox write checks.

Tests:

- OpenCode needs_sync can activate during shadow collection;
- Codex/Anthropic/Gemini needs_sync stay inactive during shadow collection unless strict review pickup;
- lead-like member activates through lead targeted recovery;
- non-lead member named like provider does not activate targeted recovery;
- ambiguous review pickup stays out of strict review-pickup path;
- targeted recovery dispatch still respects busy/watchdog/rate limit.

### 4.62 Queue Coalescing Must Preserve Fast Triggers

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts
```

Source-audit finding:

```text
Default trigger timing is fast for turn_settled/tool_finished and moderate for task_changed/inbox_changed.
Passing queueQuietWindowMs currently becomes a broad fallback for every trigger except manual_refresh.
If queueQuietWindowMs is large, it can delay turn_settled/tool_finished far beyond their default 5 seconds.
```

This is the likely class of "logs appeared after 6 minutes" bug: a broad quiet window or coalescing max wait can make a real wakeup wait behind a generic startup/quiet policy.

Rules:

- production should prefer per-trigger `triggerTiming` over broad `queueQuietWindowMs`;
- `turn_settled` and `tool_finished` must keep low runAfter and bounded max wait;
- `manual_refresh` must remain immediate;
- startup/config/member-spawn scans can be slower and readiness-gated;
- coalescing can delay duplicate work, but cannot push fast triggers beyond their documented max;
- running-item follow-up keeps urgent reasons and schedules within 5 seconds as the current code does;
- diagnostics must show firstQueuedAt, runAt, maxRunAt, trigger reasons, and reason counts.

Tests:

- default `turn_settled` and `tool_finished` run after about 5 seconds;
- broad quietWindow override cannot accidentally delay fast triggers if production uses explicit triggerTiming;
- coalesced task_changed plus turn_settled runs at the earlier fast time;
- running reconcile followed by turn_settled schedules a fast follow-up;
- queue diagnostics expose enough timing data to explain a delayed start.

### 4.63 Status Read Staleness Refresh Must Not Become A UI Polling Loop

Current files:

```text
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/features/member-work-sync/core/application/MemberWorkSyncDiagnosticsReader.ts
src/features/member-work-sync/renderer/hooks/useMemberWorkSyncStatus.ts
```

Source-audit finding:

```text
getStatus() reads diagnostics and enqueues manual_refresh when status is stale or an accepted lease expired.
manual_refresh is immediate in the event queue.
```

This helps self-heal stale state, but if renderer polling repeatedly reads the same stale status faster than the queue can reconcile, it can create noisy coalescing and confusing audit logs.

Rules:

- stale-status read can enqueue refresh, but must rely on queue coalescing and not dispatch directly;
- repeated reads for the same team/member should collapse into one queued/running refresh;
- stale refresh cannot bypass lifecycle inactive checks;
- status read must remain side-effect-light: no inbox write, no prompt delivery, no direct nudge dispatch;
- renderer polling intervals should not be used as correctness timing;
- diagnostics should distinguish `status_stale_refresh_enqueued` from actual nudge delivery.

Tests:

- repeated stale `getStatus()` calls coalesce into one manual refresh;
- inactive team stale status does not dispatch a nudge;
- expired accepted lease triggers refresh but not immediate inbox write;
- renderer status hook does not display hidden work-sync rows as normal messages.

### 4.64 Scheduled Dispatcher Is Recovery, Not Fresh Assignment Delivery

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
test/features/member-work-sync/main/MemberWorkSyncNudgeDispatchScheduler.test.ts
```

Source-audit finding:

```text
The event queue dispatches due nudges for the reconciled team immediately after queue reconciliation.
The scheduler runs periodically over lifecycle-active teams and dispatches due outbox rows after restart or missed wakeups.
```

This split is healthy. The scheduler should not become the primary path for fresh task assignment, because its default interval is one minute and can hide actual delivery bugs.

Rules:

- normal task assignment delivery stays in the foreground delivery path;
- work-sync event queue can plan and dispatch after reconcile for the affected team;
- scheduled dispatcher only recovers due outbox rows after restart, missed timer, or transient failure;
- scheduler must list lifecycle-active teams, not all team directories;
- scheduler run is non-overlapping and bounded;
- scheduler failures are warning diagnostics and do not block the app;
- live slow-start diagnostics should say whether the nudge came from queue or scheduler.

Tests:

- fresh task assignment does not wait for scheduler tick when queue path is healthy;
- due outbox row after app restart is dispatched by scheduler;
- scheduler does not overlap runs;
- scheduler skips inactive/no-team cases;
- scheduler failure logs and recovers on next run.

### 4.65 Runtime Turn-Settled Installation Must Match The Provider Emitter

Current files:

```text
src/features/member-work-sync/main/infrastructure/RuntimeTurnSettledSpoolInitializer.ts
src/features/member-work-sync/main/infrastructure/ShellRuntimeTurnSettledHookScriptInstaller.ts
src/features/member-work-sync/main/infrastructure/runtimeTurnSettledHookSettings.ts
src/features/member-work-sync/main/infrastructure/runtimeTurnSettledEnvironment.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/main/services/team/TeamProvisioningService.ts
src/main/index.ts
test/features/member-work-sync/main/RuntimeTurnSettledHookSettings.test.ts
test/main/services/team/TeamProvisioningServicePrepare.test.ts
test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
test/main/services/team/MemberWorkSyncCodex.live.test.ts
test/main/services/team/MemberWorkSyncOpenCode.live.test.ts
```

Source-audit finding:

```text
Claude uses a shell Stop hook settings payload.
Codex receives the spool environment through normal team provisioning.
OpenCode receives the spool environment through the OpenCode bridge process wiring, not through the Claude shell hook installer.
The shell hook script currently validates the provider argument as claude/codex only.
```

This is not one generic "install hook" path. Treating it as generic is a bug risk: a test could prove Claude hooks work while OpenCode never emits, or OpenCode bridge wiring could work while Codex secondary members miss the environment.

Rules:

- Claude Stop hook settings are installed only for Claude provider launches;
- Codex turn-settled uses environment injection from provisioning, not Claude hook settings;
- OpenCode turn-settled uses bridge environment injection from the main runtime bridge and live harness;
- the OpenCode bridge env path must be covered directly, not inferred from shell hook tests;
- if the shell script is ever reused for OpenCode, its provider allowlist must be changed in the same commit and tested;
- missing turn-settled env must degrade to no sync event, not break foreground delivery or launch;
- workspace trust env filtering must preserve the `AGENT_TEAMS_RUNTIME_TURN_SETTLED_` prefix;
- diagnostics should record provider, install mode, and spool root without logging full prompt payloads.

Tests:

- Claude settings include one non-blocking Stop hook command and preserve user settings;
- Codex primary and secondary launches include `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT`;
- OpenCode bridge env includes the same spool root in desktop app and live harness composition;
- OpenCode bridge env missing produces no member-work-sync turn event but does not fail prompt delivery;
- shell hook provider validation rejects unsupported providers and is not used as proof for OpenCode;
- workspace trust preflight preserves the turn-settled spool environment variable.

### 4.66 Runtime Turn-Settled Normalizers Must Stay Provider-Strict

Current files:

```text
src/features/member-work-sync/main/infrastructure/ClaudeStopHookPayloadNormalizer.ts
src/features/member-work-sync/main/infrastructure/CodexNativeTurnSettledPayloadNormalizer.ts
src/features/member-work-sync/main/infrastructure/OpenCodeTurnSettledPayloadNormalizer.ts
src/features/member-work-sync/main/infrastructure/CompositeRuntimeTurnSettledPayloadNormalizer.ts
src/features/member-work-sync/contracts/types.ts
test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts
test/features/member-work-sync/main/CodexNativeTurnSettledPayloadNormalizer.test.ts
test/features/member-work-sync/main/OpenCodeTurnSettledPayloadNormalizer.test.ts
```

Source-audit finding:

```text
Claude payloads are accepted only for provider "claude" and Stop hook data.
Codex payloads require provider "codex" and source "agent-teams-orchestrator-codex-native".
OpenCode payloads require provider "opencode" and source "agent-teams-orchestrator-opencode".
The composite normalizer tries normalizers in order and should not turn a source mismatch into another provider's event.
```

This provider strictness is a safety boundary. It prevents a malformed OpenCode or Codex payload from being routed to the wrong member and creating a false "agent stopped" signal.

Rules:

- provider id and source string are part of the public turn-settled contract;
- malformed payloads are invalid, not best-effort accepted;
- unsupported-provider results may fall through to another normalizer, but provider/source mismatch for a claimed provider must fail closed;
- `sourceId` must be stable for the same logical event and different for different turns;
- `payloadHash` is useful for diagnostics and dedupe, but cannot be the only identity if the payload contains timestamp-like fields;
- OpenCode outcomes that are not terminal enough for work-sync should be ingested as diagnostic or ignored by policy, not treated as caught-up proof;
- old payload shapes must be accepted only when they still carry enough team/member/provider identity.

Tests:

- Codex payload with OpenCode source is rejected, not normalized as Codex;
- OpenCode payload with Codex source is rejected, not normalized as OpenCode;
- valid duplicate payloads produce the same `sourceId`;
- changed session, turn, runtime prompt, or payload hash produces a distinct `sourceId`;
- malformed JSON object is quarantined and never enqueues member reconcile;
- empty or unknown provider payload cannot target `lead` by fallback.

### 4.67 Runtime Turn-Settled Drain Scheduler Must Be Non-Blocking And Observable

Current files:

```text
src/features/member-work-sync/main/infrastructure/RuntimeTurnSettledDrainScheduler.ts
src/features/member-work-sync/main/infrastructure/FileRuntimeTurnSettledEventStore.ts
src/features/member-work-sync/main/RuntimeTurnSettledIngestor.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts
test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
```

Source-audit finding:

```text
The scheduler starts a first drain after a short delay, repeats periodically, skips overlapping runs, logs failures, and continues scheduling.
```

This is the right shape. The fragile part is operational: a failed drain must not silently stop future drains, and a slow drain must not block the Electron app.

Rules:

- first drain should run soon after feature composition so live agents do not wait for a full periodic interval;
- drain runs are non-overlapping;
- drain failure is warning-only and schedules the next attempt;
- drain must have a bounded claim/read batch size;
- stale `processing` spool files are recovered or quarantined deterministically;
- invalid payloads are quarantined with diagnostics and never retried forever;
- drain cannot write inbox nudges directly; it only ingests events and enqueues/reconciles through member-work-sync use cases.

Tests:

- scheduler starts a near-immediate drain and then repeats;
- overlapping run is skipped without dropping the next scheduled run;
- drain exception logs once and next tick still runs;
- stale processing file is recovered and ingested once;
- invalid payload is quarantined and not reprocessed forever;
- manual drain in tests can assert event-to-reconcile without waiting for timers.

### 4.68 Audit Journal Must Stay Diagnostic, Not Canonical State

Current files:

```text
src/features/member-work-sync/main/infrastructure/FileMemberWorkSyncAuditJournal.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
test/features/member-work-sync/main/FileMemberWorkSyncAuditJournal.test.ts
```

Source-audit finding:

```text
The audit journal sanitizes and truncates payloads, rotates files, serializes appends per file, uses file locks, and logs append failures as warnings.
```

That makes it a good debug source and a bad source of truth. Do not base correctness on it.

Rules:

- correctness state lives in member-work-sync store, outbox, inbox, ledger, and runtime event store;
- audit append failure cannot fail delivery, reconcile, report validation, or task write;
- audit rotation/truncation means audit entries cannot be required for exact proof;
- audit rows may be included in artifact packs as explanation only;
- audit payloads must remain sanitized and bounded;
- no full prompt, API key, auth path, or unbounded transcript should be written to audit.

Tests:

- audit append failure logs warning and use case still succeeds;
- rotated audit files still leave current metrics/status intact;
- truncated audit data is never parsed back as canonical proof;
- artifact/debug export can include audit snippets without exposing secrets.

### 4.69 Phase 2 Readiness Metrics Must Be Conservative Under Sparse Or Corrupt Data

Current files:

```text
src/features/member-work-sync/core/domain/MemberWorkSyncPhase2Readiness.ts
src/features/member-work-sync/core/application/MemberWorkSyncMetricsReader.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
test/features/member-work-sync/core/MemberWorkSyncPhase2Readiness.test.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
Phase 2 readiness is derived from recent metric events. Empty data returns an assessment from empty metrics. Store repair/truncation can affect available events.
```

The safe default is conservative. Sparse or repaired data should keep the feature in collecting/shadow mode, not accidentally enable active nudges.

Rules:

- empty metrics must not report active-ready;
- repaired or truncated metrics index must not create a false ready state;
- high would-nudge rate, high fingerprint churn, high report rejection rate, and too few observed members block active readiness;
- readiness rates must be computed from a bounded observation window with safe denominators;
- audit journal rotation must not affect readiness metrics;
- readiness state should explain its blocking reasons in diagnostics.

Tests:

- empty metrics returns collecting/not-ready with explicit reasons;
- one member and too few events cannot become active-ready;
- metrics truncation or corrupt event quarantine keeps readiness conservative;
- high nudge, high churn, or high rejection rates block readiness;
- healthy synthetic shadow data crosses thresholds only after minimum observation duration and event count.

### 4.70 Member Work Sync Paths Must Use Canonical Member Storage

Current files:

```text
src/features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths.ts
src/main/services/team/TeamMemberStoragePaths.ts
test/main/services/team/TeamMemberStoragePaths.test.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
Member-work-sync path construction delegates per-member path safety to TeamMemberStoragePaths and getMemberKey.
```

Keep that boundary. Raw member names are user/team data and should not be manually joined into paths.

Rules:

- never build per-member sync paths by joining raw `memberName`;
- indexes store canonical member keys and display names separately;
- reserved identities such as `user`, `system`, and automation sources must not create teammate store directories;
- removed member storage can be read for diagnostics but cannot be reused for a new active member without canonical identity checks;
- case-only name drift must not split one member into two active sync stores;
- path errors should fail closed and not dispatch nudges.

Tests:

- unsafe member names resolve through `TeamMemberStoragePaths` or are rejected;
- case-only member-name drift reuses canonical key or fails closed consistently;
- reserved identities cannot get member-work-sync report leases;
- removed teammate diagnostics do not dispatch nudges to stale member storage.

### 4.71 Team-Change Routing Must Treat Event Detail As Untrusted

Current files:

```text
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTeamChangeRouter.ts
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTaskImpactResolver.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
test/features/member-work-sync/main/MemberWorkSyncTeamChangeRouter.test.ts
test/features/member-work-sync/main/MemberWorkSyncTaskImpactResolver.test.ts
```

Source-audit finding:

```text
The router parses inbox recipient from detail shaped like inboxes/<member>.json.
It parses tool and member-turn-settled detail as JSON.
It extracts task id from event.taskId or a safe .json detail.
Task resolver failures fall back to team-wide enqueue.
```

This is a fragile input-adapter boundary. `TeamChangeEvent.detail` is transport metadata, not domain truth. Dropping an event because detail had a new shape can recreate delayed or missing sync; broad fallback for every malformed event can create nudge pressure.

Rules:

- malformed JSON detail never throws out of `noteTeamChange`;
- known durable task changes fallback team-wide only when exact impacted members cannot be resolved;
- inbox/lead-message events should support every detail shape emitted by the app, or explicitly log/drop with diagnostics;
- unknown inbox recipient must not create a raw member path;
- task-log-change path parsing only accepts safe task JSON names, not arbitrary paths;
- materializer failure must not prevent queueing other impacted active members;
- team-wide fallback is diagnostic and still goes through queue, readiness, busy, cooldown, and outbox revalidation.

Tests:

- malformed tool/member-turn-settled JSON does not throw and does not enqueue wrong member;
- inbox detail shapes emitted by current writers resolve the intended member;
- unknown inbox detail is either diagnostic fallback or explicit no-op with a test documenting why;
- task detail with absolute path or dotfile does not create a fake task/member;
- materializer failure for one member does not block other impacted members;
- resolver exception falls back team-wide but dispatcher revalidation suppresses unsafe nudges.

### 4.72 Nudge Delivery Wake Is Best-Effort, But Must Not Be Invisible

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/core/application/ports.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Source-audit finding:

```text
Normal nudge dispatch inserts the inbox row, marks outbox delivered, then schedules a short delivery wake.
Wake failure is logged/audited as nudge_wake_failed, but the outbox row is already delivered because the inbox write succeeded.
```

That state model is reasonable: after durable inbox insert, retrying the outbox could duplicate rows. The risk is observability and recovery. If wake fails, the user can see a delayed agent even though the work-sync data layer thinks the nudge was delivered.

Rules:

- inbox insert is the durable delivery boundary for generic work-sync nudges;
- wake failure after insert is not an outbox retry by default, because the row already exists;
- wake failure must be visible in diagnostics, latency timeline, and artifact packs;
- another safe trigger such as inbox refresh, manual refresh, or scheduled dispatcher may re-attempt the wake path, but must not insert a duplicate inbox row;
- OpenCode foreground delivery and review-pickup direct delivery keep their own stricter acceptance semantics;
- `member_work_sync_nudge_existing` wake cannot bypass foreground/busy checks.

Tests:

- wake failure after successful inbox insert records `nudge_wake_failed` and keeps outbox delivered;
- a later wake for the same messageId does not insert another row;
- wake failure appears in diagnostics/latency timeline;
- foreground unread OpenCode delivery still blocks existing-nudge wake;
- review-pickup direct delivery failure does not get mislabeled as generic wake failure.

### 4.73 Pending Report Replay Must Be Bounded And Current-Agenda-Based

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncPendingReportIntentReplayer.ts
src/features/member-work-sync/core/application/MemberWorkSyncReporter.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
Pending replay uses the same reporter and therefore reloads current agenda.
If reporter execution throws, the intent currently stays pending for a future replay.
Validation failures are marked accepted/rejected/superseded through markPendingReportProcessed.
```

Replay is a recovery path for agents that called the report tool while the control API was unavailable. It must not become an infinite startup loop or a way to apply stale leases.

Rules:

- every replay uses current agenda and current token validation;
- accepted/rejected/superseded validation results are marked processed;
- transient execution failures may stay pending, but must have bounded retry diagnostics or an eventual stale cutoff;
- replay cannot accept `caught_up` unless current agenda is empty;
- replay cannot accept `still_working`/`blocked` unless current fingerprint and evidence still match;
- replay should process a bounded number of intents per team per run;
- old pending intents from removed members or inactive teams are superseded, not retried forever.

Tests:

- stale pending `caught_up` after new work appears is rejected and marked processed;
- removed member pending intent is superseded;
- reporter throw leaves pending only for a bounded/transient path and logs diagnostics;
- many pending intents are processed in deterministic order with a limit;
- replay summary distinguishes accepted, rejected, superseded, and unprocessed transient failures.

### 4.74 Review-Pickup Escalation Must Be Idempotent

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/core/application/ports.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
test/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.test.ts
```

Source-audit finding:

```text
Strict review pickup can bypass normal Phase 2 activation.
Planner can escalate when delivery capability is unavailable or already-delivered review request is still stuck.
Dispatcher can also escalate when a claimed review-pickup delivery cannot be delivered.
```

This is intentionally stronger than generic agenda sync, but it creates a duplicate-notification risk if plan-time and dispatch-time failures both notify lead for the same review request.

Rules:

- escalation key should include team, member, reviewRequestEventId set, agendaFingerprint or intent key, and reason class;
- one review request event should not produce repeated lead escalations while the underlying board state is unchanged;
- direct review-pickup delivery remains scoped to current review obligation only;
- generic agenda sync must not use review-pickup bypass rules;
- delivered review-pickup request IDs are durable and checked before planning more direct nudges;
- failed direct delivery should either retry through outbox or escalate, not both for the same attempt.

Tests:

- plan-time capability absence escalates once for the same review request;
- dispatch-time capability absence does not duplicate an existing plan-time escalation for the same key;
- new reviewRequestEventId allows a new escalation;
- generic agenda_sync item cannot use review-pickup bypass;
- already-delivered review pickup that remains stuck escalates once and does not insert another direct nudge.

### 4.75 Feature Composition Must Own Timers, Drains, And Disposal

Current files:

```text
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
src/features/member-work-sync/main/infrastructure/RuntimeTurnSettledDrainScheduler.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler.ts
test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts
```

Source-audit finding:

```text
createMemberWorkSyncFeature starts runtime turn-settled drain scheduler and optional nudge dispatch scheduler immediately.
dispose stops the drain scheduler and awaits queue/nudge scheduler cleanup.
```

This is the main-process composition root. If old timers survive app reload, tests, or feature recreation, they can dispatch stale nudges from an old dependency graph.

Rules:

- all timers created by the feature are owned by the facade returned from composition;
- dispose stops future drains, future scheduled nudge dispatch, and queued/running reconciles from scheduling follow-up work;
- in-flight reconciliation may complete, but must pass lifecycle/revalidation before any inbox write;
- feature recreation must not share old queue state, stale report token cache, or stale busy signal memory;
- dispose must be idempotent;
- live tests should dispose the feature before deleting temp team dirs.

Tests:

- dispose prevents queued item from reconciling later;
- dispose while reconcile is running does not schedule follow-up queue item;
- scheduler timers are cleared and no later dispatchDue call fires;
- creating a second feature instance does not receive events from the disposed instance;
- dispose can be called twice safely.

### 4.76 Agenda Source Member Merge Must Preserve Runtime Identity

Current files:

```text
src/features/member-work-sync/main/adapters/output/TeamTaskAgendaSource.ts
src/features/member-work-sync/core/domain/ActionableWorkAgenda.ts
src/shared/utils/teamProvider.ts
test/features/member-work-sync/main/adapters/output/TeamTaskAgendaSource.test.ts
test/features/member-work-sync/core/ActionableWorkAgenda.test.ts
```

Source-audit finding:

```text
TeamTaskAgendaSource merges config members and members-meta by normalized name.
Provider id comes from member.providerId or model inference.
Removed members are filtered from active member names.
```

Provider id is not part of the agenda fingerprint today, but it controls provider-specific behavior such as OpenCode direct remediation and targeted recovery. A merge bug can make the agenda look correct while dispatch chooses the wrong delivery path.

Rules:

- config/meta merge must prefer removedAt and provider/runtime metadata consistently;
- provider id changes should affect dispatch capability and diagnostics, not churn agenda fingerprint unless actionable work semantics changed;
- unknown provider id fails closed for provider-specific direct delivery;
- removedAt from meta must remove the member from active sync even if config still lists it;
- lead-like detection must not accidentally classify provider name `codex` as a teammate name;
- provider inference from model is compatibility only and should be diagnostic when it affects dispatch.

Tests:

- meta removedAt overrides active config member for sync eligibility;
- providerId from meta/config enables OpenCode targeted recovery only for the matching member;
- unknown provider keeps agenda status readable but blocks provider-specific direct delivery;
- provider/model-only changes do not churn fingerprint unless a product decision says otherwise;
- lead-like and reserved names cannot become secondary member sync targets.

### 4.77 Outbox Claimed Rows Need A Lease Recovery Contract

Current files:

```text
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Source-audit finding:

```text
claimDue() moves pending or failed_retryable rows to claimed and increments attemptGeneration.
markDelivered(), markSuperseded(), and markFailed() only update rows that match the claimed attemptGeneration.
There is no obvious due-path recovery for rows that stay claimed after a process crash or killed dispatcher.
```

This is a classic queue lease problem. `claimed` cannot mean "owned forever". It must be a short lease. Otherwise a crash between claim and mark can permanently hide a valid nudge.

Rules:

- claimed rows need a bounded claim lease such as `claimedAt + claimStaleMs`;
- stale claimed rows are returned to `failed_retryable` or `pending` with a diagnostic, not delivered blindly;
- recovery must preserve `attemptGeneration` monotonicity so late writes from the old dispatcher are ignored;
- terminal rows remain terminal and are never revived by stale-claim recovery;
- recovery runs inside the same team/index lock order as normal claim, so it cannot race with active dispatch;
- tests must prove crash recovery does not create duplicate inbox rows when the old attempt actually delivered just before restart.

Tests:

- stale claimed row becomes claimable again after lease expiry;
- non-stale claimed row is not claimed by a second dispatcher;
- late `markDelivered` from an older attemptGeneration is ignored after recovery;
- stale claimed row with an existing inbox messageId remains idempotent through sink/outbox validation;
- terminal delivered/superseded/failed_terminal rows are not revived.

### 4.78 Runtime Turn-Settled Poison Payloads Need Backoff Or Quarantine

Current files:

```text
src/features/member-work-sync/core/application/RuntimeTurnSettledIngestor.ts
src/features/member-work-sync/main/infrastructure/FileRuntimeTurnSettledEventStore.ts
test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts
test/features/member-work-sync/main/FileRuntimeTurnSettledEventStore.test.ts
```

Source-audit finding:

```text
claimPending() moves incoming files to processing.
Invalid normalizer results are marked invalid.
If the ingestor catches an unexpected exception while processing a claimed payload, it logs and leaves the file in processing.
The file store later recovers stale processing files back to incoming.
```

That is good for transient failure, but dangerous for poison payloads that repeatedly crash target resolution or enqueue. They can create endless drain churn.

Rules:

- unexpected processing failures should keep retry semantics, but with bounded attempts recorded in metadata;
- after a small retry budget, payload moves to invalid with reason `processing_failed_repeatedly`;
- retry count must survive app restart;
- poison payload quarantine must not block later payloads in the same drain batch;
- drain summary should distinguish `failed_transient` from `invalid_quarantined`;
- OpenCode non-terminal outcomes that are intentionally ignored remain processed, not retried.

Tests:

- one transient exception is retried after stale processing recovery;
- repeated exception exceeds budget and quarantines the file;
- poison file does not prevent a later valid file from enqueueing;
- invalid/quarantined metadata includes provider, sourceId if known, and concise reason;
- ignored OpenCode timeout/stream_unavailable does not count as poison.

### 4.79 IPC And HTTP Boundaries Must Validate Member Work Sync Requests

Current files:

```text
src/features/member-work-sync/main/adapters/input/registerMemberWorkSyncIpc.ts
src/features/member-work-sync/preload/index.ts
src/main/http/teams.ts
src/renderer/api/httpClient.ts
test/features/member-work-sync/main/registerMemberWorkSyncIpc.test.ts
test/renderer/api/httpClient.memberWorkSync.test.ts
```

Source-audit finding:

```text
Electron IPC handlers forward typed requests directly to the feature.
HTTP routes validate teamName and some report fields, but browser-mode report currently posts the full request while the HTTP route normalizes source to "mcp".
Renderer/preload code relies on TypeScript shape, not runtime validation.
```

Renderer and HTTP inputs are not domain-trusted. This is a Clean Architecture boundary: adapter validates and normalizes, application use cases receive a safe command.

Rules:

- shared request validators should live at the contract/input-adapter boundary, not inside domain policy;
- IPC and HTTP should normalize teamName/memberName/state/fingerprint/taskIds consistently;
- path-like member names may be valid display names only after canonical member validation, not raw path use;
- report `source` must preserve real provenance: MCP tool report, app UI report, replay, or test;
- browser-mode HTTP route must not label app-originated reports as MCP unless it is actually an MCP tool endpoint;
- invalid IPC/HTTP input returns a structured error and never creates status, pending report, or outbox storage.

Tests:

- IPC rejects missing/blank teamName or memberName before calling the feature;
- HTTP report rejects invalid state, empty fingerprint, non-array taskIds, and oversized note;
- browser-mode report preserves or explicitly maps source provenance in a tested way;
- encoded slash in memberName is treated consistently across HTTP client and route;
- invalid requests do not create `.member-work-sync` files.

### 4.80 Phase 2 Readiness Must Not Be Trained By Manual Status Reads

Current files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncReconciler.ts
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
src/features/member-work-sync/core/domain/MemberWorkSyncPhase2Readiness.ts
src/features/member-work-sync/renderer/hooks/useMemberWorkSyncStatus.ts
test/features/member-work-sync/core/MemberWorkSyncPhase2Readiness.test.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
MemberWorkSyncReconciler writes status for both request and queue contexts.
JsonMemberWorkSyncStore creates status_evaluated metric events using evaluatedAt.
Renderer status panel calls getStatus when opened.
```

If every manual status read trains readiness metrics, a user opening diagnostics repeatedly can move Phase 2 from shadow to active readiness. That is a hidden feedback loop.

Rules:

- metrics that unlock active nudges should be based on queue/runtime/team-change evaluations, not arbitrary UI reads;
- request-based reads may update status for visibility, but should either not count toward readiness or carry a separate metric kind;
- `refreshStatus` from UI must remain diagnostic and never directly dispatch a nudge;
- readiness should expose how many events were automation-derived versus manual/request-derived;
- test clocks should prove evaluatedAt changes alone do not create readiness.

Tests:

- repeated `getStatus`/request reconciles do not satisfy active readiness thresholds by themselves;
- queue reconciles still count toward readiness;
- manual refresh writes status but does not plan outbox;
- mixed manual and queue events report clear readiness diagnostics;
- opening `MemberWorkSyncStatusPanel` cannot turn on generic nudges.

### 4.81 Watchdog Cooldown Fail-Closed Behavior Must Be Bounded And Visible

Current files:

```text
src/features/member-work-sync/main/adapters/output/TeamTaskStallJournalWorkSyncCooldown.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
test/features/member-work-sync/main/TeamTaskStallJournalWorkSyncCooldown.test.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Source-audit finding:

```text
Missing stall journal returns false.
Malformed or unreadable stall journal returns true, suppressing work-sync nudges.
Dispatcher treats watchdog_cooldown_active as retryable.
```

Failing closed is safer than spamming, but an unreadable journal can suppress sync forever if the retry path keeps seeing the same parse failure.

Rules:

- missing journal means no cooldown;
- malformed/unreadable journal can suppress temporarily, but must expose a diagnostic reason;
- repeated unreadable journal should not hide all work-sync forever without artifact visibility;
- retry backoff for `watchdog_cooldown_active` should be bounded and observable;
- watchdog cooldown is task-scoped: unrelated tasks for the same member should not be suppressed if taskIds do not overlap.

Tests:

- ENOENT returns no cooldown;
- malformed JSON returns cooldown with diagnostic/audit reason;
- unrelated task IDs do not trigger cooldown;
- expired alertedAt does not suppress;
- dispatcher retry after cooldown keeps outbox recoverable and does not duplicate nudge.

### 4.82 Main-Process Event Fanout Must Stay Idempotent

Current files:

```text
src/main/index.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts
```

Source-audit finding:

```text
memberWorkSyncFeature.noteTeamChange() is called from file watcher forwarding and from TeamProvisioningService/teamLogSourceTracker emitters.
The event queue coalesces by team/member and trigger reason.
```

Duplicate event delivery is expected in Electron main. The plan must not rely on "exactly once" event fanout.

Rules:

- noteTeamChange is at-least-once, not exactly-once;
- duplicate events must coalesce into one reconcile per team/member window;
- multiple trigger reasons can be preserved for diagnostics without changing agenda fingerprint;
- event fanout must never call dispatcher directly;
- feature disposal must remove or ignore stale fanout safely;
- tests should simulate duplicate file watcher plus service-emitter events for the same task/inbox change.

Tests:

- duplicate inbox event enqueues one member reconcile and preserves trigger reasons;
- duplicate task event does not create duplicate outbox rows;
- event order `task then inbox` and `inbox then task` converges to the same agenda/outbox state;
- post-dispose noteTeamChange is ignored or safe no-op;
- repeated renderer broadcast does not imply repeated work-sync dispatch.

### 4.83 Store Index Repair Must Not Drop Members With Bad Metadata Silently

Current files:

```text
src/features/member-work-sync/main/infrastructure/JsonMemberWorkSyncStore.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncStorePaths.ts
src/main/services/team/TeamMemberStoragePaths.ts
test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts
```

Source-audit finding:

```text
Index repair scans per-member storage by reading members/<key>/member.meta.json.
Malformed member storage dirs are ignored during repair.
```

Ignoring malformed member dirs is safe for path traversal, but it can hide existing outbox/report/status rows if the meta file is corrupt. The repair path must make that degradation visible and avoid destructive cleanup.

Rules:

- malformed member meta during repair is diagnostic, not destructive;
- repair must not delete member feature files just because meta is unreadable;
- indexes can skip unsafe dirs, but artifact/debug output should list skipped member keys;
- legacy store fallback must not create new raw member dirs when meta is corrupt;
- canonical member meta repair belongs to `TeamMemberStoragePaths`/team storage, not member-work-sync domain code.

Tests:

- corrupt member.meta leaves member feature files untouched;
- repair emits audit/log diagnostic for skipped member storage;
- valid member dirs still repair indexes when another dir is malformed;
- legacy fallback does not create unsafe raw member directory;
- metrics/outbox repair remains deterministic with mixed valid and malformed member dirs.

### 4.84 Public Status Surfaces Must Separate Operator Diagnostics From User State

Current files:

```text
src/features/member-work-sync/renderer/adapters/memberWorkSyncStatusViewModel.ts
src/features/member-work-sync/renderer/ui/MemberWorkSyncStatusPanel.tsx
src/renderer/components/team/messages/MessagesPanel.tsx
src/renderer/components/team/activity/ActivityItem.tsx
test/features/member-work-sync/renderer/memberWorkSyncStatusViewModel.test.ts
test/renderer/components/team/messages/MessagesPanel.test.tsx
```

Source-audit finding:

```text
MemberWorkSyncStatusPanel can expose detailed status.
MessagesPanel hides work-sync nudges from normal Messages.
ActivityItem still has automation/work-sync rows for audit/activity views.
```

This split is correct. The risk is product semantics drift: a user-facing "Needs sync" badge can look like a broken agent, while a hidden automation row can look like missing history.

Rules:

- normal Messages feed hides `member_work_sync_nudge` and task-stall automation by default;
- activity/debug views may show automation, but with clear control-plane copy;
- member card/status surfaces should explain "work agenda sync" without implying user message failure;
- status badge must not be used as a delivery proof source;
- diagnostics panels can show fingerprint/token/outbox state, but not full prompts or secrets;
- screenshots and tests should cover both normal-user and diagnostics modes.

Tests:

- normal Messages excludes work-sync nudges;
- Activity/audit view can show work-sync rows with automation labeling;
- status view model maps inactive/unknown/needs_sync without scary false-error copy;
- hidden automation row still appears in diagnostics/raw inbox;
- status panel never triggers dispatch by rendering.

---

## 5. What Not To Do

Do not solve this by changing `workIntervals`.

Bad variant:

```text
start workIntervals only after task_start/tool activity
```

Score:

`🎯 5   🛡️ 4   🧠 6`, roughly `250-550 LOC`, high regression risk.

Why not:

- breaks existing task status duration semantics;
- creates provider-specific timing gaps;
- makes old tasks inconsistent;
- weakens change scoping based on persisted intervals;
- does not fix OpenCode delivery delay or missing task logs.

Do not ping agents just because UI shows an old `workInterval`.

Bad variant:

```text
if task has been in progress for N minutes, send another message immediately
```

Score:

`🎯 4   🛡️ 4   🧠 3`, roughly `100-250 LOC`, spam risk.

Why not:

- duplicates watchdog;
- interrupts active work;
- can create loops when delivery is already in flight;
- confuses foreground unread assignment handling.

Do not make task logs depend on broad member-level transcript fallback without session bounds.

Bad variant:

```text
if task stream is empty, include recent member OpenCode logs
```

Score:

`🎯 6   🛡️ 5   🧠 3`, roughly `80-180 LOC`, attribution risk.

Why not:

- can pull another task's work into the selected task;
- gets worse when a member has multiple recreated sessions;
- hides the real missing session lookup problem.

Do not fix the Changes panel by treating every OpenCode `write`/`edit` row as an authoritative diff.

Bad variant:

```text
Task Log Stream write/edit tool row -> synthetic file change summary
```

Score:

`🎯 5   🛡️ 4   🧠 4`, roughly `120-260 LOC`, audit risk.

Why not:

- tool input can be truncated, malformed, failed, or retried;
- a successful tool row is not the same as persisted file diff;
- duplicates and partial writes can create false review data;
- existing `ChangeExtractorService` and task-change ledger are the correct authority for file changes.

Do not add accept-fast transport knobs into `payloadHash` accidentally.

Bad variant:

```text
payloadHash = stableHash(full OpenCodeSendMessageCommandBody)
```

after adding:

```text
settlementMode
observationTimeoutMs
runtimePromptMessageId
debug flags
```

Score:

`🎯 6   🛡️ 4   🧠 3`, roughly `20-80 LOC`, idempotency regression risk.

Why not:

- commandStatus can report payload mismatch for the same logical delivery;
- existing ledger record can become failed_terminal due metadata-only differences;
- retries can create a new logical attempt instead of recovering the accepted one.

---

## 6. Recommended Phases

### Phase 0 - Baseline, Diagnostics, And Guardrails

Score:

`🎯 10   🛡️ 10   🧠 3`, roughly `120-220 LOC`.

Goal:

Make the current behavior measurable before behavior changes.

#### Phase 0.1 Confirm Existing Invariants

Add or update tests that lock the `workIntervals` meaning:

- task created as `in_progress` opens a work interval at `createdAt`;
- `task_start` on an already `in_progress` task does not rewrite the first interval;
- `updateStatus(in_progress)` from non-progress opens a new interval;
- leaving `in_progress` closes the active interval;
- `workIntervals` do not depend on provider.

Candidate tests:

- `test/main/services/team/TeamTaskWriter.test.ts`
- `test/main/services/team/TeamTaskActivityIntervalService.test.ts`
- `test/shared/utils/taskWorkDuration.test.ts`

Acceptance:

```text
workIntervals remain a board/status-time contract
```

#### Phase 0.2 Add Timing Breadcrumbs For OpenCode Delivery

Add machine-readable diagnostics where they are missing, not user-visible noise.

Useful timestamps:

- `delivery_attempt_started_at`
- `session_record_loaded_at`
- `stale_session_detected_at`
- `session_recreate_started_at`
- `session_recreate_finished_at`
- `mcp_ready_check_started_at`
- `mcp_ready_check_finished_at`
- `prompt_async_started_at`
- `prompt_async_accepted_at`
- `turn_settled_wait_started_at`
- `turn_settled_wait_finished_at`
- `post_prompt_reconcile_started_at`
- `post_prompt_reconcile_finished_at`
- `command_outcome_written_at`

Store them as structured diagnostics in existing ledgers/outcomes, not as long human strings.

Important:

- do not put API keys or prompt bodies in diagnostics;
- do not add noisy UI messages;
- do not block delivery on diagnostics write failure.

Candidate files:

- `src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts`
- `src/main/services/team/opencode/bridge/OpenCodeReadinessBridge.ts`
- `src/main/services/team/TeamProvisioningService.ts`
- `agent_teams_orchestrator/src/services/opencode/OpenCodeBridgeCommandHandler.ts`
- `agent_teams_orchestrator/src/services/opencode/OpenCodeCommandOutcomeStore.ts`

Add diagnostics as structured codes where possible. Avoid only-human prose because later phases need to classify:

```text
opencode_send_session_recreated_after_stale_record
opencode_send_session_recreated_after_mcp_failure
opencode_send_mcp_reattached
opencode_send_prompt_endpoint_accepted
opencode_send_turn_observation_timeout
opencode_send_reconcile_after_accept_failed
```

#### Phase 0.3 Debugging Script Or Runbook Snippet

Extend `docs/team-management/member-work-sync-debugging.md` with a short "OpenCode delayed start" section:

```bash
jq '.[] | select(.memberName=="jack")' \
  ~/.claude/teams/<team>/.opencode-runtime/lanes/*/opencode-prompt-delivery-ledger.json
```

Include where to check:

- delivery ledger;
- member-work-sync journal;
- launch state;
- OpenCode lane registry;
- task history timestamps;
- runtime turn-settled spool.

Acceptance:

An engineer can prove whether delay came from:

- no prompt acceptance;
- stale session repair;
- MCP repair;
- provider slow response;
- task log lookup gap;
- actual model idle/stall.

---

### Phase 1 - UI Semantics Without Data Model Change

Score:

`🎯 10   🛡️ 9   🧠 2`, roughly `40-120 LOC`.

Goal:

Stop implying that `workIntervals` equals active model execution.

#### Phase 1.1 Rename The Visible Label

Change user-facing copy:

```text
Work time
```

to one of:

```text
In progress time
```

or:

```text
Time in progress
```

Recommended:

```text
In progress time
```

Why:

- short;
- accurate;
- provider-neutral;
- does not promise active runtime execution.

Candidate file:

- `src/renderer/components/team/dialogs/TaskDetailDialog.tsx`

Known existing test:

- `test/renderer/components/team/dialogs/TaskDetailDialog.test.tsx`

Update test assertion from:

```text
Work time 5m 00s
```

to:

```text
In progress time 5m 00s
```

#### Phase 1.2 Optional Tooltip

If the component already has a tooltip pattern nearby, add:

```text
Time since this task entered In Progress. It can include delivery, waiting, and review coordination time.
```

Do not add a new tooltip framework or large UI component just for this.

#### Phase 1.3 Do Not Rename Storage Fields

Do not rename:

- `workIntervals`;
- `taskWorkDuration`;
- ledger fields using `workIntervals`;
- change scoping reasons.

Storage and code can keep the historical name. The user-facing label is the mismatch.

Acceptance:

- no migration;
- no task JSON rewrite;
- tests pass;
- UI no longer claims "active work".

---

### Phase 2 - Session-Evidence Based OpenCode Task Logs

Score:

`🎯 9   🛡️ 8   🧠 6`, roughly `450-750 LOC` across both repos.

Goal:

Task Log Stream should find OpenCode logs from the actual session that handled the task/delivery, especially after session recreate.

Current likely gap:

```text
OpenCodeTaskLogStreamSource
-> runtimeBridge.getOpenCodeTranscript({ teamId, memberName, laneId? })
-> current lane/session transcript only
```

But delivery ledger can show:

```text
runtimeSessionId: "ses_..."
```

which may not be the current lane registry session after recreate.

#### Phase 2.1 Add Session-ID Transcript Lookup In Orchestrator

Extend runtime transcript CLI to support explicit OpenCode session lookup.

Candidate file:

- `agent_teams_orchestrator/src/cli/handlers/runtime.ts`

Current behavior found:

```text
runtime transcript is implemented for OpenCode
but explicit --session is not accepted
```

Add parameters:

```text
--session-id <sessionId>
--team-id <teamId>
--member <memberName>
--lane <laneId>
--limit <number>
```

Rules:

- `--session-id` must be OpenCode session ID format, for example starts with `ses_`;
- if `--session-id` is present, it takes precedence over lane/current lookup;
- still require team/member context when available for diagnostics and redaction;
- do not allow arbitrary file paths from CLI input;
- do not bypass existing auth/profile boundaries.

Example command:

```bash
agent_teams_orchestrator runtime transcript \
  --provider opencode \
  --team-id comet-hub \
  --member jack \
  --session-id ses_1ddc19603ffe71Lo7UYO5AhHMr \
  --limit 300
```

Expected output shape should remain compatible with existing `getOpenCodeTranscript()`:

```ts
interface OpenCodeTranscriptResult {
  sessionId?: string;
  logProjection?: {
    messages: OpenCodeRuntimeTranscriptLogMessage[];
  };
  diagnostics?: string[];
}
```

Do not create a new renderer-facing schema in this phase.

#### Phase 2.1.1 Do Not Guess Unknown Historical Sessions

Exact `--session-id` support should be conservative:

```text
find stored session record where:
  record.teamId === teamId
  record.memberName === memberName
  record.opencodeSessionId === sessionId
  optional laneId matches when provided
```

If not found:

```json
{
  "diagnostics": ["opencode_transcript_session_not_found"]
}
```

Do not recursively search all OpenCode storage for an arbitrary `ses_*` in this phase.

Reason:

- exact session lookup is a correctness fix, not a forensic scanner;
- broad scans can be slow and can cross team/member boundaries;
- Phase 2 should stay low-risk and bounded.

#### Phase 2.2 Extend Bridge Port In `claude_team`

Candidate file:

- `src/main/services/runtime/ClaudeMultimodelBridgeService.ts`

Extend:

```ts
getOpenCodeTranscript(binaryPath, {
  teamId,
  memberName,
  laneId,
  sessionId,
  limit,
  timeoutMs,
})
```

Rules:

- append `--session-id` only when provided;
- keep old lane/member behavior unchanged;
- tests must verify CLI args for both lane and session lookup;
- do not force every caller to pass session ID.

Tests:

- `test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts`

Important bridge details:

- keep output temp-dir cleanup in `finally`;
- keep `--projection-only` default for task logs;
- do not increase default transcript timeout globally;
- if `sessionId` and `laneId` are both present, pass both so orchestrator can validate.
- if the orchestrator returns a transcript whose `sessionId` does not equal the requested `sessionId`, treat it as a transcript miss and keep fallback behavior;
- for exact-session lookup, validate `transcript.sessionId`, `transcript.logProjection.sessionId`, and every projected message `sessionId` when present;
- if session IDs disagree, reject that exact candidate with a developer diagnostic instead of mixing messages;
- keep parity between both transcript surfaces if both remain supported:
  - CLI `runtime transcript`;
  - bridge command `opencode.getRuntimeTranscript`.

#### Phase 2.3 Use Delivery Ledger Session Evidence In Task Logs

Candidate file:

- `src/main/services/team/taskLogs/stream/OpenCodeTaskLogStreamSource.ts`

Candidate evidence sources:

- task `sourceMessageId`;
- OpenCode prompt delivery ledger records;
- runtime turn-settled records if they contain `runtimeSessionId`;
- task activity records with OpenCode attribution;
- current lane fallback.

Lookup order after source audit:

```text
1. Attribution records with sessionId, fetched by exact sessionId.
2. Delivery ledger records whose taskRefs/sourceMessageId match this task, fetched by exact runtimeSessionId.
3. Runtime-turn-settled events for same team/member/session/time window, if already indexed.
4. Current lane/member transcript with existing marker/time-window logic.
```

Important:

- session lookup should be bounded, for example max 2-3 session IDs per task load;
- exact session lookups should use bounded concurrency `2`, not unlimited `Promise.all`;
- do not scan every historical OpenCode session;
- dedupe transcripts by `sessionId`;
- dedupe projected messages by stable source ID;
- sort by timestamp after merge;
- preserve task marker window logic.
- include session evidence in the task-log cache key;
- exact session candidates must be fetched before comparing `transcript.sessionId` to an attribution record;
- if exact session fetch fails, record a miss reason and continue to the next candidate.
- message dedupe must include session identity, for example `sessionId + uuid`;
- when `uuid` is absent or not stable, prefer `sessionId + sourceToolUseID/sourceToolAssistantUUID + timestamp` over tool-name-only signatures;
- never use native tool name/input alone to dedupe OpenCode rows across different sessions.

#### Phase 2.3.1 Fix The Existing Attribution Path First

Before adding delivery-ledger evidence, fix the current attribution loop because it already has a same-member/multiple-session bug.

Source-audit confirmation:

```text
current transcriptCache key = normalized member name only
current fetch = getOpenCodeTranscript({ teamId, memberName, limit })
current session filter = compare record.sessionId after fetching current transcript
current segment id = opencode-attributed:<team>:<task>:<member>
```

That means a recreated old session can be skipped before exact lookup is attempted, and two sessions for the same member can collapse into one segment.

Required changes:

```text
transcript cache key: memberName -> memberName + laneId + sessionId/current
projection group key: participantKey -> participantKey + sessionId/current
segment id: include sessionId when known
actor.sessionId: exact transcript/session evidence, not first arbitrary message
message identity key: include sessionId before uuid/sourceToolUseID/sourceToolAssistantUUID
```

Pseudo-code:

```ts
const transcriptKey = buildTranscriptCacheKey({
  memberName,
  laneId: record.laneId,
  sessionId: record.sessionId,
});

const transcript = await getOrFetchTranscript(transcriptKey, () =>
  runtimeBridge.getOpenCodeTranscript(binaryPath, {
    teamId: teamName,
    memberName,
    laneId: record.laneId,
    sessionId: record.sessionId,
    limit: ATTRIBUTED_TRANSCRIPT_LIMIT,
  })
);

if (record.sessionId && transcript?.sessionId !== record.sessionId) {
  recordMiss("exact_session_mismatch");
  continue;
}

const projectionKey = buildProjectionGroupKey({
  memberName,
  sessionId: transcript.sessionId ?? record.sessionId,
});
```

Projection merge rule:

```ts
function buildOpenCodeProjectedMessageKey(message: ParsedMessage): string {
  const session = message.sessionId?.trim() || "unknown-session";
  const id =
    message.uuid?.trim() ||
    message.sourceToolUseID?.trim() ||
    message.sourceToolAssistantUUID?.trim() ||
    `${message.timestamp.toISOString()}:${message.type}`;

  return `${session}:${id}`;
}
```

This is intentionally stricter than generic transcript merge. The same member can have several live or recently recreated OpenCode sessions, and a tool name/input signature is not enough provenance.

User-facing participant filters can still show a single `bob`. Internal segments should remain session-specific:

```text
opencode-attributed:<team>:<task>:bob:<sessionId>
```

Acceptance:

- two attribution records for the same member but different sessions produce separate safe segments unless message IDs overlap;
- a current-lane transcript cannot silently hide an exact historical attribution record;
- renderer still shows simple member filters.

Pseudo-code:

```ts
const attributionRecords = await attributionStore.readTaskRecords(teamName, task.id);
const sessionEvidence = await sessionEvidenceSource.findOpenCodeTaskTranscriptCandidates({
  teamName,
  taskId: task.id,
  owner: task.owner,
  sourceMessageId: task.sourceMessageId,
  workIntervals: task.workIntervals,
  attributionRecords,
});

const cacheKey = buildCacheKey(task, attributionRecords, sessionEvidence);

for (const candidate of sessionEvidence.slice(0, 3)) {
  const transcript = await runtimeBridge.getOpenCodeTranscript(binaryPath, {
    teamId,
    memberName: candidate.memberName,
    sessionId: candidate.sessionId,
    laneId: candidate.laneId,
    limit,
    timeoutMs,
  });
  mergeIfTaskScoped(transcript, candidate);
}
```

Better architecture:

Create a narrow adapter/source instead of embedding all ledger parsing in `OpenCodeTaskLogStreamSource`:

```text
TaskLogOpenCodeSessionEvidenceSource
```

Responsibilities:

- read OpenCode delivery ledger;
- return small candidate list;
- no transcript parsing;
- no renderer DTOs;
- no task log rendering decisions.

Suggested candidate type:

```ts
interface OpenCodeTaskTranscriptCandidate {
  sessionId: string;
  memberName: string;
  laneId?: string;
  source: "attribution" | "delivery_ledger" | "turn_settled";
  taskId: string;
  since?: string;
  until?: string;
  startMessageUuid?: string;
  endMessageUuid?: string;
  confidence: "exact" | "bounded_window";
}
```

Candidate source rules:

- exact candidates sort before bounded window candidates;
- latest accepted delivery for the task sorts before older retry attempts;
- records with `failed_terminal` and no `acceptedAt` are ignored;
- records with `runtimeSessionId` but no task correlation are ignored;
- maximum candidate count defaults to `3`;
- every miss reason is diagnostic-only.

This keeps SRP:

- evidence source finds session candidates;
- runtime bridge fetches transcript;
- task log stream source projects and filters messages.

#### Phase 2.4 Diagnostics

Add developer diagnostics to stream metadata/logs:

```ts
{
  opencodeSessionEvidenceCount: 2,
  opencodeSessionTranscriptHits: 1,
  opencodeCurrentLaneFallbackUsed: true,
  opencodeTranscriptMissReasons: [
    "session_transcript_empty",
    "no_runtime_session_id_for_task"
  ]
}
```

Do not show these as regular user-visible task log rows.

#### Phase 2.4.1 Merge And Cache Safety In `BoardTaskLogStreamService`

Before relying on exact OpenCode session fallback, verify the higher-level stream service does not erase it.

Required checks:

```text
OpenCode fallback segment id includes session identity
BoardTaskLogStreamService merge keeps distinct session segments
source-level OpenCode cache invalidates when evidence candidate identity changes
layout cache does not hide newly available fallback evidence
```

Suggested helper:

```ts
function buildOpenCodeTaskLogSegmentId(input: {
  teamName: string;
  taskId: string;
  memberName: string;
  sessionId?: string | null;
  source: "attributed" | "delivery_ledger" | "heuristic";
}): string {
  const sessionPart = input.sessionId?.trim() || "current";
  return [
    "opencode",
    input.source,
    input.teamName,
    input.taskId,
    input.memberName,
    sessionPart,
  ].join(":");
}
```

Do not use participant name alone as the segment identity.

Cache rules:

- source cache key includes attribution key plus session evidence key;
- session evidence key is stable and compact, for example sorted `source/member/sessionId/laneId`;
- if exact evidence is absent, current fallback cache behavior remains;
- cache TTL stays short and does not become a correctness dependency;
- cache miss diagnostics stay developer-only.
- `shouldMergeRuntimeFallback()` must consider whether existing execution records cover the same OpenCode owner/session before suppressing fallback.

#### Phase 2.5 Tests

Unit:

- ledger evidence returns runtimeSessionId matching task/message/member;
- session candidates are deduped and bounded;
- foreign member/task evidence ignored;
- missing ledger falls back cleanly;
- `getOpenCodeTranscript()` passes `--session-id`.
- cache key changes when session evidence appears;
- exact attribution session is fetched even if current member transcript has a different session;
- two exact sessions for one member do not share a transcript cache entry;
- two exact sessions for one member do not collapse into one segment with the wrong actor session;
- session not found returns null/fallback without throwing user-visible errors.
- exact transcript with mismatched top-level/projection/message session IDs is rejected as a candidate.
- BoardTaskLogStreamService merge does not drop two OpenCode fallback segments for the same participant with different session IDs;
- BoardTaskLogStreamService does not suppress OpenCode fallback because of unrelated execution records;
- OpenCode fallback cache invalidates when session evidence changes from empty/current to exact session.

Integration:

- OpenCode task stream uses session transcript first when current lane transcript is empty;
- native tools from session transcript render correctly;
- wrong session transcript does not leak into task;
- duplicate retry markers do not duplicate native rows.

Suggested commands:

```bash
pnpm vitest run \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/main/services/team/OpenCodeTaskLogStreamSource.test.ts \
  test/main/services/team/OpenCodeTaskLogStreamSource.fixture-e2e.test.ts \
  test/main/services/team/BoardTaskLogStreamIntegration.test.ts \
  test/renderer/components/team/taskLogs/TaskLogStreamSection.opencode-fixture-e2e.test.tsx
```

In orchestrator:

```bash
bun test src/cli/handlers/runtime.test.ts src/services/opencode/OpenCodeSessionBridge.test.ts
bun run build
```

Acceptance:

- a recreated OpenCode session can still supply task logs;
- task logs appear from the actual prompt/session evidence, not only the current lane;
- no unrelated member logs are pulled in.

---

### Phase 3 - Accept-Fast OpenCode Delivery With Async Durable Observation

Score:

`🎯 8   🛡️ 7   🧠 8`, roughly `550-950 LOC` across both repos.

Goal:

Do not make the app wait for a full OpenCode turn/reconcile inside the user-facing send command before treating prompt delivery as accepted.

Current high-level flow:

```text
claude_team sendOpenCodeTeamMessage timeout ~45s
-> orchestrator opencode.sendMessage
-> ensure MCP/session
-> promptAsyncWithTurnSettled
-> wait for SSE settle
-> reconcile
-> write outcome
-> return
```

This is robust for evidence, but too slow for delivery acceptance when OpenCode is repairing state or model response takes longer.

Recommended flow:

```text
ensure session/MCP before prompt
-> prompt_async accepted
-> return accepted quickly with runtimePromptMessageId/sessionId
-> durable observer/outcome continues in orchestrator-owned bounded background or follow-up command
-> claude_team ledger observes outcome/status later
-> member-work-sync reconcile wakes from turn-settled event when available
```

Important:

This phase must not lose the safety work already done in OpenCode turn-settled.

#### Phase 3.1 Split Acceptance From Observation

Define two separate concepts:

```ts
type OpenCodePromptAcceptance = {
  accepted: true;
  runtimeSessionId: string;
  runtimePromptMessageId: string;
  deliveryAttemptId: string;
  acceptedAt: string;
};

type OpenCodeTurnObservation = {
  outcome: "success" | "error" | "timeout" | "stream_unavailable";
  observedAt: string;
  diagnostics: string[];
};
```

Acceptance means:

```text
OpenCode endpoint accepted prompt_async for the intended session.
```

It does not mean:

```text
agent replied visibly
agent used tools
task started
message_send succeeded
```

Those remain ledger/watchdog/member-work-sync concerns.

#### Phase 3.1.1 Add Status Vocabulary Without Lying

Current orchestrator outcome statuses include:

```text
received
preconditions_checked
session_resolved
mcp_ready
prompt_submitting
prompt_accepted
turn_observed
reconciled
failed_before_accept
failed_after_accept
```

Do not use `reconciled` for accept-fast return.

Recommended addition:

```ts
type OpenCodeCommandOutcomeStatus =
  | ExistingStatus
  | "acceptance_returned"
  | "observation_pending"
  | "observation_completed";
```

Minimum acceptable alternative:

```text
keep status = prompt_accepted, set completedAt, and add explicit acceptedButObservationPending flag
```

The first option is cleaner:

`🎯 8   🛡️ 8   🧠 5`, roughly `80-160 LOC`.

Required status rules:

- `prompt_accepted`, `acceptance_returned`, `observation_pending` all imply `accepted=true`;
- `safeToRetry=false`;
- `completedAt` can be set when the command returned to the app, but observation status remains pending;
- prune must eventually remove old accepted/pending outcomes after a safe retention period;
- `commandStatus` must expose accepted runtime prompt identity.

#### Phase 3.2 Keep Pre-Prompt Repair Synchronous

Before returning accepted, still do synchronous repair:

- load session record;
- if stale, recreate once;
- ensure Agent Teams MCP ready;
- if MCP unavailable, recreate once;
- if still unavailable, reject before prompt.

Reason:

Returning accepted when MCP is definitely broken recreates known `Not connected` failures.

Do not make pre-prompt repair asynchronous.

Also preserve these current gates from `TeamProvisioningService.deliverOpenCodeMemberMessage()`:

- runtime lane must be active or recoverable;
- lane must have runtime evidence on disk;
- bootstrap must be confirmed for secondary OpenCode lanes;
- stopped teams must stop/cleanup lanes rather than deliver;
- active delivery for the same member/lane blocks a new prompt until proof or terminal state.

#### Phase 3.2.1 Preserve Message Proof Context

Accept-fast is not a proof shortcut. The app still needs to know what kind of response would satisfy the original delivery.

When writing acceptance and observation records, preserve:

```text
messageKind
source
actionMode
taskRefs
replyRecipient
relayOfMessageId
workSyncIntent when applicable
```

This is necessary because proof requirements differ:

```text
normal direct message -> visible message_send or strict plain-text materialization proof
task-linked runtime delivery -> visible/tool proof with correct taskRefs/actionMode
peer relay -> relayOfMessageId and recipient correctness
work-sync nudge -> member_work_sync_report or concrete board progress can be enough
task-stall remediation -> progress/blocker/comment proof, not generic ack
```

Do not let `runtimePromptMessageId` become the only correlation key. It identifies the OpenCode prompt, but it does not encode delivery semantics.

Implementation guidance:

```ts
type RuntimeDeliveryObservationContext = {
  appMessageId: string;
  relayOfMessageId?: string;
  messageKind?: string;
  source?: string;
  actionMode?: "ask" | "do" | "delegate";
  taskRefs: string[];
  replyRecipient?: string;
  runtimeSessionId?: string;
  runtimePromptMessageId?: string;
  workSyncIntent?: string;
};
```

Rules:

- store this context on the ledger when the prompt is accepted;
- pass this context into observe/proof helpers;
- do not re-derive taskRefs from assistant output when the original input already had exact refs;
- do not mark a record read/responded from a proof valid only for a different message kind.

#### Phase 3.3 Return Immediately After `prompt_async` Acceptance

Add an opt-in command mode rather than mutating every OpenCode prompt caller.

Candidate API:

```ts
opencode.sendMessageV2
```

or existing:

```ts
opencode.sendMessage
```

with field:

```ts
settlementMode: "acceptance" | "observed"
```

Recommended:

Use an explicit field on existing command to minimize new CLI surface:

```ts
settlementMode?: "observed" | "acceptance"
```

Default:

```text
observed
```

until all current callers are audited.

For `claude_team` OpenCode teammate delivery, pass:

```text
acceptance
```

Do not switch launch/bootstrap prompts to acceptance mode in the same cut. They have different readiness semantics and should stay on existing observed behavior unless separately audited.

#### Phase 3.3.1 Rollout Matrix For `settlementMode`

Keep the rollout explicit. Do not change all OpenCode prompt calls at once.

| Call site | Initial mode | Why |
| --- | --- | --- |
| Secondary teammate normal delivery from `TeamProvisioningService.deliverOpenCodeMemberMessage()` | `acceptance` after Cut 3 tests | This is the user-facing path suffering from long send latency. |
| Observe/retry commands | not applicable | They should inspect existing runtime prompt identity, not create new prompts. |
| Launch/bootstrap prompts | `observed` | Bootstrap readiness depends on actual tool/checkin proof. |
| `noReply` context injection | existing no-observe path | It must not attach turn-settled observer. |
| Manual maintenance/context prompts | `observed` unless audited | Safety over latency. |
| Live smoke/model matrix prompts | explicit per test | Avoid masking provider/model behavior differences. |

Rules:

- default contract remains `observed` until all non-delivery call sites are audited;
- `claude_team` may pass `acceptance` only for normal OpenCode teammate delivery after pre-prompt MCP/session repair;
- renderer cannot choose settlement mode;
- settlement mode is transport behavior, not delivery proof policy;
- settlement mode should be excluded from logical payload hash unless explicitly proven otherwise.

#### Phase 3.4 Durable Observer Continuation

The hardest part:

The orchestrator command process is short-lived. A simple in-memory `setTimeout` or background Promise can die when the process exits.

Acceptable designs:

##### Option A - Command Outcome Poller In `claude_team`

`🎯 8   🛡️ 8   🧠 6`, roughly `350-650 LOC`.

After prompt acceptance, `claude_team` schedules a follow-up `opencode.commandStatus` or `opencode.observeDelivery` command.

Pros:

- no daemon requirement;
- works with current short-lived CLI model;
- app owns retries and timeouts;
- easy to test by fake bridge command responses.

Cons:

- extra command call;
- slightly more app-side orchestration.

##### Option B - Orchestrator Writes Pending Outcome And Same Command Polls With Small Budget

`🎯 7   🛡️ 7   🧠 5`, roughly `250-500 LOC`.

The command returns accepted but also stores a pending outcome that can later be recovered by `commandStatus`.

Pros:

- reuses existing outcome store;
- smaller diff.

Cons:

- if the command exits before observation, no one observes unless a later status command triggers it;
- can become lazy observation rather than active observation.

##### Option C - Long-Lived Orchestrator Sidecar Observer

`🎯 6   🛡️ 8   🧠 8`, roughly `700-1200 LOC`.

Run a persistent observer service for OpenCode sessions.

Pros:

- cleanest runtime telemetry long term;
- fewer repeated CLI invocations.

Cons:

- larger operational surface;
- process lifecycle risks;
- likely too much for this hardening pass.

Recommended for this phase:

```text
Option A - app-owned follow-up observer command
```

It fits the existing `OpenCodeReadinessBridge` and avoids daemon lifecycle risk.

#### Phase 3.4.1 Follow-Up Observer Must Reuse Existing Observe Path First

Current orchestrator already has:

```text
opencode.observeMessageDelivery
```

and `TeamProvisioningService` already calls `adapter.observeMessageDelivery()` for non-pending records.

Phase 3 should prefer extending this path before creating a brand-new observer command.

Required extensions:

- accept `runtimePromptMessageId` when available;
- accept `runtimeSessionId` when available;
- accept `deliveryAttemptId` and `payloadHash` when available, for command/outcome matching only;
- accept `prePromptCursor`;
- return structured observation reason;
- preserve existing responseObservation shape.

Do not create parallel observation logic that ignores `observeOpenCodeDeliveryResponse()`.

Recommended contract change:

```ts
interface OpenCodeObserveMessageDeliveryCommandBody {
  runId?: string;
  laneId: string;
  teamId: string;
  teamName: string;
  projectPath: string;
  memberName: string;
  messageId: string;
  runtimeSessionId?: string;
  runtimePromptMessageId?: string;
  deliveryAttemptId?: string;
  payloadHash?: string;
  prePromptCursor?: string | null;
}
```

Orchestrator validation rules:

```text
if runtimeSessionId provided:
  resolve stored session by exact opencodeSessionId
  require same team/member/lane when lane is known
  if not found -> session_stale / exact_session_not_found

if runtimePromptMessageId provided:
  observe around that exact prompt id first
  verify it is a user message in the same session
  do not fall back to another prompt id silently

if no runtimePromptMessageId:
  use current prePromptCursor behavior for old ledger compatibility
```

App-side adapter changes:

- extend `OpenCodeTeamRuntimeMessageInput` or observe-specific input with `runtimeSessionId` and `runtimePromptMessageId`;
- pass values from `OpenCodePromptDeliveryLedgerRecord.runtimeSessionId` and `lastRuntimePromptMessageId`;
- keep old records working when these fields are absent;
- do not expose these IDs in renderer copy, only diagnostics.

Tests must include:

- accepted prompt in session A, current lane now session B, observe still reads session A;
- exact session not found returns `session_stale`/`reconcile_failed` and does not inspect session B;
- runtimePromptMessageId mismatch does not count an unrelated prompt as delivered;
- old ledger with only `prePromptCursor` still uses fallback.

#### Phase 3.5 Idempotency Requirements

Never reuse these concepts incorrectly:

- `messageId` - app-level logical delivery ID, stable across retry;
- `deliveryAttemptId` - attempt ID, one per attempt;
- `runtimePromptMessageId` - OpenCode prompt_async message ID, one per accepted runtime prompt;
- `relayOfMessageId` - correlation to original app message.

Rules:

- if `prompt_async` accepted, do not issue another prompt for the same attempt;
- if follow-up observation times out, ledger may stay pending/unknown but must not blindly duplicate;
- retry creates a new `deliveryAttemptId` and a new `runtimePromptMessageId`;
- the ledger must keep all accepted runtime prompt IDs for correlation;
- if late visible reply arrives from older prompt, correlation accepts first valid proof and suppresses duplicate warning.
- `payloadHash` mismatch must remain terminal/precondition-style, not "retry with new payload" under the same ledger ID;
- `deliveryAttemptId` remains the idempotency key for commandStatus recovery;
- `runtimePromptMessageId` must never be used as the app inbox `messageId`.

#### Phase 3.6 Bridge Timeout Changes

Current app-side `DEFAULT_SEND_TIMEOUT_MS` is around 45 seconds.

With accept-fast:

- app send timeout can be lower for acceptance path, for example 15-25 seconds;
- observation timeout can be separate, for example 45-90 seconds;
- never use a single timeout for both acceptance and completion.

Candidate constants:

```ts
const OPENCODE_PROMPT_ACCEPTANCE_TIMEOUT_MS = 20_000;
const OPENCODE_TURN_OBSERVATION_TIMEOUT_MS = 75_000;
```

Do not tune these by gut feeling. Add metrics from Phase 0 first.

Crucial:

- lowering acceptance timeout must not break stale/MCP repair path;
- if pre-prompt repair commonly takes longer than 20s, keep send timeout higher until repair is separately optimized;
- use measured `mcp_ready_check` and `session_recreate` timings from Phase 0.

#### Phase 3.7 Interaction With Existing Watchdog

Existing delivery watchdog remains responsible for:

- no visible reply;
- no task progress proof;
- tool error such as `Not connected`;
- retrying same logical message when safe.

Accept-fast changes only:

```text
prompt_async endpoint acceptance is detected sooner
```

It must not:

- mark inbox read earlier;
- mark delivery responded;
- suppress watchdog proof checks;
- create extra pings in member-work-sync.

Specific watchdog rules:

- records with `acceptedAt` and `runtimePromptMessageId` should not become `acceptanceUnknown`;
- observation timeout after acceptance should schedule observation/proof follow-up, not immediate prompt retry;
- prompt retry is allowed only when current ledger policy says retryable and no accepted prompt is still awaiting proof;
- foreground unread assignment still suppresses member-work-sync nudges.

#### Phase 3.8 Tests

Orchestrator:

- healthy MCP returns accepted quickly after `prompt_async`;
- stale session recreate happens before prompt;
- MCP attach failure rejects before prompt;
- no-reply command cannot use observed wrapper;
- same-session `session.error` during submitting is buffered until acceptance;
- premature SSE EOF returns `stream_unavailable` diagnostics;
- commandStatus/follow-up observer maps accepted prompt to final outcome;
- observeMessageDelivery uses `runtimeSessionId` + `runtimePromptMessageId` even if the current lane record now points elsewhere;
- observeMessageDelivery returns session-stale diagnostics instead of inspecting a different session when exact session lookup fails;
- no double `promptAsync` for one accepted attempt.

`claude_team`:

- `deliverOpenCodeMemberMessage()` records accepted prompt without waiting for visible reply;
- ledger stores `lastRuntimePromptMessageId` and appends accepted runtime prompt IDs without duplicating them on commandStatus recovery;
- ledger remains pending until proof;
- watchdog observes accepted prompt and does not duplicate immediately;
- watchdog passes exact runtime session/prompt identity into observe path when available;
- response proof updates same ledger record;
- timeout after acceptance produces pending/needs_observation, not failed terminal;
- member-work-sync gets turn-settled event and only enqueues reconcile;
- foreground unread assignment still suppresses duplicate work-sync nudge.
- active member delivery queue is not unblocked by acceptance alone;
- commandStatus precondition mismatch is still rejected;
- outcome store does not leak accepted pending outcomes forever;
- accepted prompt with later visible proof clears advisory banner.

Suggested commands:

```bash
pnpm vitest run \
  test/main/services/team/OpenCodeReadinessBridge.test.ts \
  test/main/services/team/TeamProvisioningService.test.ts \
  test/main/services/team/OpenCodePromptDeliveryLedger.test.ts \
  test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
```

```bash
bun test \
  src/services/opencode/OpenCodeBridgeCommandHandler.test.ts \
  src/services/opencode/OpenCodeSessionBridge.test.ts \
  src/services/opencode/OpenCodeTurnSettledObserver.test.ts \
  src/services/opencode/OpenCodeCommandOutcomeStore.test.ts
```

Acceptance:

- initial prompt acceptance is not delayed by full model turn;
- accepted prompt is never duplicated by the same attempt;
- visible reply/task progress still controls final delivery state;
- member-work-sync and watchdog do not conflict.

---

### Phase 4 - Retry, Recreate, And Live Validation

Score:

`🎯 8   🛡️ 8   🧠 5`, roughly `180-350 LOC` plus live test scripts/results.

Goal:

After Phase 3 changes acceptance behavior, tune retry/recreate policies based on real evidence.

#### Phase 4.1 Reclassify Timeouts

Separate:

```text
acceptance_timeout
observation_timeout
response_proof_timeout
mcp_unavailable
session_recreate_failed
provider_error
accepted_observation_pending
accepted_response_proof_missing
```

Do not collapse all of these into:

```text
OpenCode bridge command timed out
```

Why:

- acceptance timeout may mean prompt was never accepted;
- observation timeout may mean prompt accepted but model still running;
- response proof timeout may mean model answered plain text or wrong tool;
- MCP unavailable is actionable repair path;
- provider error should not become a sync-nudge problem.
- accepted observation pending should not create a duplicate prompt.
- accepted response proof missing should use existing proof/watchdog logic.

#### Phase 4.2 Retry Delay Policy

Current retry delay is around 15 seconds.

With accept-fast:

- if prompt accepted, do not retry too quickly;
- if prompt not accepted due repair failure, retry can stay relatively short;
- if MCP unavailable after recreate, retry should allow session recovery time;
- if provider error, retry policy should distinguish rate/credit/model unavailable from prompt failure.

Candidate policy:

```ts
function getOpenCodeDeliveryRetryDelay(reason: DeliveryFailureReason): number {
  switch (reason) {
    case "acceptance_timeout":
      return 10_000;
    case "observation_timeout_after_acceptance":
      return 60_000;
    case "mcp_unavailable":
      return 30_000;
    case "provider_error":
      return 90_000;
    default:
      return 15_000;
  }
}
```

Only implement after tests cover idempotency.

#### Phase 4.3 Live Smoke Matrix

Keep live tests narrow. Do not run a full expensive model matrix by default.

Recommended live scenarios:

1. Cheap OpenCode model, direct task assignment.
2. OpenCode stale session recreate before prompt.
3. OpenCode MCP missing/reattach before prompt.
4. OpenCode task log lookup after session recreate.
5. Member-work-sync turn-settled wakeup after accepted prompt.
6. Active queue scenario: send two messages to one OpenCode member and prove the second does not prompt until the first has proof or terminal state.
7. Recreated-session task logs: force/reuse a stale session, deliver a task, and verify task logs load from the accepted runtime session.

Live command examples should be added to a runbook, not hardcoded into unit tests.

Example env gates:

```bash
OPENCODE_E2E=1 \
OPENCODE_DELIVERY_ACCEPT_FAST_LIVE=1 \
pnpm vitest run test/main/services/team/OpenCodeAcceptFastDelivery.live-e2e.test.ts
```

Do not require paid model credentials for normal CI.

#### Phase 4.4 Production Diagnostics

Add a compact diagnostic summary visible in developer details:

```text
OpenCode delivery:
- prompt accepted after 6.4s
- session recreated once
- MCP reattached
- observation settled after 31.2s
- visible reply proof received after 33.7s
```

Do not show this as a warning if final delivery succeeded.

Acceptance:

- delayed-start cases can be explained from artifacts;
- successful replies do not show stale warning banners;
- failed cases identify the failed layer.

---

## 7. Highest-Risk Implementation Details

This section is the extra caution layer before coding. These are the places most likely to create subtle bugs.

### 7.1 Exact Session Identity Must Flow End-To-End

If any layer drops `runtimeSessionId` or `runtimePromptMessageId`, the system can fall back to current lane state and reintroduce the old bug.

Required flow:

```text
orchestrator prompt_async accepted
-> OpenCodeSendMessageCommandData.sessionId
-> OpenCodeSendMessageCommandData.runtimePromptMessageId
-> OpenCodeTeamRuntimeAdapter result
-> OpenCodePromptDeliveryLedger runtime fields
-> observeMessageDelivery exact session/prompt
-> task-log session evidence
```

If a field is missing:

- old ledger compatibility is allowed;
- new accepted attempts should emit a diagnostic;
- do not guess with current lane if exact evidence was expected and mismatched.

Risk:

`🎯 9   🛡️ 8   🧠 7`, roughly `160-280 LOC`.

### 7.2 Queue Slot Semantics Must Stay Completion-Based

The active delivery slot must not be released by `accepted=true`.

Safe state transitions:

```text
pending -> accepted
accepted -> responded
accepted -> unanswered
accepted -> failed_retryable
accepted -> failed_terminal
```

Unsafe transition:

```text
accepted -> terminal just because endpoint accepted
```

The active slot should be released only by:

- read-commit allowed proof;
- terminal failure;
- existing queue/retry policy after proof checks.

Risk:

`🎯 8   🛡️ 8   🧠 6`, roughly `80-160 LOC`.

### 7.3 Observation Must Be Read-Only Unless It Updates The Same Ledger Record

Observation should not create a new logical delivery. It should only enrich the existing ledger record.

Rules:

- `applyObservation()` should not increment attempts;
- `applyObservation()` should not replace `inboxMessageId`;
- observation timeout after acceptance should not immediately call `sendMessageToMember()`;
- visible proof/materialization must run after observation result, not before returning stale pending state.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `60-120 LOC`.

### 7.4 Task Log Source Must Stay Conservative

Task logs are user-facing audit evidence. Incorrect logs are worse than empty logs.

Required filter order:

```text
team match
member match
session match when exact
task marker or task window match
time/window bounds
dedupe
sort
render
```

Never include native tools from a session solely because the member owns the task. There must be an anchor:

- task marker;
- attribution bounds;
- accepted delivery prompt window;
- explicit source message/task reference.

Risk:

`🎯 9   🛡️ 8   🧠 6`, roughly `140-260 LOC`.

### 7.5 Member-Work-Sync And Watchdog Must Not Become Two Retry Loops

Phase 3 can create more "accepted but no proof yet" states. That must not cause both systems to nudge at the same time.

Rules:

- turn-settled event only enqueues member-work-sync reconcile;
- delivery watchdog owns response proof retry;
- task-stall watchdog owns semantic task progress stalls;
- member-work-sync nudge is suppressed by foreground unread actionable messages and watchdog cooldowns;
- delivery retry is not triggered by member-work-sync alone.

Risk:

`🎯 8   🛡️ 8   🧠 7`, roughly `120-220 LOC`.

### 7.6 Timeout Taxonomy Must Be Visible In Artifacts

Without a clear taxonomy, future debugging will again collapse into "OpenCode timed out".

Every timeout should be classified as one of:

```text
pre_prompt_repair_timeout
prompt_acceptance_timeout
turn_observation_timeout
response_proof_timeout
command_status_timeout
transcript_lookup_timeout
```

Diagnostics should be machine-readable and short. User-facing warnings should be based on final proof state, not raw timeout class.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `80-160 LOC`.

### 7.7 Proof Contract Drift Is A Bigger Risk Than Timeout Tuning

The most dangerous accidental simplification is:

```text
OpenCode prompt accepted + assistant produced any output = delivery succeeded
```

That is false.

Current behavior intentionally distinguishes:

- visible reply to user;
- peer relay;
- task-linked progress proof;
- plain-text fallback after tool failure;
- work-sync lease/report;
- task-stall remediation progress.

If Phase 3 loses `messageKind`, `taskRefs`, `relayOfMessageId`, or `actionMode`, later observation can clear the wrong delivery.

Required guard:

```text
read/responded commit must stay in TeamProvisioningService proof helpers
```

Do not move final proof semantics into orchestrator. The orchestrator can observe runtime events, but it should not decide app-level read/responded state.

Risk:

`🎯 9   🛡️ 8   🧠 7`, roughly `120-240 LOC`.

### 7.8 Task Log Cache Can Make A Fixed Session Lookup Look Broken

Even if exact session transcript lookup works, the user can still see stale empty logs if cache keys do not include evidence identity.

Fragile cache layers:

```text
OpenCodeTaskLogStreamSource short cache
BoardTaskLogStreamService layout cache
runtime transcript bridge temp-output path
renderer query/cache layer
```

Rules:

- exact session evidence changes the OpenCode source cache key;
- fallback segment IDs include session identity;
- layout merge must not drop fallback segments with distinct session IDs;
- fallback suppression must be scoped to the same task owner/session/provider, not any execution record;
- no long TTL should be introduced for OpenCode exact evidence;
- diagnostics should say whether the empty state came from no evidence, transcript miss, projection miss, or cache hit.

Risk:

`🎯 8   🛡️ 8   🧠 6`, roughly `100-220 LOC`.

### 7.9 Sync Control Plane Must Stay Mostly Invisible To Users

Member-work-sync is a control plane, not conversation content. If Phase 3 or 4 starts surfacing every sync nudge, users will see "automation spam" even when the system is behaving correctly.

Rules:

- normal Messages feed hides `member_work_sync_nudge` by default;
- task/activity/debug surfaces can expose sync details when explicitly requested;
- work-sync nudge delivery does not count as user-visible response proof for unrelated messages;
- sync nudge rate limits and watchdog cooldowns remain centralized in member-work-sync services.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `40-90 LOC`.

### 7.10 Timeout Recovery Can Lose The Only Exact Prompt Anchor

The timeout-recovery path is exactly where exact runtime identity matters most. If bridge timeout recovery synthesizes an accepted response but drops `runtimePromptMessageId`, later observe and task-log lookup regress to current-session heuristics.

Rules:

- `runtimePromptMessageId` is part of the acceptance contract;
- `commandStatus` recovery must preserve it even when `sendMessageData` is absent;
- app adapter result must expose it;
- ledger dedupes repeated recovery for the same `deliveryAttemptId + runtimePromptMessageId`.

Risk:

`🎯 9   🛡️ 8   🧠 5`, roughly `70-140 LOC`.

### 7.11 Turn-Settled Event Schema Drift Can Disable OpenCode Work-Sync Silently

Member-work-sync uses a payload normalizer with strict provider/source/event fields. A harmless-looking orchestrator schema rename can stop OpenCode turn-settled events from being consumed.

Rules:

- keep `source = agent-teams-orchestrator-opencode`;
- keep `eventName = runtime_turn_settled`;
- keep `hookEventName = Stop`;
- keep `runtimePromptMessageId` mapping to `threadId`;
- version any breaking schema change and migrate normalizer in the same cut.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `40-90 LOC`.

### 7.12 Advisory Classification Must Not Turn Lag Into Error

Accept-fast increases the chance of a period where prompt acceptance is known but proof is not observed yet. That period is expected and should not become an immediate user-facing error.

Rules:

- observation lag after acceptance is `checking`/pending, not hard failure;
- hard tool/session errors still surface according to existing policy;
- superseding visible reply/task progress clears stale advisory candidates;
- renderer should not show a warning after successful proof.
- backend proof paths must invalidate `TeamMemberRuntimeAdvisoryService` cache for the affected member;
- tests should not pass only because the 30 second advisory cache expires.

Risk:

`🎯 9   🛡️ 8   🧠 5`, roughly `60-130 LOC`.

### 7.12.1 Advisory Cache Can Preserve A Correctly-Suppressed Warning

Even if `OpenCodeRuntimeDeliveryAdvisoryPolicy` is correct, `TeamMemberRuntimeAdvisoryService` can return an old cached warning for up to 30 seconds.

This is a backend cache consistency problem, not a renderer problem.

Rules:

- proof/materialization paths call `TeamDataService.invalidateMemberRuntimeAdvisory(teamName, memberName)`;
- if proof path only knows the team, call `invalidateTeamRuntimeAdvisories(teamName)` rather than guessing a member;
- do not add renderer-side "hide warning after new message" heuristics;
- do not shorten the TTL as the primary fix, because that increases IO and still leaves a stale window.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `50-110 LOC`.

### 7.13 Payload Hash Drift Can Break Recovery And Mark Real Messages Failed

Adding optional transport fields to the send command can accidentally change `payloadHash`. That can make commandStatus recovery reject the true accepted command or make the ledger fail an existing logical message as a payload mismatch.

Rules:

- treat app ledger hash and bridge command hash as separate contracts;
- freeze canonical bridge hash input before adding `settlementMode`;
- exclude response-only fields from bridge send hash;
- keep app ledger hash limited to logical/user-visible delivery payload;
- add tests for unchanged hashes when only transport/observation knobs differ;
- add tests that real text/taskRefs/actionMode changes still change app ledger hash.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `60-120 LOC`.

### 7.14 Runtime Store Compatibility Can Fail Before Feature Logic Runs

`VersionedJsonStore` validates on every locked update. If schema normalization is wrong, delivery code may fail before reaching the new acceptance/observe logic.

Rules:

- old ledger records without new fields must parse;
- update paths should normalize missing arrays/nulls;
- future-schema behavior remains quarantine, but missing new optional fields do not;
- compatibility tests must use realistic old ledger JSON, not only constructed TS objects.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `80-160 LOC`.

### 7.15 Acceptance Unknown Must Not Be Upgraded By Optimism

Bridge timeout plus failed commandStatus is not prompt acceptance. It is `acceptanceUnknown`.

Rules:

- only endpoint acceptance or strict commandStatus evidence can clear `acceptanceUnknown`;
- do not synthesize `runtimePromptMessageId`;
- retry/observe policy for unknown acceptance remains conservative;
- exact observe is optional only after real prompt identity exists.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `70-140 LOC`.

### 7.16 Coarse Board Progress Can Suppress Warnings But Cannot Prove Every Delivery

The proof reader can see board progress after a prompt by reading task comments/history. That is useful, but it is not equivalent to a visible reply.

Rules:

- board progress can suppress stale advisory candidates for the same member/task;
- board progress cannot satisfy peer relay recipient correctness;
- board progress cannot mark a normal direct message read unless existing read-commit policy allows it;
- weak start-only comments stay weak and should not become response proof;
- work-sync/task-stall can define their own board-progress proof contract, but it must not leak into normal delivery.

Risk:

`🎯 9   🛡️ 8   🧠 5`, roughly `80-160 LOC`.

### 7.17 Invalidation Must Cross The Main/Worker Boundary

Runtime advisory data can be served by both in-process `TeamDataService` and the team-data worker. Updating only one cache leaves the UI stale depending on which path serves the next snapshot.

Rules:

- use the existing `setMemberRuntimeAdvisoryInvalidator` boundary for proof paths;
- invalidate both `teamDataService` and `TeamDataWorkerClient`;
- if extracted async observer cannot access that callback, pass an invalidation port into it;
- do not import renderer or IPC code into proof/domain logic.

Risk:

`🎯 9   🛡️ 9   🧠 3`, roughly `30-80 LOC`.

### 7.18 Member-Scoped Invalidation Can Be Silently Dropped

`TeamDataWorkerClient` intentionally validates names before posting best-effort worker messages:

```ts
if (!SAFE_NAME_RE.test(teamName)) return;
if (memberName !== undefined && !SAFE_NAME_RE.test(memberName)) return;
```

That is correct at the worker IPC boundary, but it creates a subtle stale-cache risk for advisory invalidation if a member name is not worker-safe.

Rules:

- invalidation port should canonicalize member names using the same configured member name used by team snapshots;
- if canonical member invalidation cannot be proven worker-safe, call team-scoped invalidation as a conservative fallback;
- proof paths must never treat a failed best-effort worker invalidation as delivery failure;
- add a regression test that unsafe member-scoped invalidation does not leave stale worker advisory state.

Risk:

`🎯 8   🛡️ 9   🧠 3`, roughly `30-70 LOC`.

### 7.19 Message Kind Drift Can Break Store Validation Or Filtering

`InboxMessageKind` is used by shared types, inbox persistence, OpenCode bridge DTOs, prompt delivery ledger, and renderer filtering. These whitelists are not generated from one source.

Rules:

- keep message kind parity tests across shared type literals, inbox reader, OpenCode ledger validator, bridge contract, and renderer automation filters;
- never depend on a message kind for proof policy until it round-trips through stored inbox and ledger fixtures;
- if a kind is unsupported for OpenCode delivery, fail before ledger write with a structured diagnostic.

Risk:

`🎯 8   🛡️ 9   🧠 3`, roughly `30-80 LOC`.

### 7.20 Retry Prompt Text Can Accidentally Change Logical Idempotency

Retry control text is prepended to the OpenCode prompt, but it is not the user's original message. If it enters `hashOpenCodePromptDeliveryPayload()`, every retry can look like a different payload and force a terminal mismatch.

Rules:

- compute app ledger hash before adding repair control text;
- keep retry control text out of inbox row text and out of app logical hash;
- include actual prompt text only in bridge command hash, scoped to one concrete command attempt;
- assert that retry control text changes do not create app ledger payload mismatch.

Risk:

`🎯 9   🛡️ 9   🧠 3`, roughly `30-70 LOC`.

### 7.21 Tool-Error Retries Can Loop If MCP Repair Is Not A Gate

When the model hits `message_send` `Not connected`, a retry prompt alone is not enough. It can produce another tool error or another plain assistant fallback in the same broken runtime.

Rules:

- every retry prompt goes through MCP/session readiness repair before prompt submission;
- failed readiness repair schedules retry or surfaces transport diagnostics, but does not send another prompt;
- plain assistant fallback is materialized only when existing semantic/recipient gates pass;
- work-sync and normal delivery continue to use separate proof contracts.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `80-180 LOC`.

### 7.22 TaskRefs-Only Reply Recovery Can Produce False Positives

TaskRefs-only visible reply recovery is deliberately weaker than `relayOfMessageId`. It can be useful when OpenCode missed correlation metadata, but it can also match an older or unrelated task status message by the same member.

Rules:

- use taskRefs-only recovery after exact relay/message-id recovery fails;
- require semantic sufficiency and expected sender;
- keep source-missing compatibility diagnostic-only but visible to developer logs/details;
- do not mark read/responded when taskRefs-only candidates are ambiguous;
- add tests with two candidate replies for the same task and different destinations.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `50-110 LOC`.

### 7.23 Work-Sync Inbox Payload Conflict Can Become A Silent Stale Wake

The work-sync outbox already treats `payloadHash` as part of the idempotency contract, but the inbox sink can still dedupe by `messageId` only.

Rules:

- preserve outbox payload conflict detection as the first line of defense;
- make inbox sink either compare `payloadHash` metadata or prove equivalence from stable payload fields before returning `inserted=false`;
- if the existing inbox row cannot be proven equivalent, return `conflict=true`;
- do not schedule `member_work_sync_nudge_existing` delivery wake after a conflict;
- include conflict diagnostics in work-sync audit, not in the normal Messages feed.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `50-120 LOC`.

### 7.24 Work-Sync Can Be Mistaken For A Fast Assignment Wake

Because work-sync has phase2 readiness, rate limits, lifecycle checks, busy checks, and foreground-unread suppression, using it as the primary way to wake an OpenCode member for a new task will create unpredictable delay.

Rules:

- normal task assignment delivery remains the primary wake path;
- delivery watchdog handles "accepted but no proof" and `message_send` tool errors;
- work-sync handles board-state reconciliation after delivery/turn activity;
- a skipped work-sync nudge must not be interpreted as proof that normal delivery succeeded;
- launch/bootstrap suppression must not suppress normal bootstrap/delivery prompts.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `70-160 LOC`.

### 7.25 Correct Task Logs Can Still Look Late Without Narrow Refresh Events

Exact-session task log lookup can be correct but invisible in the UI if no task-scoped refresh event fires after evidence is written.

Rules:

- emit `task-log-change` with `taskSignalKind: "log"` when task-log evidence changes;
- keep event fanout per taskRef, not per native tool row;
- keep renderer loading lazy for hidden panels;
- summary badge and opened stream must share the same refresh trigger;
- do not use broad `refreshTeamData` as the primary way to refresh task logs.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `60-140 LOC`.

### 7.26 Accept-Fast Can Accidentally Drain The Inbox Queue

If `accepted=true` is treated like "delivered and done", the relay loop can push the next unread message into the same OpenCode member before the first prompt has produced proof.

Rules:

- accepted pending prompt keeps the active ledger slot;
- relay loop stops after accepted pending delivery;
- later unread messages wait for proof, terminal failure, or existing retry policy;
- member-work-sync nudge wake cannot bypass this queue;
- queue behavior is tested with mixed foreground and work-sync inbox rows.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `70-150 LOC`.

### 7.27 Old Orchestrator Can Silently Disable Exact Observation

Accept-fast spans two repos. A user can point `CLAUDE_DEV_RUNTIME_ROOT` at an older orchestrator build that does not know the new exact prompt/session fields.

Rules:

- use explicit OpenCode bridge capability detection;
- if capability is missing, run observed mode and log why;
- never infer accept-fast support from a successful generic bridge command;
- missing exact fields after an acceptance-mode response become `acceptanceUnknown`;
- tests must cover old response shapes and unsupported command errors.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `80-180 LOC`.

### 7.28 Lane Registry Lock Timeout Can Corrupt Diagnosis If It Owns Evidence

`lanes.json` is a shared file-lock boundary. It can be temporarily unavailable while the OpenCode runtime is still alive and the exact session evidence is valid.

Rules:

- store accepted prompt identity outside `lanes.json`;
- do not downgrade accepted prompt to failed because lane diagnostics failed after acceptance;
- exact task-log lookup reads stored session evidence before current lane fallback;
- lane registry failures before first runtime evidence block safely;
- avoid unbounded lane-index writes from event fanout.

Risk:

`🎯 9   🛡️ 8   🧠 5`, roughly `90-220 LOC`.

### 7.29 Runtime Delivery Dedupe Can Hide The Proof Message ID

`TeamInboxWriter.sendMessage()` can return an existing message ID for duplicate `runtime_delivery` rows. If proof code keeps using the attempted message ID, advisory clearing and ledger correlation can drift.

Rules:

- always propagate the returned inbox message ID from `sendMessage()`;
- ledger proof should correlate against returned existing ID when deduped;
- do not use dedupe as proof without ledger validation;
- keep dedupe scoped to same `relayOfMessageId`;
- non-runtime control messages do not use runtime-delivery dedupe.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `50-130 LOC`.

### 7.30 Bridge Idempotency Can Drift From App Delivery Idempotency

The app delivery ledger hash and the bridge command idempotency key solve different problems. Accept-fast transport fields can accidentally change the bridge command body while the logical user message is still the same.

Rules:

- persist settlement mode on the delivery record;
- keep app logical payload hash independent from retry-control text and observation tuning;
- keep bridge requestHash stable for a single delivery attempt;
- store original bridge requestId for timeout recovery;
- require commandStatus recovery to echo exact prompt identity before upgrading to accepted.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `80-180 LOC`.

### 7.31 Runtime `message_send` Conflicts Can Be Misread As MCP Failure

Runtime delivery conflicts are agent-to-app idempotency conflicts. They are not OpenCode MCP readiness failures. Misclassifying them can make the watchdog repair the wrong layer.

Rules:

- keep `idempotency_conflict`, `destination_write_failed`, and `mcp_not_connected` as separate failure reasons;
- runtime delivery journal conflicts do not trigger OpenCode MCP reattach by themselves;
- prompt delivery repair can mention a previous message_send conflict only as payload guidance;
- visible proof requires verified destination write, not transcript-only message_send attempt;
- if retry asks the model to resend, specify whether to reuse exact payload or create a new idempotency key.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `70-160 LOC`.

### 7.32 User-Visible Reply Can Be Stored Where Proof Reader Does Not Look

If `RuntimeDeliveryService` writes a direct user reply to `sentMessages.json` but `OpenCodeRuntimeDeliveryProofReader` only scans inbox rows, the UI can show a valid reply while advisory/watchdog still thinks proof is missing.

Rules:

- proof reader must cover `user_sent_messages`, `member_inbox`, and cross-team destinations according to the runtime delivery destination kind;
- source-string compatibility is not enough without matching destination location or relay metadata;
- do not accept arbitrary sent messages from the lead as OpenCode member proof;
- tests must cover direct user reply and lead-recipient fallback separately.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `100-220 LOC`.

### 7.33 Concurrent Sent Message Writes Can Drop Runtime Proof

`sentMessages.json` currently has a simpler append path than inbox files. Concurrent OpenCode members can both write direct user replies and race.

Rules:

- add a locked append/verify path for sent messages before relying on it for proof;
- dedupe by destination message ID under lock;
- keep MAX_MESSAGES trimming deterministic and proof-safe;
- do not change normal lead-process rendering semantics while adding the lock;
- test concurrent direct user runtime replies.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `70-160 LOC`.

### 7.34 Runtime TaskRefs Can Be Silently Dropped

The runtime delivery normalizer currently filters taskRefs to strings. If OpenCode sends structured taskRefs, task context can disappear without an error.

Rules:

- make taskRefs input schema explicit in MCP prompt and app normalizer;
- reject or preserve invalid shapes, never silently drop all context;
- keep hash/proof/task-log matching aligned with the selected shape;
- test prompt artifacts and runtime delivery normalizer together.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `50-120 LOC`.

### 7.35 Unknown Secondary Runtime Can Fall Back To Primary Lane

If lane metadata is missing, a secondary OpenCode member control call can accidentally resolve as `primary`. That is a correctness risk for delivery journals, task-log evidence, and heartbeats.

Rules:

- fail closed for unresolved non-lead secondary members;
- allow primary fallback only for true primary OpenCode runtime;
- use exact committed session evidence when available;
- keep message delivery, task event, and heartbeat lane resolution identical.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `90-220 LOC`.

### 7.36 Work-Sync Can Jump Ahead If Relay Priority Is Misread

The code sorts OpenCode inbox relay candidates ascending by numeric priority. Work-sync currently has a larger number because it should run later, not sooner.

Rules:

- document sort direction next to `getOpenCodeInboxRelayPriority()`;
- test foreground task assignment before work-sync, including older work-sync messages;
- keep `onlyMessageId` as an explicit override only;
- preserve accepted-pending queue stop behavior;
- keep busy-status diagnostics separate from UI hidden-row filtering.

Risk:

`🎯 9   🛡️ 9   🧠 3`, roughly `30-90 LOC`.

### 7.37 Hidden Automation Rows Can Become Undebuggable

Hiding work-sync and task-stall rows from Messages is good UX, but hiding them too early can remove the only visible clue that an automation path fired.

Rules:

- keep durable inbox rows intact and unread until the delivery/proof path consumes them;
- keep diagnostic/audit views able to opt into automation rows;
- ensure `TeamInboxReader` preserves automation messageKind values;
- do not use UI-filtered feeds for delivery, watchdog, or prompt ledger rebuild;
- add tests where hidden work-sync is delivered to OpenCode even though Messages does not show it.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `60-140 LOC`.

### 7.38 File-Change Backfill Can Be Broken By Delivery Context Drift

OpenCode Changes review depends on `ChangeExtractorService` and task ledger backfill, not on task-log native tool rows. Accept-fast and retry changes can accidentally alter or remove the delivery context that backfill needs.

Rules:

- keep delivery context hash stable for logical delivery identity;
- pass exact session/member/lane/task evidence into backfill;
- do not cache negative backfill when a delivery context exists or appears later;
- keep metadata-only evidence as manual-review, not as "no changes";
- verify current evidence contract before caching duplicates-only results.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `120-260 LOC`.

### 7.39 Runtime Store Recovery Can Lose Canonical Evidence

Manifest recovery is useful, but prompt/runtime delivery evidence is not disposable. A broad cleanup after corruption can make a real visible reply look unproven.

Rules:

- distinguish diagnostic-only stores from delivery ledgers;
- never drop prompt/runtime delivery ledgers without quarantine and rebuild status;
- rebuild delivery stores from canonical destination writes, not provider session guesses alone;
- do not let provider rebuild overwrite newer canonical destination evidence;
- include recovery action and source in artifacts.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `100-240 LOC`.

### 7.40 Stale OpenCode Runtime Can Write After Team Stop Or Relaunch

A stopped team can still have a stale `opencode serve` process briefly alive. A restarted team can also have old session callbacks arriving after a new run is current.

Rules:

- validate current run/lane/tombstone immediately before every runtime-originated durable write;
- reject stale evidence as stale runtime evidence, not as generic provider failure;
- do not let stale delivery clear advisory, mark inbox read, update liveness, or emit task-log refresh;
- stop/relaunch cleanup must not delete delivery ledgers before they are captured in artifacts;
- tests must cover app restart with orphaned lane evidence and stale runtime process.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `120-280 LOC`.

### 7.41 Destination Write Succeeds But UI Warning Stays Stale

Runtime delivery can correctly write a visible reply while renderer cache or member advisory still shows "delivery is being checked".

Rules:

- destination write emits the same event family as normal user-facing writes;
- advisory invalidation follows proof-capable writes;
- hidden automation rows still invalidate diagnostic/advisory caches;
- worker-cache invalidation failure is diagnostic-only and does not block the durable write;
- tests must assert both durable store state and renderer/event fanout.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-180 LOC`.

### 7.42 Rebuild Can Turn Ambiguous Destination Rows Into False Success

After corruption recovery, it is tempting to rebuild prompt ledger state from any matching visible row. That can hide a real transport failure or clear the wrong delivery.

Rules:

- strict relay/source/destination proof is required for visible proof;
- exact runtime prompt identity is required for transport accepted state;
- ambiguous destination matches remain ambiguous;
- hidden automation rows only rebuild automation-intent deliveries;
- stale run rows are ignored for current run rebuild.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `90-220 LOC`.

### 7.43 Work-Sync Timing Can Create Either Long Delays Or Spam

The member-work-sync queue has fast trigger defaults, but a broad quiet-window override or scheduled-only dispatch path can turn normal assignment wakeup into a minute-scale delay. The opposite mistake is sending work-sync while foreground delivery is still pending.

Rules:

- keep trigger-specific timing explicit;
- do not let startup/member-spawn scans dispatch nudges before launch readiness;
- foreground unread or accepted-pending delivery suppresses generic work-sync;
- scheduled dispatcher recovers due outbox rows but does not replace direct delivery wake;
- diagnostics must show why a nudge is queued, delayed, skipped, or rate-limited.

Risk:

`🎯 9   🛡️ 8   🧠 5`, roughly `120-260 LOC`.

### 7.44 Slow Delivery Has No Single Correlation Timeline

Without a correlated phase timeline, every slow run looks like "OpenCode is slow" even when the delay is actually queue timing, relay busy state, MCP repair, provider latency, or task-log projection.

Rules:

- add shared correlation fields to existing ledgers, not a cross-layer mega-log;
- include phase timestamps from task assignment to first tool/proof;
- keep timeline developer-only;
- live tests should print the timeline on slow pass and failure.

Risk:

`🎯 8   🛡️ 9   🧠 4`, roughly `80-200 LOC`.

### 7.45 UI Can Show "Working On" While Runtime Is Failed

Task ownership and runtime liveness are different facts. If the card prioritizes task label over launch failure, users believe the agent is working while it cannot receive prompts.

Rules:

- runtime health/advisory status outranks task labels visually;
- task label remains context, not liveness proof;
- stale spawn snapshot after stop/offline must not resurrect working status;
- hover/detail surfaces should separate assignment, runtime, lane/session, and worktree facts.

Risk:

`🎯 9   🛡️ 8   🧠 3`, roughly `50-130 LOC`.

### 7.46 Transcript-Only Plain Text After Tool Error Can Look Like Success

OpenCode may write useful text in its transcript after `message_send` fails. That text is not a delivered app message unless it lands in the durable destination store.

Rules:

- never clear delivery advisory from transcript-only fallback text;
- retry/repair should preserve the user's logical message id;
- task changes can be visible while reply proof remains missing;
- do not synthesize app-visible replies from transcript text.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `80-180 LOC`.

### 7.47 Agenda Fingerprint Churn Can Cause Nudge Storms

If volatile presentation data enters the agenda fingerprint, the system can invalidate valid reports on every refresh and repeatedly schedule sync nudges.

Rules:

- keep fingerprint payload semantic and minimal;
- add regression tests before adding any new field to `AgendaFingerprintPayload`;
- treat `sourceRevision` as dangerous until its semantics are documented and tested;
- report token invalidation must happen because actionable work changed, not because UI state changed.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `70-160 LOC`.

### 7.48 Stale Report Token Can Suppress Real Work

Offline/pending report replay can be useful, but accepting stale `caught_up` or `still_working` after the board changed would hide real work from the reconciler.

Rules:

- re-read current agenda on every report and replay;
- reject stale fingerprint/token before applying leases;
- rejected reports can be stored as diagnostics only;
- pending replay never marks a member caught up unless current agenda is empty.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `90-220 LOC`.

### 7.49 Turn-Settled Event Can Be Lost Or Routed To Wrong Member

Runtime hooks and observers are external edges. A crash between write and drain, duplicate file, stale provider payload, or wrong transcript match can silently break work-sync.

Rules:

- file state transitions are incoming -> processing -> processed/invalid;
- stale processing recovery is tested;
- provider mismatch and removed members are rejected;
- duplicate events are harmless at queue/outbox level;
- malformed files are quarantined, not retried forever.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `120-280 LOC`.

### 7.50 Task Impact Routing Can Miss The Real Owner Or Ping Everyone

Task-change routing is a tradeoff between narrow correctness and safe fallback. A bad resolver can either miss a member who needs a wakeup or enqueue the entire team too often.

Rules:

- owner/reviewer/lead/dependency resolution has direct unit coverage;
- unknown task ID fallback is diagnostic and rate-limited downstream;
- removed members are filtered;
- resolver exceptions fall back to scan, not silent drop;
- team-wide fallback must not bypass nudge readiness/cooldown gates.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `90-220 LOC`.

### 7.51 Busy Signal Can Suppress Nudges Forever

If a tool finish/reset event is missed, an in-memory active-tool busy flag can suppress sync nudges longer than intended.

Rules:

- busy is advisory, not authoritative;
- every busy reason has a bounded retryAfter;
- active tool state has a reset/drop path;
- foreground delivery ignores generic work-sync busy;
- busy-signal failure delays briefly and logs diagnostics.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `60-160 LOC`.

### 7.52 Outbox Dispatch Without Revalidation Can Deliver Stale Nudges

Planning and dispatch happen at different times. If dispatch trusts the planned row without reloading agenda and metrics, stale work-sync messages can wake agents after they already reported or completed work.

Rules:

- dispatch revalidates agenda, lifecycle, phase2 activation, busy, rate limit, and watchdog cooldown;
- stale outbox items are superseded;
- retryable blockers receive bounded nextAttemptAt;
- delivered review-pickup event IDs prevent repeat delivery for the same request.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `120-260 LOC`.

### 7.53 Existing Inbox MessageId Can Hide Payload Drift

Message ID idempotency is useful, but returning success for an existing row without checking payload shape can hide a stale or corrupted hidden automation message.

Rules:

- sink stays behind outbox payloadHash validation;
- future sink reuse must compare payloadHash or messageKind/source/taskRefs;
- existing row ambiguity is conflict, not delivered;
- hidden automation rows remain debug-readable.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-160 LOC`.

### 7.54 Broad Queue Quiet Window Can Reintroduce Minute-Scale Starts

The event queue supports fast trigger defaults, but a broad `queueQuietWindowMs` override can delay `turn_settled` and `tool_finished` unless per-trigger timing is explicit.

Rules:

- do not use broad quietWindow as production tuning for all triggers;
- preserve fast trigger defaults or explicit triggerTiming;
- maxCoalesceWait is tested for each trigger family;
- diagnostics expose the timing decision.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `60-150 LOC`.

### 7.55 Targeted Recovery Can Accidentally Become Global Early Nudging

OpenCode targeted recovery exists because OpenCode has a provider-specific runtime delivery path. Expanding that bypass to all providers would skip shadow-readiness safety.

Rules:

- targeted recovery stays provider-specific;
- strict review pickup is the only cross-provider early exception;
- non-OpenCode secondary members wait for phase2 readiness unless explicitly covered by a new provider adapter and tests;
- dispatch-time safety checks still apply.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `80-200 LOC`.

### 7.56 Status Read Refresh Can Become Hidden Work

Refreshing stale work-sync status on read is useful, but a renderer poll should not become a hidden delivery loop.

Rules:

- stale read enqueues reconcile only;
- queue coalesces repeated reads;
- stale read never writes inbox or sends prompts directly;
- inactive team checks remain authoritative.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `60-140 LOC`.

### 7.57 Scheduled Dispatcher Can Mask Fresh Delivery Bugs

If fresh assignment wakeups rely on the periodic dispatcher, users can see minute-scale delays and the root foreground delivery bug stays hidden.

Rules:

- scheduler is recovery-only;
- fresh assignment uses foreground delivery and event queue;
- slow-start diagnostics identify queue vs scheduler path;
- scheduler only scans lifecycle-active teams.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `50-130 LOC`.

### 7.58 Provider Hook Wiring Can Look Enabled But Emit Nothing

Claude, Codex, and OpenCode do not share one installation path. A green Claude Stop hook test does not prove Codex env injection or OpenCode bridge env injection.

Rules:

- test each provider's actual emitter path;
- log install mode and spool root diagnostics;
- missing env should degrade to no turn-settled signal, not failed foreground delivery.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `80-180 LOC`.

### 7.59 Normalizer Drift Can Route Wrong Provider Events

If provider/source validation becomes loose, a malformed runtime event can enqueue reconcile for the wrong member or provider.

Rules:

- provider and source strings are contract fields;
- claimed-provider source mismatch fails closed;
- duplicate identity is stable and tested.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `60-140 LOC`.

### 7.60 Drain Scheduler Failure Can Silently Stop Reconcile

If the drain scheduler stops after one exception, live agents can keep finishing turns while the app never sees events.

Rules:

- scheduler failure is warning-only;
- next tick still runs;
- stale processing files are recovered or quarantined;
- no drain path writes inbox directly.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-160 LOC`.

### 7.61 Audit Journal Loss Can Hide Diagnostics But Must Not Change State

The audit journal is rotated, truncated, and warning-only. Treating it as canonical proof would create hidden data-loss bugs.

Rules:

- audit is diagnostics only;
- canonical state remains in stores/ledgers/outbox/inbox/runtime event store;
- audit append failure cannot fail business flows.

Risk:

`🎯 9   🛡️ 9   🧠 3`, roughly `30-90 LOC`.

### 7.62 Sparse Metrics Can Accidentally Enable Or Disable Phase 2

Shadow readiness can become misleading if empty, corrupt, or truncated metrics are interpreted as healthy.

Rules:

- empty metrics remain collecting/not-ready;
- corrupt/truncated data is conservative;
- high nudge, churn, or rejection rates block readiness.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-150 LOC`.

### 7.63 Raw Member Names Can Corrupt Per-Member Stores

Directly joining member names into storage paths can split state, collide with reserved names, or write outside the intended member directory.

Rules:

- use `MemberWorkSyncStorePaths` and `TeamMemberStoragePaths`;
- store canonical key and display name separately;
- path uncertainty fails closed before nudge dispatch.

Risk:

`🎯 9   🛡️ 9   🧠 3`, roughly `40-110 LOC`.

### 7.64 Event Detail Shape Drift Can Drop Sync Triggers

If `TeamChangeEvent.detail` changes shape, router parsing can silently miss inbox, tool, task, or turn-settled events.

Rules:

- parse detail defensively;
- cover every emitted detail shape with tests;
- fallback team-wide only for durable task changes where exact target is unknown.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `80-180 LOC`.

### 7.65 Wake Failure Can Make Delivered Nudges Look Idle

The inbox row can be inserted and outbox marked delivered, while the runtime wake fails and the agent does not process it until a later trigger.

Rules:

- keep inbox insert as durable boundary;
- make wake failure visible in diagnostics;
- allow safe re-wake without duplicate inbox insert.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-160 LOC`.

### 7.66 Pending Report Replay Can Become Infinite Startup Work

Transient reporter failures leave intents pending. Without retry bounds or stale cutoff, every startup can keep replaying the same bad intent.

Rules:

- permanent validation failures are marked processed;
- transient failures are bounded and diagnostic;
- replay always validates against current agenda.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `90-220 LOC`.

### 7.67 Review-Pickup Escalation Can Double Notify Lead

Plan-time and dispatch-time review-pickup failures can both escalate the same review request unless keyed idempotently.

Rules:

- escalation key includes review request IDs and reason class;
- one unchanged review request produces one escalation;
- generic agenda sync never uses review-pickup bypass.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `90-220 LOC`.

### 7.68 Disposed Feature Instances Can Dispatch Stale Nudges

If timers or running queue work survive feature disposal, old dependencies can write inbox rows after app reload or test teardown.

Rules:

- composition owns every timer;
- dispose is idempotent;
- stale in-flight work still passes lifecycle/revalidation before writing.

Risk:

`🎯 8   🛡️ 9   🧠 4`, roughly `70-180 LOC`.

### 7.69 Provider Identity Drift Can Pick The Wrong Delivery Path

Agenda items can be correct while provider id is stale, inferred incorrectly, or hidden by config/meta merge. That can route OpenCode-specific remediation to the wrong path or block it unexpectedly.

Rules:

- provider identity is dispatch metadata, not agenda fingerprint by default;
- removedAt and provider metadata merge rules are explicit;
- unknown provider fails closed for provider-specific direct delivery.

Risk:

`🎯 8   🛡️ 8   🧠 4`, roughly `70-160 LOC`.

### 7.70 Claimed Outbox Rows Can Get Stuck Forever After Crash

A dispatcher can claim a pending nudge and crash before marking delivered, superseded, or failed. Without a claim lease, that row is no longer due and the agent never receives the nudge.

Rules:

- claimed status has a lease, not permanent ownership;
- stale claims are recovered under lock;
- late writes from old attempts are ignored by attemptGeneration.

Risk:

`🎯 9   🛡️ 9   🧠 5`, roughly `100-240 LOC`.

### 7.71 Poison Turn-Settled Payload Can Churn The Drain Forever

Payloads that repeatedly throw after being claimed can bounce from processing back to incoming forever.

Rules:

- processing retries are counted durably;
- repeated failures quarantine;
- one poison file cannot block later files.

Risk:

`🎯 8   🛡️ 9   🧠 5`, roughly `100-240 LOC`.

### 7.72 IPC Or HTTP Source Drift Can Trust The Wrong Actor

Typed renderer calls and HTTP route payloads are not runtime-trusted. If report source is mislabeled, app-originated reports can look like MCP tool reports.

Rules:

- validate and normalize at IPC/HTTP adapters;
- preserve report provenance;
- invalid input cannot create sync storage.

Risk:

`🎯 9   🛡️ 9   🧠 4`, roughly `80-180 LOC`.

### 7.73 Manual Status Reads Can Train Phase 2 Readiness

Opening diagnostics repeatedly can create status_evaluated metrics if request reconciles count exactly like queue/runtime reconciles.

Rules:

- separate request/manual metrics from automation readiness metrics;
- UI refresh never dispatches;
- readiness diagnostics show event provenance.

Risk:

`🎯 9   🛡️ 8   🧠 4`, roughly `80-180 LOC`.

### 7.74 Corrupt Stall Journal Can Suppress Work-Sync Forever

Fail-closed watchdog cooldown is safe against spam, but corrupt/unreadable journal data can become an invisible permanent suppressor.

Rules:

- corrupt journal suppresses temporarily and visibly;
- missing journal does not suppress;
- cooldown remains task-scoped.

Risk:

`🎯 8   🛡️ 8   🧠 3`, roughly `50-130 LOC`.

### 7.75 Duplicate Main-Process Events Can Become Duplicate Nudges

File watcher, provisioning service, and log source events can all notify the same logical change.

Rules:

- event fanout is at-least-once;
- queue/outbox dedupe is the correctness boundary;
- event order must converge to the same state.

Risk:

`🎯 8   🛡️ 9   🧠 4`, roughly `70-170 LOC`.

### 7.76 Index Repair Can Hide Corrupt Member Metadata

Repair currently depends on member meta files to discover member storage. Corrupt meta can hide status/outbox/report rows during repair.

Rules:

- skipped member storage is diagnostic;
- repair never deletes hidden member feature data;
- canonical meta repair stays outside work-sync domain.

Risk:

`🎯 8   🛡️ 8   🧠 5`, roughly `90-220 LOC`.

### 7.77 User-Facing Status Can Confuse Control-Plane State With Agent Failure

Hidden automation is good, but a visible "Needs sync" badge or audit row can look like a failed message if copy is not strict.

Rules:

- normal Messages hides control-plane rows;
- diagnostics show them with control-plane labels;
- status UI never becomes a proof source.

Risk:

`🎯 9   🛡️ 8   🧠 3`, roughly `40-120 LOC`.

---

## 8. Implementation Sequence

### Cut 1 - Documentation And UI Copy

Safe first commit.

Tasks:

1. Add this plan.
2. Add `workIntervals` invariant tests if missing.
3. Rename visible label to `In progress time`.
4. Update renderer tests.

Commit:

```text
docs: plan opencode delivery hardening phases
```

or if UI copy included:

```text
fix(team): clarify task in-progress duration label
```

### Cut 2 - OpenCode Transcript Session Lookup

Medium-risk, mostly read-only behavior.

Tasks:

1. Add orchestrator CLI `--session-id` with strict team/member/lane validation.
2. Add orchestrator tests for exact session hit, team/member mismatch, lane mismatch, and missing session.
3. Extend `ClaudeMultimodelBridgeService.getOpenCodeTranscript` with optional `sessionId`.
4. Add bridge tests that verify CLI args and temp output cleanup.
5. Fix `OpenCodeTaskLogStreamSource` attributed path cache/group keys to include session before adding new evidence.
6. Add tests for two sessions owned by the same member.
7. Add `TaskLogOpenCodeSessionEvidenceSource` as a narrow ledger-to-candidate adapter.
8. Query bounded exact session candidates in `OpenCodeTaskLogStreamSource`.
9. Add diagnostics and fixture tests.
10. Update OpenCode fallback segment IDs to include session identity.
11. Add `BoardTaskLogStreamService` merge/cache tests so exact-session fallback is not dropped by segment dedupe or stale layout cache.
12. Add session-aware projected-message dedupe tests using `sessionId + uuid/sourceToolUseID`.
13. Add a regression where an unrelated primary `execution` record does not suppress exact OpenCode fallback.
14. Emit narrow `task-log-change` signals when exact OpenCode session evidence starts referencing a task.
15. Add renderer tests that opened stream and badge count reload from that signal without a full team-data refresh.

Commit:

```text
fix(team): load opencode task logs from delivery session evidence
```

### Cut 3 - Acceptance/Observation Split

High-risk, needs focused tests.

Tasks:

1. First fix OpenCode turn-settled observer blockers from Section 4.8.
2. Add runtime prompt identity fields to orchestrator send response and command outcome.
3. Add ledger optional runtime prompt identity fields and migration-safe parsing.
4. Add exact observe fields to OpenCode bridge contract and adapter, but keep observed behavior unchanged.
5. Update watchdog observe calls to pass exact session/prompt identity when present.
6. Add tests proving exact observe reads the accepted session even after lane/session changes.
7. Add `settlementMode: "acceptance"` path with default still `observed`.
8. Keep pre-prompt MCP/session repair synchronous.
9. Return accepted after `prompt_async` only in acceptance mode.
10. Update `OpenCodeReadinessBridge` timeout recovery to preserve accepted runtime prompt identity.
11. Update ledger states and watchdog handling without releasing the active slot on acceptance alone.
12. Add idempotency and queued-behind tests.
13. Preserve proof context (`messageKind`, `taskRefs`, `relayOfMessageId`, `actionMode`, `workSyncIntent`) in ledger/observe paths.
14. Add tests that work-sync proof cannot clear a normal delivery and normal plain-text fallback remains strict.
15. Preserve turn-settled spool schema consumed by member-work-sync normalizer.
16. Verify advisory classification does not surface ordinary post-acceptance observation lag as an error.
17. Freeze/explicitly test canonical `payloadHash` shape before adding accept-fast transport fields.
18. Add schema compatibility tests for old ledger records missing runtime prompt identity fields.
19. Keep `acceptanceUnknown` distinct from accepted unless commandStatus/observe proves exact prompt acceptance.
20. Add message-kind parity tests across shared types, inbox reader, bridge contract, ledger validator, and renderer filters.
21. Add tests that retry control text does not change the app ledger logical payload hash.
22. Ensure retry prompt path runs MCP/session readiness repair before sending any repair control prompt.
23. Tighten taskRefs-only visible reply recovery tests so ambiguous candidates do not commit read/responded.
24. Add work-sync inbox idempotency tests so same messageId with changed payloadHash cannot schedule a stale wake.
25. Add delivery/work-sync separation tests so foreground task assignment delivery does not depend on work-sync phase2 activation.
26. Add relay queue tests proving accepted-pending delivery stops the unread loop and keeps later foreground/work-sync messages queued.
27. Add OpenCode bridge capability detection before enabling acceptance mode, with old-orchestrator fallback tests.
28. Add lane-registry lock failure tests proving accepted exact evidence survives `lanes.json` timeout.
29. Add task-log tests proving exact session evidence does not depend on current lane registry success.
30. Add runtime-delivery inbox dedupe tests proving returned existing messageId is used for proof/advisory clearing.
31. Add `opencodeDeliveryAcceptanceContractVersion` or equivalent explicit bridge contract marker.
32. Persist settlement mode/original bridge request ID on the app delivery ledger before command execution.
33. Add bridge idempotency tests for same logical delivery, changed settlement mode, timeout recovery, and missing echoed idempotencyKey.
34. Add runtime delivery journal tests separating idempotency conflict, destination write failure, and MCP-not-connected failure reasons.
35. Add proof tests showing committed runtime delivery clears prompt advisory only through verified visible correlation.
36. Add proof reader tests for direct user replies stored in `sentMessages.json`, member inbox replies, and cross-team runtime locations.
37. Add regression proving unrelated `lead_process` sent message cannot satisfy OpenCode member proof.
38. Add locked sent-message append/verify tests for concurrent direct OpenCode replies to user.
39. Add trim-boundary tests proving the just-committed runtime delivery proof row is preserved.
40. Add runtime delivery taskRefs schema tests and prompt artifact checks so refs are never silently dropped.
41. Add runtime control lane-resolution tests so secondary member calls never fall back blindly to primary.
42. Add OpenCode inbox relay priority tests so foreground messages beat work-sync nudges and accepted-pending foreground delivery stops the loop.
43. Add busy-status tests proving work-sync scheduling is suppressed by unread/recent foreground messages without changing UI filtering.
44. Add durable automation visibility tests so hidden work-sync/task-stall rows remain readable in diagnostics and delivery paths.
45. Preserve `task_stall_remediation` and future automation message kinds through `TeamInboxReader` or reject unsupported kinds before write.
46. Add OpenCode Changes backfill tests for delivery context hash stability, negative-cache invalidation, and current-contract duplicates-only caching.
47. Add tests proving Task Log Stream native tool rows do not by themselves create reviewable file-change ledger entries.
48. Add manifest recovery tests distinguishing diagnostic-only stores from prompt/runtime delivery ledgers.
49. Add corruption/quarantine tests proving prompt delivery ledger evidence is not silently dropped or rewritten as primary lane.
50. Update artifact/debug checklist so failures include relay priority, hidden automation rows, backfill context hash, and manifest recovery action.
51. Add stopped/tombstoned runtime evidence tests for delivery, task event, heartbeat, bridge result, and relaunch-old-run callbacks.
52. Add stale-runtime post-stop tests proving no sent message, inbox row, task attribution, advisory clear, or task-log refresh is written.
53. Add cache/advisory invalidation tests for direct user reply, member inbox reply, hidden automation row, and task event.
54. Add renderer event fanout tests proving `lead-message`, `inbox`, `member-advisory`, and `task-log-change` refresh the intended surfaces only.
55. Add conservative rebuild tests proving strict destination proof can clear advisory but cannot invent accepted prompt transport state.
56. Add ambiguous destination rebuild tests so multiple plausible replies remain pending/diagnostic instead of guessed.
57. Add stale-run rebuild tests so destination rows from old runs cannot satisfy current run proof.
58. Add artifact/debug checklist so stale evidence includes team/run/lane/evidenceKind/tombstone reason and cache invalidation result.
59. Add member-work-sync trigger timing tests proving `turn_settled`/`tool_finished` stay fast and startup/member-spawn scans stay readiness-gated.
60. Add work-sync foreground suppression tests proving unread/accepted-pending OpenCode delivery delays generic sync nudges without dropping them.
61. Add scheduled nudge dispatcher recovery tests for due outbox rows after app restart.
62. Add delivery latency timeline builder and tests using existing ledgers/audit journals as sources.
63. Add live/safe E2E diagnostics that print phase timings on slow OpenCode assignment runs.
64. Add member card/status tests where runtime failure/advisory outranks task "working on" while preserving task context.
65. Add transcript-only plain-text fallback tests so `message_send Not connected` does not clear proof or synthesize a reply.
66. Add repair-policy tests that MCP readiness repair precedes retry after tool-error fallback.
67. Add agenda fingerprint stability tests for reorder, generatedAt, presentation-only changes, dependency/review semantics, and future `sourceRevision` behavior.
68. Add report token and pending replay tests proving stale fingerprints/tokens cannot suppress current actionable work.
69. Add runtime turn-settled spool crash-recovery, invalid/quarantine, provider-mismatch, and duplicate-source tests.
70. Add task impact resolver tests for owner, reviewer, lead clarification, broken dependencies, dependent owners, unknown task fallback, and removed members.
71. Add busy signal tests proving active/recent tool activity is time-bounded, resettable, diagnostic, and advisory-only.
72. Add implementation diagnostics so queue fallback, report rejection, busy suppression, and turn-settled resolution are visible in audit/debug artifacts.
73. Add outbox planner/dispatcher tests proving plan-time rows are always revalidated at claim-time before inbox writes.
74. Add sink/outbox payload drift tests so existing messageId cannot mask changed text/taskRefs/messageKind/source.
75. Add targeted recovery tests proving OpenCode and lead bypasses do not become broad non-OpenCode early nudges.
76. Add queue timing tests for default fast triggers, broad quietWindow hazards, follow-up rerun timing, and diagnostics.
77. Add stale status read-refresh tests proving renderer polling coalesces and never writes inbox or prompts directly.
78. Add scheduled dispatcher recovery tests separating fresh assignment wake from periodic due-row recovery.
79. Add slow-start artifact fields for nudge origin: `foreground_delivery`, `event_queue`, `scheduled_dispatcher`, or `manual_refresh`.
80. Add provider-specific turn-settled wiring tests for Claude Stop hook settings, Codex provisioning env, and OpenCode bridge env.
81. Add workspace trust/preflight tests proving `AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT` survives allowed env filtering.
82. Add normalizer strictness tests for provider/source mismatch, duplicate `sourceId`, malformed payload quarantine, and no lead fallback.
83. Add drain scheduler tests for first-run timing, non-overlap, exception recovery, stale processing recovery, and invalid payload quarantine.
84. Add audit journal tests proving append failure and rotation do not affect canonical sync state or dispatch decisions.
85. Add Phase 2 readiness tests for empty, sparse, corrupt, high-nudge, high-churn, and high-rejection metrics.
86. Add member path safety tests proving sync stores use canonical member keys and reject reserved/removed/unsafe identities.
87. Add live artifact fields for provider emitter mode, spool root present/missing, last drain result, last normalizer result, and readiness blocking reasons.
88. Add router detail-shape tests for inbox, lead-message, tool-activity, member-turn-settled, task file paths, malformed JSON, and resolver fallback.
89. Add nudge wake tests proving wake failure is diagnostic/recoverable without turning delivered inbox rows back into retrying duplicates.
90. Add pending report replay tests for bounded transient failures, stale cutoff, deterministic ordering, removed members, and current-agenda validation.
91. Add review-pickup escalation idempotency tests keyed by review request IDs, agenda fingerprint or intent key, and reason class.
92. Add composition lifecycle tests proving dispose clears timers, queue follow-ups, scheduler ticks, and old feature instances.
93. Add agenda source provider-identity merge tests for config/meta precedence, removedAt, provider inference, and unknown-provider direct-delivery gating.
94. Add outbox claim lease tests proving stale claimed rows recover, active claims do not double dispatch, and late old-attempt writes are ignored.
95. Add poison turn-settled payload tests proving repeated processing exceptions quarantine after bounded retries and do not block later files.
96. Add IPC/HTTP boundary tests for member-work-sync status/report validation, source provenance, encoded member names, and no storage writes on invalid input.
97. Add Phase 2 metric provenance tests proving manual/request status reads do not unlock active nudges without queue/runtime observations.
98. Add watchdog cooldown adapter tests for missing, corrupt, expired, unrelated, and matching task journal rows.
99. Add main-process fanout/coalescing tests proving duplicate task/inbox/runtime events converge to one outbox row.
100. Add store repair diagnostics tests proving corrupt member metadata does not delete hidden sync data and valid members still repair.
101. Add user-surface tests proving work-sync automation stays hidden in normal Messages but visible in audit/debug surfaces.

Commit:

```text
fix(opencode): split prompt acceptance from turn observation
```

### Cut 4 - Retry Classification And Live Validation

Only after Cut 3 is stable.

Tasks:

1. Add failure reason taxonomy.
2. Tune retry delays by reason.
3. Add live smoke tests gated by env.
4. Save results under docs or test-results, not tracked fixtures unless sanitized.

Commit:

```text
test(opencode): add delivery acceptance live smoke coverage
```

or:

```text
fix(opencode): classify delivery retry reasons
```

---

## 9. Detailed Risk Register

### Risk 1 - Duplicate OpenCode Prompt

Severity:

`P1`

How it happens:

- app times out before command returns;
- command actually accepted prompt;
- watchdog retries same logical message;
- old prompt and new prompt both produce replies.

Mitigation:

- persist accepted runtime prompt immediately;
- recover via commandStatus before retry;
- never retry same attempt after accepted runtime prompt;
- correlate visible reply by `relayOfMessageId` and `runtimePromptMessageId`.

Tests:

- bridge timeout after accepted prompt recovers accepted outcome;
- retry does not call prompt again for same attempt;
- late visible proof resolves original ledger.

### Risk 2 - False Task Logs From Wrong Session

Severity:

`P1`

How it happens:

- member has multiple OpenCode sessions;
- current lane points to newer idle session;
- task was handled by recreated previous session;
- fallback pulls unrelated current session logs.

Mitigation:

- prefer exact runtimeSessionId from ledger;
- bound by task owner/member and time window;
- use task markers as anchors;
- dedupe and sort;
- keep current fallback only after exact evidence fails.

Tests:

- two session transcripts, only one has task marker;
- wrong member session ignored;
- current lane fallback does not override exact session.

### Risk 3 - Work Sync And Watchdog Double Nudge

Severity:

`P2`

How it happens:

- OpenCode turn-settled enqueues reconcile;
- member-work-sync plans nudge;
- task-stall watchdog also nudges same task/member.

Mitigation:

- keep existing watchdog cooldown port;
- member-work-sync dispatcher revalidates cooldown before delivery;
- watchdog should see recent work-sync nudge and skip if appropriate;
- turn-settled event never sends directly.

Tests:

- recent watchdog alert blocks sync nudge;
- recent sync nudge blocks duplicate sync but not real semantic stall after threshold;
- OpenCode accepted prompt with foreground unread assignment does not create extra sync nudge.

### Risk 4 - UI Shows Warning After Success

Severity:

`P2`

How it happens:

- advisory banner is based on pending/unknown ledger state;
- visible reply arrives;
- banner state is not cleared promptly.

Mitigation:

- clear advisory when ledger gets visible proof or task progress proof;
- treat observation timeout after accepted prompt as developer detail, not user warning, if proof later arrives;
- explicitly invalidate member runtime advisory cache from the proof write path;
- keep the renderer passive: it displays snapshot state but does not decide proof.

Tests:

- cached warning exists, visible reply proof arrives, next snapshot has no warning without waiting for TTL;
- proof for one member does not clear another member's hard runtime warning;
- observation timeout followed by task progress proof does not leave a stale banner;
- renderer state subscribes to proof update;
- pending advisory disappears after visible reply;
- "Saved" appears on separate line as previously requested;
- no warning remains after successful OpenCode reply.

### Risk 5 - Accept-Fast Hides MCP Not Connected

Severity:

`P1`

How it happens:

- prompt accepted but MCP was not actually usable;
- agent attempts `agent-teams_message_send`;
- tool returns `Not connected`;
- app thinks delivery accepted and does not repair.

Mitigation:

- keep pre-prompt `ensureSessionAppMcpReady` synchronous;
- observe tool errors as response proof failure;
- watchdog retry goes through MCP repair gate again;
- do not mark message read until proof.

Tests:

- MCP unavailable before prompt rejects/recreates before acceptance;
- tool error after acceptance keeps ledger pending/failed proof;
- retry re-checks MCP before prompt.

### Risk 6 - Session Observer Hangs Or Burns CPU

Severity:

`P2`

Mitigation:

- bounded timeout;
- abort controller;
- no unbounded SSE reader in Electron main;
- no infinite reconnect loop in v1;
- diagnostics on `stream_unavailable`;
- test premature EOF and timeout.

### Risk 7 - Wrong Proof Clears The Wrong Delivery

Severity:

`P1`

How it happens:

- work-sync nudge produces a valid board-sync report;
- a normal OpenCode delivery for the same member is still pending;
- generic observation logic treats any valid member activity as response proof.

Mitigation:

- keep proof context on the ledger record;
- require message kind/taskRefs/relay correlation before read/responded commit;
- keep final proof decisions in `TeamProvisioningService`;
- test normal delivery and work-sync in the same member/lane.

Tests:

- work-sync report does not mark normal delivery responded;
- normal visible reply does not satisfy a different task's delivery without matching refs;
- plain assistant output after tool error is not accepted unless materialized/semantically sufficient.

### Risk 8 - Fixed OpenCode Logs Still Look Empty Due Cache/Merge

Severity:

`P2`

How it happens:

- exact session evidence becomes available;
- OpenCode source cache key does not include it;
- fallback segment ID collides with an older same-member segment;
- UI still shows empty or only MCP markers.

Mitigation:

- include evidence identity in source cache key;
- include session ID in fallback segment IDs;
- add merge tests at `BoardTaskLogStreamService` level;
- expose developer diagnostics for cache hit/miss reason.

Tests:

- exact session evidence after previous empty cache render produces native tools;
- same member with two sessions keeps distinct safe fallback segments;
- duplicate rows are deduped by source/tool signature, not participant-only segment ID.

### Risk 9 - Too Much Live Test Load

Severity:

`P2`

Mitigation:

- live tests opt-in only;
- cheap models by default;
- no model matrix in this phase;
- cleanup only smoke-owned teams/processes;
- no broad `killall opencode`.

---

## 10. Clean Architecture Placement

### 10.1 `claude_team`

Use feature architecture for new policy/state.

Do not place new business policy in renderer.

Recommended additions:

```text
src/main/services/team/taskLogs/stream/
  TaskLogOpenCodeSessionEvidenceSource.ts

src/main/services/team/opencode/delivery/
  OpenCodeDeliveryFailureReason.ts
  OpenCodeDeliveryProofContext.ts
```

If the acceptance/observation split becomes large, prefer moving new OpenCode delivery use cases into a feature-style structure later:

```text
src/features/opencode-delivery/
  contracts/
  core/domain/
  core/application/
  main/adapters/output/
  main/infrastructure/
```

But for this pass, avoid a broad migration. Keep changes narrow around existing OpenCode delivery services.

Architecture standard mapping:

```text
domain policy:
  proof classification, failure reason taxonomy, session candidate ordering

application service:
  delivery queue ownership, retry/retry-safe decisions, advisory invalidation orchestration

output adapters:
  orchestrator bridge, ledger stores, attribution store, runtime transcript reader

renderer:
  read-only presentation of backend state
```

Do not let a convenience helper cross these boundaries. For example, `TaskLogOpenCodeSessionEvidenceSource` may read ledger/attribution stores and return candidates, but it must not build renderer chunks. `OpenCodeTaskLogStreamSource` may project transcripts into stream segments, but it must not decide whether a delivery is responded/read.

Contract boundary:

- `OpenCodeReadinessBridge` is an output adapter to the orchestrator bridge.
- `OpenCodeTeamRuntimeAdapter` maps app runtime DTOs to bridge command DTOs.
- `TeamProvisioningService` remains the application service that owns delivery queue semantics.
- `OpenCodeDeliveryProofContext` is a small domain/application DTO, not renderer state and not orchestrator policy.
- New evidence readers should be ports/adapters, not helper functions embedded in renderer or task log components.
- `ChangeExtractorService` remains the authority for file-change summaries; Task Log Stream should not mutate or synthesize change ledgers.

SOLID guardrail:

```text
OpenCodeTaskLogStreamSource should not read raw ledger files directly if that makes it both evidence collector and projector.
OpenCodeDeliveryProofContext should describe required proof, but proof decisions stay in one application service.
Task-log projection and file-change extraction change for different reasons and should stay separate.
```

Keep evidence collection behind `TaskLogOpenCodeSessionEvidenceSource` so task-log projection can be tested separately from ledger discovery.

### 10.1.1 Member-Work-Sync Provider Emitter Boundary

The provider-specific "turn settled" emitters are input/infrastructure adapters, not domain policy.

Current boundary should stay:

```text
provider runtime:
  Claude Stop hook, Codex native orchestrator event, OpenCode bridge event

main/infrastructure:
  hook/env installer, spool paths, payload normalizers, runtime event store

core/application:
  ingest normalized RuntimeTurnSettledEvent, enqueue/reconcile member work state

core/domain:
  agenda fingerprint, report validation, readiness, nudge activation policy
```

Rules:

- `ActionableWorkAgenda`, report validation, readiness, and nudge policy must not inspect provider-specific raw payloads;
- provider-specific normalizers convert raw payloads into one shared `RuntimeTurnSettledEvent`;
- adding a future provider should add a normalizer/emitter adapter and tests, not fork member-work-sync core use cases;
- OpenCode-specific remediation remains an output-port behavior at dispatch/targeting time, not a different agenda model;
- provider wiring diagnostics belong in main/infrastructure or artifacts, not renderer state.

### 10.2 `agent_teams_orchestrator`

Provider-specific OpenCode protocol remains here:

```text
src/services/opencode/
  OpenCodeBridgeCommandHandler.ts
  OpenCodeSessionBridge.ts
  OpenCodeTurnSettledObserver.ts
  OpenCodeCommandOutcomeStore.ts
```

The orchestrator may know:

- OpenCode host/session;
- SSE events;
- prompt_async;
- MCP readiness on OpenCode host;
- command outcome storage.

The orchestrator must not know:

- task agenda fingerprint policy;
- whether to nudge a member;
- task-stall semantic policy;
- renderer warning UI behavior.

Contract changes here should be additive:

- add optional fields first;
- keep old callers valid;
- reject contradictory exact identity fields with structured diagnostics;
- preserve schema version compatibility unless a breaking change is unavoidable.

### 10.3 Renderer

Renderer changes should be limited to:

- label copy;
- clearing advisory state when backend says proof arrived;
- optional developer details display;
- keeping member-work-sync nudges hidden from the normal Messages feed by default.

Renderer must not:

- infer OpenCode delivery status from raw transcript;
- run retry policy;
- synthesize task progress.
- show WORK SYNC control messages in the main conversation unless an explicit debug/audit view asks for them.

---

## 11. Verification Matrix

### Unit Tests

`claude_team`:

```bash
pnpm vitest run \
  test/main/services/team/TeamTaskWriter.test.ts \
  test/main/services/team/TeamTaskActivityIntervalService.test.ts \
  test/shared/utils/taskWorkDuration.test.ts
```

```bash
pnpm vitest run \
  test/main/services/runtime/ClaudeMultimodelBridgeService.test.ts \
  test/main/services/team/OpenCodeReadinessBridge.test.ts \
  test/main/services/team/OpenCodeBridgeCommandContract.test.ts \
  test/main/services/team/BoardTaskLogStreamService.test.ts \
  test/main/services/team/OpenCodeTaskLogStreamSource.test.ts \
  test/main/services/team/TaskLogOpenCodeSessionEvidenceSource.test.ts \
  test/main/services/team/OpenCodePromptDeliveryLedger.test.ts \
  test/main/services/team/RuntimeDeliveryService.test.ts \
  test/main/services/team/OpenCodeRuntimeDeliveryAdvisoryPolicy.test.ts \
  test/main/services/team/TeamMemberRuntimeAdvisoryService.test.ts \
  test/main/services/team/ChangeExtractorService.test.ts \
  test/main/services/team/TaskChangeLedgerReader.test.ts \
  test/main/services/team/RuntimeStoreManifest.test.ts \
  test/main/services/team/OpenCodeRuntimeManifestEvidenceReader.test.ts \
  test/main/services/team/RuntimeRunTombstoneStore.test.ts \
  test/main/services/team/OpenCodeRuntimeDeliveryProofReader.test.ts \
  test/main/services/team/TeamMessageFeedService.test.ts \
  test/main/services/team/TeamInboxReader.test.ts
```

Add or extend tests for:

- `OpenCodeRuntimeDeliveryProofReader` if task-progress proof rules need direct coverage;
- app ledger hash vs bridge command hash stability;
- runtime advisory invalidation across `TeamDataService` and `TeamDataWorkerClient`.
- unsafe member-name advisory invalidation falls back to team-scoped invalidation instead of leaving the worker cache stale;
- OpenCode task-log projection dedupes by `sessionId + source id`, not by member name or tool signature alone;
- `BoardTaskLogStreamService.shouldMergeRuntimeFallback()` does not suppress exact OpenCode fallback because of an unrelated execution record.
- exact OpenCode session evidence emits a narrow task-log signal for every affected taskRef;
- `TaskLogStreamSection` and `TaskLogsPanel` reload stream/count from that signal without requiring full team refresh;
- message kind parity across `InboxMessageKind`, `TeamInboxReader`, OpenCode ledger validation, bridge command DTO, and renderer filtering;
- retry control text does not change `hashOpenCodePromptDeliveryPayload()`;
- `message_send` tool-error retry path invokes MCP/session readiness repair before sending another prompt.
- taskRefs-only visible reply recovery does not commit read/responded when multiple plausible candidates exist.
- work-sync inbox nudge sink treats same messageId plus different payloadHash as conflict, or proves outbox rejects it before sink;
- normal task assignment delivery does not wait on member-work-sync phase2 activation or nudge planning.
- OpenCode inbox relay stops after accepted-pending delivery and does not drain later unread messages for the same member.
- OpenCode bridge capability detection falls back safely with an old orchestrator response shape.
- `lanes.json` lock timeout after prompt acceptance does not delete or downgrade exact delivery evidence.
- exact session task-log lookup works when current lane registry points at a newer session.
- runtime-delivery inbox dedupe returns existing messageId and downstream proof/advisory code uses that ID.
- bridge idempotency remains stable for one delivery attempt and timeout recovery requires exact echoed identity.
- runtime delivery journal conflicts are tested separately from MCP readiness failures.
- visible proof reader covers the actual runtime delivery destination stores, including direct user replies in sent messages.
- concurrent direct user reply writes to `sentMessages.json` preserve all committed proof rows.
- runtime delivery taskRefs schema is explicit and invalid shapes cannot be silently dropped.
- unresolved secondary OpenCode runtime control calls fail closed instead of falling back to primary lane.
- OpenCode relay priority keeps foreground inbox messages ahead of `member_work_sync_nudge`.
- hidden automation rows remain durable and available through diagnostics while normal Messages stays clean.
- `task_stall_remediation` and `member_work_sync_nudge` survive inbox reader normalization.
- OpenCode file-change backfill preserves delivery context hash and does not reuse stale negative cache.
- OpenCode metadata-only evidence is rendered as manual review/unavailable, not as no changes.
- runtime store manifest recovery does not drop or downgrade prompt/runtime delivery ledgers.
- stopped/tombstoned OpenCode runtime evidence cannot write sent messages, inbox rows, task attribution, liveness, or advisory-clearing proof.
- stale old-run callbacks after relaunch are diagnostic-only and cannot affect current run UI state.
- direct user reply destination write emits feed refresh and member-advisory invalidation.
- member inbox runtime reply emits inbox refresh and invalidates the owner advisory.
- hidden automation writes remain hidden in normal Messages but still invalidate diagnostic/advisory state.
- conservative ledger rebuild can use strict visible proof but cannot invent prompt acceptance.
- ambiguous or stale-run rebuild candidates remain pending/diagnostic instead of guessed.
- member-work-sync fast triggers remain fast and readiness-gated triggers cannot dispatch during launch bootstrap.
- foreground unread and accepted-pending OpenCode deliveries suppress generic work-sync without dropping outbox recovery.
- latency timeline can identify whether delay came from queue, relay, MCP repair, prompt acceptance, model/tool execution, proof, or task-log projection.
- runtime failure/advisory status outranks task "working on" in member card and hover surfaces.
- transcript-only plain text after `message_send Not connected` remains proof-missing until a real destination write or task progress proof appears.
- agenda fingerprint remains stable across generatedAt, task array order, and presentation-only changes.
- report token and pending replay reject stale fingerprint/token reports without extending old leases.
- runtime turn-settled spool recovers stale processing files and quarantines invalid payloads.
- target resolver rejects provider mismatch, removed member, reserved member, and deleted team.
- task impact resolver keeps owner/reviewer/lead/dependency routing narrow and uses diagnostic team-wide fallback only when uncertain.
- busy signal is bounded, resettable, and cannot block normal foreground delivery.
- outbox dispatch revalidates agenda, lifecycle, activation, busy, rate limit, and watchdog cooldown at claim-time.
- inbox nudge sink is tested behind outbox payloadHash validation and cannot hide payload drift.
- targeted recovery remains OpenCode/lead-specific and does not bypass phase2 for arbitrary providers.
- event queue fast triggers stay fast even when coalescing and scheduler recovery are present.
- stale status reads enqueue coalesced refresh only and never become direct delivery.
- scheduled dispatcher is tested as recovery for due rows, not the fresh assignment wake path.
- Claude Stop hook, Codex provisioning env, and OpenCode bridge env are tested through their real provider wiring paths.
- normalizers reject provider/source drift instead of routing to another provider or defaulting to lead.
- runtime turn-settled drain scheduler recovers from exceptions, stale processing files, and invalid payloads without blocking the app.
- member-work-sync audit journal failures do not alter canonical store, outbox, inbox, or delivery state.
- Phase 2 readiness remains conservative under empty, sparse, corrupt, or truncated metrics.
- member-work-sync paths are derived from canonical member storage, not raw member-name joins.
- router detail parsing covers every current team-change detail shape and malformed detail cannot enqueue the wrong member.
- nudge wake failure is visible and re-wakeable without duplicate inbox rows.
- pending report replay is bounded, ordered, and validates against current agenda every time.
- review-pickup escalation is idempotent for unchanged review request events.
- feature dispose clears timers and prevents stale feature instances from dispatching.
- agenda source provider identity is tested separately from agenda fingerprint stability.
- outbox claimed rows recover after lease expiry and never double-dispatch through old attempts.
- poison runtime turn-settled payloads are quarantined after bounded retries.
- IPC and HTTP member-work-sync requests are runtime-validated and preserve report provenance.
- manual status reads do not train Phase 2 active readiness by themselves.
- watchdog cooldown suppression is task-scoped, bounded, and diagnostic on corrupt journal data.
- duplicate main-process team-change fanout coalesces before outbox writes.
- store repair diagnostics expose corrupt member metadata without deleting hidden sync data.
- user-facing status copy separates control-plane sync from delivery failure.

```bash
pnpm vitest run \
  test/features/member-work-sync/core/ActionableWorkAgenda.test.ts \
  test/features/member-work-sync/core/MemberWorkSyncReportValidator.test.ts \
  test/features/member-work-sync/main/HmacMemberWorkSyncReportTokenAdapter.test.ts \
  test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts \
  test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts \
  test/features/member-work-sync/main/FileRuntimeTurnSettledEventStore.test.ts \
  test/features/member-work-sync/main/TeamRuntimeTurnSettledTargetResolver.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncTaskImpactResolver.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncTeamChangeRouter.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncToolActivityBusySignal.test.ts \
  test/features/member-work-sync/main/TeamInboxMemberWorkSyncNudgeSink.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncNudgeDispatchScheduler.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts \
  test/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.test.ts \
  test/features/member-work-sync/core/application/MemberWorkSyncTargetedRecoveryPolicy.test.ts \
  test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

```bash
pnpm vitest run \
  test/features/member-work-sync/main/MemberWorkSyncEventQueue.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncNudgeDispatchScheduler.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncNudgeDispatcher.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncNudgeOutboxPlanner.test.ts \
  test/shared/utils/teamInternalControlMessages.test.ts \
  test/renderer/utils/teamMessageFiltering.test.ts \
  test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
```

```bash
pnpm vitest run \
  test/features/member-work-sync/main/RuntimeTurnSettledHookSettings.test.ts \
  test/features/member-work-sync/main/CodexNativeTurnSettledPayloadNormalizer.test.ts \
  test/features/member-work-sync/main/OpenCodeTurnSettledPayloadNormalizer.test.ts \
  test/features/member-work-sync/main/RuntimeTurnSettledIngestor.test.ts \
  test/features/member-work-sync/main/FileMemberWorkSyncAuditJournal.test.ts \
  test/features/member-work-sync/core/MemberWorkSyncPhase2Readiness.test.ts \
  test/features/member-work-sync/main/JsonMemberWorkSyncStore.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncTeamChangeRouter.test.ts \
  test/features/member-work-sync/main/MemberWorkSyncTaskImpactResolver.test.ts \
  test/features/member-work-sync/main/adapters/output/TeamTaskAgendaSource.test.ts \
  test/features/member-work-sync/main/registerMemberWorkSyncIpc.test.ts \
  test/features/member-work-sync/main/TeamTaskStallJournalWorkSyncCooldown.test.ts \
  test/features/member-work-sync/renderer/memberWorkSyncStatusViewModel.test.ts \
  test/renderer/api/httpClient.memberWorkSync.test.ts \
  test/preload/electronApiMemberWorkSync.test.ts \
  test/main/services/team/TeamProvisioningServicePrepare.test.ts \
  test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts \
  test/main/services/team/TeamMemberStoragePaths.test.ts
```

`agent_teams_orchestrator`:

```bash
bun test \
  src/services/opencode/OpenCodeBridgeCommandHandler.test.ts \
  src/services/opencode/OpenCodeSessionBridge.test.ts \
  src/services/opencode/OpenCodeTurnSettledObserver.test.ts \
  src/services/opencode/OpenCodeRuntimeTurnSettledEmitter.test.ts \
  src/services/opencode/OpenCodeTurnSettledEmissionCoordinator.test.ts \
  src/services/opencode/OpenCodeCommandOutcomeStore.test.ts
```

### Integration Tests

```bash
pnpm vitest run \
  test/main/services/team/BoardTaskLogStreamIntegration.test.ts \
  test/main/services/team/TeamAgentLaunchMatrix.safe-e2e.test.ts \
  test/renderer/components/team/taskLogs/TaskLogStreamSection.opencode-fixture-e2e.test.tsx \
  test/renderer/components/team/dialogs/TaskDetailDialog.test.tsx \
  test/renderer/store/teamChangeThrottle.test.ts
```

### Typecheck And Build

```bash
pnpm typecheck --pretty false
```

```bash
cd /Users/belief/dev/projects/claude/agent_teams_orchestrator
bun run build
```

### Live E2E

Run only after unit/integration tests are green.

```bash
OPENCODE_E2E=1 \
OPENCODE_DELIVERY_ACCEPT_FAST_LIVE=1 \
pnpm vitest run test/main/services/team/OpenCodeAcceptFastDelivery.live-e2e.test.ts
```

Expected live assertions:

- prompt acceptance timestamp appears before full assistant completion;
- task_start/tool logs are visible by exact session;
- no duplicate logical delivery;
- member-work-sync journal shows reconcile wakeup, not direct spam;
- advisory clears after visible proof.
- work-sync nudge is not visible in normal Messages if filtered by existing UI policy.
- no `Not connected` tool error occurs after pre-prompt MCP-ready gate in the happy path.
- normal delivery proof and work-sync proof do not satisfy each other.
- same-member different-session OpenCode task logs do not collapse into one segment.
- a new OpenCode task assignment is delivered through normal delivery without waiting for member-work-sync phase2 activation.
- live report includes the detected OpenCode bridge capability snapshot.
- if a lane registry diagnostic write fails after acceptance in a fault-injected run, accepted prompt identity remains observable.
- direct OpenCode reply to user appears in Messages and clears advisory through the same proof reader.
- stopping a team before a stale OpenCode callback arrives produces no visible reply and no advisory clear.
- relaunching a team then receiving an old-run callback leaves the new run unaffected.
- advisory/banner disappears after a valid visible reply without requiring a manual full refresh.
- slow-pass report includes phase timings for assignment, inbox, relay, MCP readiness, prompt accepted, first tool, task_start, visible proof, and work-sync decision.
- `message_send Not connected` live/fault-injected run is retried through MCP repair and never marked successful from transcript-only text.

---

## 12. Implementation Checklists By Fragile Area

### 12.1 `workIntervals` Checklist

- no storage migration;
- no provider conditional;
- no change to task create/status interval logic;
- tests assert status-time semantics;
- UI copy is the only user-facing change around this metric.

### 12.2 Task Log Session Evidence Checklist

- exact `sessionId` lookup exists in orchestrator CLI;
- bridge passes `--session-id`;
- task log source uses exact session candidates before current lane fallback;
- cache key includes evidence;
- fallback segment IDs include session identity;
- BoardTaskLogStreamService merge keeps distinct same-member sessions;
- exact-session evidence writes emit narrow task-log refresh events;
- task-log badge count and opened stream reload from the same signal;
- candidate count bounded;
- foreign team/member/task ignored;
- missing exact session is diagnostic, not fatal.

### 12.3 Delivery Acceptance Checklist

- pre-prompt repair remains synchronous;
- active member delivery queue remains serialized;
- outcome store status/rank/safeToRetry updated;
- commandStatus recovery still strict;
- ledger records accepted runtime prompt identity;
- ledger/observation keep proof context (`messageKind`, `taskRefs`, `relayOfMessageId`, `actionMode`);
- commandStatus timeout recovery preserves runtime prompt identity when synthesizing accepted response;
- app ledger payload hash and bridge command payload hash are tested as separate contracts;
- payload hashes are stable across transport-only accept-fast fields and change for real payload changes;
- old ledger schema-1 records missing new prompt identity fields still parse and update safely;
- acceptanceUnknown is not upgraded to accepted without strict acceptance evidence;
- settlement mode is persisted before first send and not recomputed differently during retry;
- original bridge request ID is stored for commandStatus recovery;
- bridge command result echo of `idempotencyKey` is required before state mutation;
- timeout recovery that lacks exact prompt/session identity remains unknown, not accepted;
- observation timeout after acceptance does not immediately duplicate prompt;
- relay loop stops after accepted pending delivery and keeps the same member serialized;
- watchdog proof logic remains authoritative;
- `taskProgressAt` can suppress advisory but cannot bypass normal delivery read-commit policy;
- member-work-sync receives only wakeup signals;
- work-sync proof cannot clear a normal delivery record;
- turn-settled spool payload still normalizes through member-work-sync.

### 12.4 UI Advisory Checklist

- success proof clears warning;
- proof write path invalidates member runtime advisory cache;
- invalidation reaches both in-process `TeamDataService` and `TeamDataWorkerClient`;
- observation timeout after accepted prompt is not shown as error if proof arrives;
- "Saved" remains separate from warning copy if both are visible;
- work-sync automation messages stay hidden from normal Messages if current filtering requires that.

### 12.5 Member-Work-Sync Boundary Checklist

- first assignment wake is normal delivery, not work-sync;
- work-sync reconcile can be triggered by turn-settled/task/inbox events but still goes through activation policy;
- foreground unread assignment suppresses duplicate sync nudge;
- phase2 metrics can block generic sync nudges without blocking normal delivery;
- outbox payloadHash conflict is tested;
- inbox sink either stores/compares payloadHash or proves payload equivalence before returning existing;
- existing nudge wake is not scheduled after payload conflict;
- work-sync audit records conflict/cooldown/suppression reasons for debugging.

### 12.6 Cross-Repo And Lane Registry Checklist

- OpenCode bridge capability is detected before acceptance mode is used;
- delivery acceptance support is represented by explicit contract version, not generic command presence alone;
- missing capability falls back to observed mode with diagnostic, not guessed accept-fast;
- acceptance-mode response without exact runtime prompt identity remains `acceptanceUnknown`;
- old orchestrator response fixtures are covered by tests;
- accepted prompt identity is persisted outside `lanes.json`;
- lane registry read/write failure after acceptance is diagnostic-only for the accepted prompt;
- lane registry failure before first runtime evidence blocks delivery safely;
- no transcript read, task-log attribution write, renderer event emit, or OpenCode network call happens while holding the lane index lock;
- exact session evidence lookup precedes current lane lookup;
- stale lane cleanup cannot delete exact delivery evidence early.

### 12.7 Runtime Delivery Dedupe Checklist

- runtime-delivery dedupe remains scoped to same `relayOfMessageId`;
- deduped inbox write returns the existing `messageId`;
- ledger proof and advisory clearing use the returned message ID;
- dedupe never applies to work-sync, task-stall, or system notification rows;
- identical text without `source="runtime_delivery"` and exact relay proof is not enough;
- taskRef merge after dedupe is tested and does not widen proof semantics.

### 12.8 Runtime Delivery Journal Checklist

- `RuntimeDeliveryService` remains the only path that writes OpenCode runtime `message_send` destinations;
- destination write is verified before journal commit;
- duplicate identical idempotency key returns existing committed location;
- same idempotency key with different payload hash returns conflict;
- conflict is not mapped to MCP not connected;
- committed runtime delivery can feed visible proof correlation but cannot directly mark arbitrary prompt deliveries responded;
- runtime delivery journal reconciliation emits diagnostics only and never re-prompts OpenCode;
- destination change events stay scoped to the actual destination.

### 12.9 Visible Proof Store Parity Checklist

- proof reader scans or resolves every destination kind written by runtime delivery ports;
- direct user replies stored in sent messages can clear advisory through strict proof;
- member inbox replies remain inbox-scoped;
- cross-team replies remain cross-team scoped;
- source string mismatch is diagnostic unless committed runtime delivery location proves the same message;
- unrelated lead/process messages cannot satisfy OpenCode member delivery proof.

### 12.10 Sent Messages Store Checklist

- sent-message append path is locked or otherwise concurrency-safe;
- duplicate destination message ID is detected under lock;
- append verifies the row after write;
- trim keeps the just-written row;
- read normalizer preserves fields needed by runtime proof;
- normal live lead message overlay tests stay green.

### 12.11 Runtime TaskRefs Contract Checklist

- MCP prompt/tool schema and app normalizer agree on taskRefs shape;
- invalid taskRefs fail loudly or are preserved through a documented normalizer;
- string refs have defined taskId/displayId semantics;
- structured refs hash deterministically if supported;
- proof reader and task-log evidence use the same normalized refs;
- prompt artifact tests assert the documented schema.

### 12.12 Runtime Control Lane Resolution Checklist

- non-lead secondary member control calls require member-owned lane or exact session evidence;
- true primary OpenCode runtime remains supported;
- message delivery, task event, and heartbeat share the same fail-closed resolver;
- stale launch-state and missing lane registry are covered by tests;
- rejection diagnostics include enough member/run/session context for artifact debugging;
- no destination write happens before lane/evidence validation.

### 12.13 OpenCode Inbox Relay Priority Checklist

- priority sort direction is documented in code and tests;
- normal foreground unread rows sort before `member_work_sync_nudge`;
- system notifications do not accidentally outrank user/task foreground rows;
- accepted-pending foreground delivery leaves later rows unread and queued;
- `onlyMessageId` is treated as a controlled exact override, not broad scheduling;
- busy-status diagnostics include active message kind and message id;
- work-sync scheduler tests assert it backs off when foreground work is unread or recent.

### 12.14 Automation Hiding Checklist

- hidden automation rows are not deleted or marked read by UI filtering;
- raw inbox diagnostics can show hidden automation rows;
- `TeamInboxReader` preserves all supported `InboxMessageKind` values;
- `TeamMessageFeedService` and renderer filtering have separate tests;
- delivery, watchdog, prompt ledger rebuild, and work-sync never use UI-filtered messages as source of truth;
- normal Messages and counts hide work-sync by default;
- debug/audit views can opt into automation rows without changing durable state.

### 12.15 OpenCode File-Change Backfill Checklist

- delivery context file/hash contains the exact fields backfill needs;
- retry-control text does not change delivery context hash;
- negative backfill cache is invalidated when delivery context appears;
- current-contract duplicates-only evidence is cacheable and old-contract duplicates-only evidence is not;
- metadata-only OpenCode evidence remains manual-review/unavailable;
- task-log native tool projection cannot synthesize reviewable file-change ledger entries;
- summary-only requests wait for bounded backfill when delivery context exists;
- backfill diagnostics include task/member/session/lane/context hash.

### 12.16 Runtime Store Recovery Checklist

- runtime diagnostics store can be dropped without touching delivery evidence;
- prompt delivery ledger and runtime delivery journal are quarantined/rebuilt, not silently deleted;
- canonical destination writes win over provider session rebuild data;
- readiness-blocking launch store corruption blocks new delivery but keeps existing evidence available for proof/debug;
- secondary lane recovery never writes evidence into primary lane;
- artifact packs include manifest recovery action, source, and quarantine path;
- recovery tests cover corrupted ledger, stale provider session, and existing committed destination row.

### 12.17 Stopped Runtime Evidence Checklist

- every OpenCode runtime write path calls the same fail-closed evidence gate before writing;
- evidence gate receives teamName, runId, laneId, and evidenceKind;
- stopped pure team rejects runtime delivery before sent-message/inbox write;
- stopped mixed secondary lane rejects task event and heartbeat before attribution/liveness write;
- stale old-run callback after relaunch cannot clear current warning or mark current delivery responded;
- tombstone rejection is recorded as stale evidence with reason, not provider error;
- stop/relaunch cleanup preserves ledgers/artifacts needed for debugging;
- orphaned stale OpenCode process cleanup remains team/run/lane scoped.

### 12.18 Cache And Advisory Invalidation Checklist

- direct user reply emits `lead-message` refresh and member-advisory invalidation;
- member inbox reply emits `inbox` refresh and member-advisory invalidation;
- task event/attribution emits narrow `task-log-change`;
- hidden automation write invalidates diagnostics/advisory where needed without showing normal Messages rows;
- unsafe member name falls back to team-scoped advisory invalidation;
- worker unavailable/invalidation failure is diagnostic-only after durable write;
- tests assert both durable store state and renderer refresh behavior.

### 12.19 Conservative Ledger Rebuild Checklist

- visible proof rebuild requires strict relay/source/destination evidence;
- prompt transport acceptance rebuild requires exact runtime prompt identity or command outcome proof;
- ambiguous candidates remain pending/diagnostic;
- hidden automation rows only rebuild automation-intent deliveries;
- stale run rows cannot rebuild current run state;
- rebuild preserves messageKind, source, relayOfMessageId, taskRefs, destination kind, and destination message ID;
- rebuild never marks inbox read or mutates user-visible rows.

### 12.20 Member-Work-Sync Timing Checklist

- trigger-specific defaults are documented in tests;
- broad `queueQuietWindowMs` cannot silently delay `turn_settled` and `tool_finished` production paths;
- startup/member-spawn scans can materialize status without dispatching nudges before launch readiness;
- `canDispatchNudges` is checked before dispatch and again effectively through revalidation;
- foreground unread delivery and accepted-pending OpenCode delivery suppress generic work-sync;
- scheduled dispatcher recovers due outbox rows after restart but is not the primary fresh-assignment path;
- queue diagnostics expose trigger reasons, runAt, maxRunAt, queued age, running age, and rerunRequested.

### 12.21 Delivery Latency Timeline Checklist

- timeline is derived from existing ledgers/audit journals where possible;
- every phase uses shared correlation IDs instead of text matching;
- missing phases are explicit diagnostics, not silent gaps;
- slow pass report distinguishes queue delay, relay busy wait, MCP repair, prompt acceptance, model/tool execution, proof wait, task-log projection, and work-sync decision;
- timeline rows are developer/audit diagnostics, not normal Messages rows;
- live E2E prints timeline on failure or threshold breach.

### 12.22 Member Status Presentation Checklist

- runtime failure/advisory/bootstrap state has higher priority than task labels;
- task assignment remains visible as context, not liveness proof;
- `registered_only` and runtime-process-without-bootstrap are not shown as online/working;
- stale spawn-status fetch after stopped/offline is ignored;
- hover/detail separates task, runtime diagnostic, lane/session, and worktree facts;
- tests cover failed OpenCode secondary with assigned task.

### 12.23 Tool-Error Plain Text Fallback Checklist

- transcript-only assistant text after `message_send` failure is not visible proof;
- MCP/session readiness repair runs before retry prompt;
- task/file progress can be shown separately from reply delivery proof;
- app never synthesizes user-visible reply from transcript-only text;
- idempotency conflict, destination write failure, MCP not connected, and missing tool stay distinct;
- later real runtime destination write clears advisory through normal proof reader.

### 12.24 Agenda Fingerprint Stability Checklist

- fingerprint payload contains only actionable work semantics;
- `generatedAt`, UI row order, unread counts, duration labels, and cache revisions are excluded;
- item order is canonical and independent from task array order;
- evidence arrays are sorted before hashing;
- dependency/review/owner/status changes intentionally change fingerprint;
- unrelated task changes for other members do not change this member fingerprint unless they affect dependencies, review, or lead clarification;
- any future `sourceRevision` addition includes a written semantic contract and regression tests.

### 12.25 Report Token And Replay Checklist

- token binds teamName, memberName, agendaFingerprint, and expiry;
- reporter always reloads current agenda before validation;
- `caught_up` requires current empty agenda;
- `still_working` and `blocked` require current fingerprint;
- `blocked` requires current blocker evidence;
- pending replay goes through the same reporter/validator as live reports;
- stale/expired/foreign reports are diagnostic-only and cannot extend leases or clear `needs_sync`;
- member inactive/team inactive replay is marked superseded rather than accepted.

### 12.26 Runtime Turn-Settled Spool Checklist

- incoming event files are not claimable until fully written;
- claim path moves incoming files to processing before reading;
- stale processing recovery is bounded and ignores `.meta.json`;
- invalid/oversized/unsupported-provider files go to invalid with reason;
- non-terminal OpenCode outcomes are processed as ignored and do not enqueue reconcile;
- provider-owned events require explicit team/member and configured provider match;
- Claude transcript/session matching rejects wrong provider, deleted team, removed member, and reserved member;
- duplicate source events are harmless at queue/outbox level.

### 12.27 Task Impact Routing Checklist

- owner changes enqueue only active owner unless fallback is required;
- review changes enqueue current-cycle reviewer and lead for self-review/missing reviewer;
- lead clarification and broken dependencies enqueue lead;
- dependent task owners are enqueued when their blocker changes;
- unknown/missing task ID fallback is diagnostic and still passes through readiness/cooldown;
- file-path detail parsing accepts only task JSON names, not arbitrary paths;
- resolver failure falls back to team scan instead of dropping the event.

### 12.28 Busy Signal Checklist

- busy signal is advisory-only and cannot block normal foreground delivery;
- active tool state can be cleared by finish, reset, offline, or bounded stale cleanup;
- recent-finish grace is short and tested;
- busy-signal errors return bounded retryAfter and diagnostics;
- reset can clear one member or whole team;
- future persisted busy state must be team/run/member scoped and TTL-bound.

### 12.29 Nudge Outbox Revalidation Checklist

- planner writes durable intent only after current status and activation checks;
- dispatcher reloads current agenda before inbox write;
- dispatcher supersedes stale fingerprint or empty agenda;
- dispatcher re-checks lifecycle, phase2 activation, rate limit, busy signal, and watchdog cooldown;
- retryable failures include bounded `nextAttemptAt`;
- terminal failures are not revived without new fingerprint or supported intent key;
- review-pickup delivery is tracked by reviewRequestEventId, not only agenda fingerprint.

### 12.30 Inbox Nudge Sink Checklist

- production calls sink only through outbox dispatcher;
- outbox payloadHash conflict blocks sink call;
- existing messageId path is safe only for already validated payload equivalence;
- writer-returned messageId is recorded consistently;
- hidden automation row stays durable and debug-readable;
- future direct sink reuse must add payloadHash or messageKind/source/taskRefs validation.

### 12.31 Targeted Recovery Checklist

- OpenCode targeted recovery requires providerId `opencode`;
- lead targeted recovery requires canonical lead-like member identity;
- Codex/Anthropic/Gemini secondary agents stay behind phase2 readiness unless strict review pickup;
- strict review pickup requires reviewRequestEventId and non-ambiguous evidence;
- targeted recovery still goes through dispatch-time lifecycle, busy, cooldown, rate limit, and inbox checks;
- tests cover both activation policy and dispatcher behavior.

### 12.32 Queue And Scheduler Timing Checklist

- default trigger timings remain documented by tests;
- `turn_settled` and `tool_finished` remain fast;
- broad `queueQuietWindowMs` is not used to tune production fast triggers without explicit triggerTiming;
- coalescing preserves earlier/urgent runAt;
- running-item follow-up keeps urgent reasons and schedules quickly;
- scheduled dispatcher recovers due outbox rows and does not replace fresh assignment delivery;
- diagnostics expose nudge origin and queue timing.

### 12.33 Stale Status Read Refresh Checklist

- stale read enqueues reconcile only;
- repeated reads coalesce while queued or running;
- stale read cannot write inbox, call OpenCode, or dispatch a nudge directly;
- inactive/stopped team remains inactive after refresh;
- diagnostics separate stale refresh enqueue from actual nudge delivery;
- renderer polling is not required for correctness.

### 12.34 Runtime Turn-Settled Provider Wiring Checklist

- Claude Stop hook settings are tested independently from Codex/OpenCode env wiring;
- Codex primary and secondary teammate provisioning include the spool env;
- OpenCode desktop bridge and live harness include the spool env;
- workspace trust/preflight does not strip the spool env;
- missing env degrades to no turn-settled event, not launch or delivery failure;
- diagnostics identify provider, install mode, and spool root presence.

### 12.35 Normalizer Strictness Checklist

- provider and source strings are explicit contract fields;
- source mismatch for a claimed provider fails closed;
- unsupported providers do not fall back to `lead` or any configured member;
- duplicate logical event produces stable `sourceId`;
- different session/turn/runtime prompt identity produces distinct `sourceId`;
- invalid payloads are quarantined and do not enqueue reconcile.

### 12.36 Runtime Turn-Settled Drain Scheduler Checklist

- first drain runs promptly after composition;
- scheduler runs are non-overlapping;
- exceptions log warning and do not stop future ticks;
- claim/read batches are bounded;
- stale processing files are recovered or quarantined;
- drain only ingests/enqueues and never writes inbox nudges directly.

### 12.37 Audit Journal Checklist

- audit append failure is warning-only;
- audit rotation/truncation does not alter canonical sync state;
- audit entries are never parsed as proof;
- artifact packs may include audit snippets as diagnostics only;
- audit payloads are sanitized and bounded;
- no full prompt, auth value, API key, or unbounded transcript is written.

### 12.38 Phase 2 Metrics Checklist

- empty metrics remain collecting/not-ready;
- sparse metrics cannot enable active nudges;
- corrupt or truncated metric data is conservative;
- high nudge rate, fingerprint churn, or report rejection blocks readiness;
- readiness reasons are user/debug explainable;
- audit journal rotation does not affect metrics readiness.

### 12.39 Member Work Sync Path Safety Checklist

- per-member sync files use `MemberWorkSyncStorePaths`;
- raw `memberName` is not joined into filesystem paths;
- canonical key and display name are separated;
- reserved identities cannot create teammate sync stores;
- removed member storage is diagnostic-only unless the member is active again by canonical identity;
- path uncertainty fails closed before nudge dispatch.

### 12.40 Team Change Router Detail Checklist

- every emitted `TeamChangeEvent.detail` shape has a router test;
- malformed JSON detail never throws;
- unknown inbox recipient cannot create a member directory;
- durable task changes fallback safely when exact task impact cannot be resolved;
- materializer failure for one member does not block queueing other members;
- team-wide fallback remains diagnostic and downstream-gated.

### 12.41 Nudge Delivery Wake Checklist

- inbox insert remains the durable generic nudge boundary;
- wake failure after insert records diagnostic/audit data;
- wake failure does not mark delivered outbox rows retryable by default;
- safe re-wake path does not duplicate inbox rows;
- existing-nudge wake still respects foreground, busy, cooldown, and provider delivery gates;
- latency timeline shows whether delay happened before or after durable inbox insert.

### 12.42 Pending Report Replay Checklist

- replay uses current agenda and current token validation;
- accepted/rejected/superseded outcomes are marked processed;
- transient reporter failures are bounded and diagnosable;
- removed member and inactive team intents are superseded;
- replay has deterministic order and per-run limits;
- replay summary distinguishes processed from still-pending transient failures.

### 12.43 Review Pickup Escalation Checklist

- escalation key includes review request IDs and reason class;
- same unchanged review request escalates once;
- new review request event can escalate again;
- generic agenda sync cannot use review-pickup bypass;
- delivery failure chooses retry or escalation for one attempt, not both;
- delivered review-pickup event IDs suppress duplicate direct nudges.

### 12.44 Feature Composition Lifecycle Checklist

- composition owns every scheduler, queue, and runtime-drain timer;
- dispose is idempotent;
- dispose prevents queued follow-up work after in-flight reconcile completes;
- stale feature instance cannot receive or dispatch new events;
- live tests dispose feature before deleting temp teams;
- feature recreation does not reuse stale busy signal or queue state.

### 12.45 Agenda Source Runtime Identity Checklist

- config/member-meta merge precedence is documented and tested;
- meta `removedAt` removes a member from active sync;
- provider id affects provider-specific dispatch but not agenda fingerprint by default;
- unknown provider fails closed for provider-specific direct delivery;
- provider inference from model is diagnostic when it affects behavior;
- lead-like and reserved identities cannot become secondary sync targets.

### 12.46 Outbox Claim Lease Checklist

- claimed outbox rows have an explicit stale threshold;
- stale claimed rows recover under the same locks as normal claim;
- old attemptGeneration writes are ignored after recovery;
- terminal rows are never revived;
- recovery path is idempotent across app restart.

### 12.47 Poison Turn-Settled Payload Checklist

- unexpected processing failures increment durable retry metadata;
- repeated failures quarantine with a stable reason;
- poison payload does not block other payloads in the batch;
- invalid and ignored outcomes remain separate in summaries;
- diagnostics include provider/source identity when available.

### 12.48 IPC And HTTP Boundary Checklist

- IPC handlers validate request shape at runtime;
- HTTP routes and IPC normalize team/member/report fields consistently;
- report source provenance is not overwritten incorrectly;
- invalid input cannot create status, pending report, outbox, or member storage files;
- browser-mode client route mapping has parity tests with Electron bridge behavior.

### 12.49 Phase 2 Metric Provenance Checklist

- manual/request status reads do not satisfy active readiness thresholds alone;
- queue/runtime/team-change reconciles are the primary readiness signal;
- UI refresh writes no outbox rows directly;
- readiness diagnostics include event provenance counts;
- evaluatedAt churn alone cannot unlock nudges.

### 12.50 Watchdog Cooldown Checklist

- missing stall journal does not suppress sync;
- corrupt or unreadable journal suppression is visible and bounded;
- cooldown is scoped to overlapping task IDs;
- expired alerts do not suppress;
- retry after cooldown remains idempotent.

### 12.51 Main-Process Fanout Checklist

- team-change fanout is treated as at-least-once;
- duplicate events coalesce before outbox planning;
- trigger reasons are diagnostic and do not churn fingerprints;
- event fanout never dispatches inbox nudges directly;
- disposed features ignore late fanout safely.

### 12.52 Store Repair Diagnostics Checklist

- corrupt member meta during repair is diagnostic;
- repair never deletes member feature data because discovery failed;
- valid members still repair when one member dir is malformed;
- legacy fallback does not create unsafe raw member dirs;
- repair output is deterministic.

### 12.53 User Status Surface Checklist

- normal Messages hides work-sync automation by default;
- activity/debug views label work-sync rows as control-plane automation;
- member status copy does not imply user-message delivery failure;
- diagnostics expose fingerprint/token/outbox state without secrets;
- rendering a status panel cannot trigger dispatch.

---

## 13. Rollback Strategy

Phase 1 rollback:

- revert copy/tests only.

Phase 2 rollback:

- remove session-id lookup;
- keep old lane/current fallback;
- no data migration needed.

Phase 3 rollback:

- default `settlementMode` back to `observed`;
- keep acceptance fields in ledger as ignored optional data;
- no task data migration.

Phase 4 rollback:

- restore previous retry delays/reason mapping.

Never rollback by deleting ledgers, outcome stores, runtime session stores, or task JSON.

---

## 14. Definition Of Done

This hardening is complete when:

- `workIntervals` remain unchanged and tested as status-time.
- UI label no longer implies active execution.
- OpenCode task logs can load from exact runtime session evidence.
- OpenCode delivery acceptance no longer waits for full turn completion in the app-facing path.
- Accepted prompts are never duplicated by one attempt.
- Watchdog and member-work-sync remain separated.
- Successful OpenCode replies clear warnings.
- Accept-fast is gated by explicit orchestrator capability.
- Lane registry failures do not erase accepted exact prompt/session evidence.
- Runtime-delivery dedupe returns existing message IDs without weakening proof rules.
- Runtime `message_send` idempotency conflicts remain separate from MCP readiness repair.
- Proof reader sees the same destination stores that runtime delivery writes.
- Direct user sent-message writes are concurrency-safe before they are used as proof.
- Runtime delivery taskRefs are preserved or rejected explicitly.
- Secondary OpenCode runtime control calls cannot write under the wrong lane.
- Foreground OpenCode inbox rows cannot be delayed behind hidden work-sync automation.
- Work-sync/task-stall automation is hidden from normal Messages without losing durable diagnostics or delivery state.
- OpenCode Changes backfill remains driven by task-change ledger evidence, not task-log native rows.
- Runtime store recovery cannot silently drop or downgrade prompt/runtime delivery ledgers.
- Stopped/tombstoned OpenCode runtime callbacks cannot write visible state or clear current-run advisories.
- Destination writes reliably invalidate message feed, task-log, and member-advisory caches without making cache refresh a correctness dependency.
- Ledger rebuild is conservative: strict proof can clear warnings, but missing prompt identity cannot be upgraded to accepted transport.
- Member-work-sync fast triggers remain low-latency while launch/startup scans stay readiness-gated.
- A delivery latency timeline can explain slow OpenCode starts without conflating queue, relay, MCP, model, proof, and UI cache delays.
- Member status surfaces cannot show a failed/unbootstrapped OpenCode teammate as simply "working on".
- Transcript-only plain text after OpenCode tool error cannot clear delivery proof or synthesize a user-visible reply.
- Agenda fingerprints do not churn on presentation-only changes, and reports/tokens are accepted only for the current fingerprint.
- Runtime turn-settled events survive app restarts, route only to the configured active member/provider, and duplicate safely.
- Task impact routing is narrow for known task changes and diagnostic/rate-limited for team-wide fallback.
- Busy signal remains bounded advisory state and cannot suppress foreground delivery or nudges indefinitely.
- Nudge outbox dispatch revalidates current agenda and safety gates immediately before inbox write.
- Inbox nudge idempotency cannot hide changed payload, message kind, source, or task refs.
- Targeted recovery remains provider-specific and does not become a global phase2 bypass.
- Queue fast triggers, stale-read refresh, and scheduler recovery are separated and explainable in diagnostics.
- Runtime turn-settled install paths are tested per provider: Claude Stop hook, Codex provisioning env, and OpenCode bridge env.
- Runtime turn-settled normalizers reject provider/source drift and cannot route malformed events to the wrong member.
- Runtime turn-settled drain is non-blocking, recovers after failure, and never writes inbox nudges directly.
- Member-work-sync audit journal is diagnostic-only and cannot change canonical sync or delivery state.
- Phase 2 readiness remains conservative under empty, sparse, corrupt, or truncated metrics.
- Member-work-sync per-member storage uses canonical member paths and rejects unsafe/reserved identities before dispatch.
- Team-change routing cannot silently drop current event detail shapes or enqueue unsafe/raw member names.
- Nudge wake failures are visible and recoverable without duplicating durable inbox rows.
- Pending report replay is bounded, current-agenda validated, and cannot loop stale intents forever.
- Review-pickup escalation is idempotent for unchanged review request events.
- Feature composition owns and disposes all work-sync timers, queues, and drain schedulers.
- Provider/runtime identity merge rules are tested separately from agenda fingerprint semantics.
- Claimed outbox rows recover after crash without duplicate dispatch.
- Poison runtime turn-settled payloads quarantine after bounded retries.
- IPC/HTTP adapters validate requests and preserve report provenance.
- Phase 2 readiness cannot be trained by manual status reads alone.
- Watchdog cooldown failures are bounded, task-scoped, and visible.
- Duplicate main-process events coalesce before dispatch.
- Store repair never deletes hidden sync data because member metadata is malformed.
- User status surfaces separate control-plane sync from agent/message failure.
- Live smoke proves a task assignment reaches OpenCode, starts work, produces task logs, and settles member-work-sync without duplicate nudges.

---

## 15. Practical Expected Impact

Phase 1:

- no speed change;
- less user confusion.

Phase 2:

- task logs should appear correctly even after OpenCode session recreate;
- debugging delayed starts becomes much clearer.

Phase 3:

- normal ready-session OpenCode assignment should be accepted in roughly `1-5s`;
- stale/MCP repair path should no longer wait for full model completion before app acceptance;
- observed start may still depend on model/provider latency, but app state will distinguish "accepted and running" from "not accepted".

Phase 4:

- fewer false retries;
- fewer confusing warnings;
- better separation between provider errors, MCP errors, and slow model turns.

---

## 16. Final Recommendation

Proceed in order:

1. Keep `workIntervals` unchanged.
2. Make the UI label honest.
3. Fix OpenCode task logs by exact session evidence.
4. Split OpenCode delivery acceptance from turn observation.
5. Tune retries only after acceptance/observation is covered by tests.

Do not jump straight to Phase 3 without Phase 2. Without correct session-based logs, debugging accept-fast behavior will be too ambiguous.
