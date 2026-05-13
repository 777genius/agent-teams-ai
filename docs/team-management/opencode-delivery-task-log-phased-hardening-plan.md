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
  test/main/services/team/OpenCodeRuntimeDeliveryAdvisoryPolicy.test.ts \
  test/main/services/team/TeamMemberRuntimeAdvisoryService.test.ts
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

```bash
pnpm vitest run \
  test/renderer/utils/teamMessageFiltering.test.ts \
  test/features/member-work-sync/main/createMemberWorkSyncFeature.test.ts
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
  test/renderer/components/team/taskLogs/TaskLogStreamSection.opencode-fixture-e2e.test.tsx \
  test/renderer/components/team/dialogs/TaskDetailDialog.test.tsx
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
