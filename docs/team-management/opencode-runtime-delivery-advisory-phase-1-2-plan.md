# OpenCode Runtime Delivery Advisory Policy - Phase 1.2 Plan

## Summary

Implement a shared user-facing advisory policy for OpenCode prompt delivery records.

The delivery ledger must remain strict. `failed_terminal` still means automatic OpenCode delivery attempts are exhausted for that inbox row. The new policy decides whether that fact should be shown to a human or lead process as an immediate error, deferred while proof can still arrive, surfaced later as a soft warning, or suppressed because a later proof already exists.

Recommended scope: 🎯 9   🛡️ 9   🧠 7 - roughly `420-650` changed lines including tests.

Phase 1.2 intentionally does not change the direct send/composer warning contract yet. That is Phase 1.3. This phase fixes the member card, member snapshot advisory, human notification, and lead notice paths.

## Problem

Observed user-visible failure:

1. OpenCode accepts a prompt.
2. The app observes no visible assistant response or no sufficient proof in time.
3. The prompt delivery ledger reaches `failed_terminal` with a generic proof reason such as `empty_assistant_turn`.
4. Member cards show `OpenCode delivery error`.
5. A later `runtime_delivery` reply or task progress proof arrives.
6. The card clears itself.

This is technically consistent with the ledger, but it is wrong UX. A strict ledger fact is being treated as a final user-facing diagnosis too early.

Concrete local evidence showed this shape:

- ledger record: `failed_terminal`, `responseState: "empty_assistant_turn"`, `attempts: 3`, `maxAttempts: 3`
- later inbox reply: `source: "runtime_delivery"`, same `relayOfMessageId`
- result: the UI error was temporary and scary, but the participant was not actually unavailable

## Current Hotspots

Member card advisory source:

- `src/main/services/team/TeamDataService.ts`
- `src/main/services/team/TeamMemberRuntimeAdvisoryService.ts`
- `src/renderer/utils/memberHelpers.ts`

Notification and lead notice source:

- `src/main/services/team/TeamProvisioningService.ts`
  - `logOpenCodePromptDeliveryEvent`
  - `shouldSurfaceOpenCodeRuntimeDeliveryAdvisory`
  - `shouldNotifyOpenCodeRuntimeDeliveryBeforeTerminal`
  - `fireOpenCodeRuntimeDeliveryErrorNotification`
  - `notifyLeadAboutOpenCodeRuntimeDeliveryError`

Existing reason helpers:

- `src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryDiagnostics.ts`
- `src/main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy.ts`

Existing proof lookup is embedded in:

- `TeamMemberRuntimeAdvisoryService.readVisibleOpenCodeRuntimeDeliveryReplyTimes`
- `TeamMemberRuntimeAdvisoryService.readTaskProgressProofTimes`
- `TeamMemberRuntimeAdvisoryService.hasSupersedingProofForOpenCodeDeliveryRecord`

## Core Design

Separate three concepts:

1. **Ledger fact**
   The durable state of OpenCode prompt delivery. Example: `failed_terminal`.

2. **Proof snapshot**
   Whether a later visible reply, task progress, or newer success supersedes the failure.

3. **User impact**
   Whether the app should suppress, defer, warn, or error.

4. **Side-effect eligibility**
   Whether a surfaced impact should emit a member refresh, desktop notification, or lead notice for this particular event.

This follows SRP:

- ledger store owns durable delivery facts;
- proof reader owns reading canonical proof sources;
- policy owns user-facing classification;
- provisioning service owns event-specific side effects such as notifications and team-change events;
- renderer only displays the already-classified advisory.

Critical constraint: user impact is not the same thing as notification eligibility. Phase 1.2 must not accidentally broaden notification scope. A hard advisory can be appropriate for a member card while still not producing a desktop notification for event types that never notified before.

## New Module

Add:

```txt
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryAdvisoryPolicy.ts
```

Keep this module pure:

- no filesystem reads;
- no inbox/task readers;
- no `TeamProvisioningService` import;
- no `TeamMemberRuntimeAdvisoryService` import;
- deterministic output from `record`, `proof`, and `nowMs`.

This prevents circular dependencies and keeps the policy easy to unit test.

Recommended exported types:

```ts
import type { MemberRuntimeAdvisory } from '@shared/types';
import type { OpenCodePromptDeliveryLedgerRecord } from './OpenCodePromptDeliveryLedger';

export type OpenCodeRuntimeDeliveryAdvisoryAction = 'suppress' | 'defer' | 'surface';

export type OpenCodeRuntimeDeliveryAdvisorySeverity = 'warning' | 'error';

export interface OpenCodeRuntimeDeliveryProofSnapshot {
  latestSuccessAt: number | null;
  visibleReplyAt: number | null;
  taskProgressAt: number | null;
}

export interface OpenCodeRuntimeDeliveryAdvisoryDecision {
  action: OpenCodeRuntimeDeliveryAdvisoryAction;
  reason:
    | 'no_reason'
    | 'responded'
    | 'newer_success'
    | 'visible_reply_proof'
    | 'task_progress_proof'
    | 'hard_error'
    | 'proof_pending'
    | 'proof_missing_confirmed'
    | 'not_user_visible';
  severity?: OpenCodeRuntimeDeliveryAdvisorySeverity;
  reasonCode?: MemberRuntimeAdvisory['reasonCode'];
  message?: string;
  observedAt?: string;
  nextReviewAt?: string;
}

export interface OpenCodeRuntimeDeliveryAdvisoryPolicyInput {
  record: OpenCodePromptDeliveryLedgerRecord;
  proof: OpenCodeRuntimeDeliveryProofSnapshot;
  nowMs: number;
  graceMs?: number;
}

export interface OpenCodeRuntimeDeliveryEventSideEffectDecision {
  emitMemberAdvisoryRefresh: boolean;
  scheduleReviewAt?: string;
  notifyHuman: boolean;
  notifyLead: boolean;
}
```

Recommended default grace:

```ts
export const OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS = 120_000;
```

Why `120_000`:

- real observed late proof arrived roughly 40 seconds after `failed_terminal`;
- current advisory cache TTL is 30 seconds, so less than that can still flicker;
- 2 minutes is long enough to absorb OpenCode transcript/materialization lag without hiding real stale state for too long.

## Policy Rules

### Suppress

Return `suppress` when:

- selected reason is null;
- record is `responded`;
- latest success is newer than the candidate error;
- visible runtime reply proof is correlated and timestamp-eligible for the original prompt;
- task progress proof matches `taskRefs`, member actor/author, and original prompt time.

Code sketch:

```ts
export function decideOpenCodeRuntimeDeliveryAdvisory(
  input: OpenCodeRuntimeDeliveryAdvisoryPolicyInput
): OpenCodeRuntimeDeliveryAdvisoryDecision {
  const recordTimeMs = getOpenCodeRuntimeDeliveryRecordTimeMs(input.record);
  const reason = selectOpenCodeRuntimeDeliveryReason(input.record);

  if (!reason) {
    return suppress('no_reason');
  }
  if (input.record.status === 'responded') {
    return suppress('responded');
  }
  if (input.proof.latestSuccessAt != null && input.proof.latestSuccessAt > recordTimeMs) {
    return suppress('newer_success');
  }
  if (input.proof.visibleReplyAt != null && input.proof.visibleReplyAt > recordTimeMs) {
    return suppress('visible_reply_proof');
  }
  if (input.proof.taskProgressAt != null && input.proof.taskProgressAt > recordTimeMs) {
    return suppress('task_progress_proof');
  }

  // Continue with hard/generic classification.
}
```

### Surface immediate error

Return `surface/error` immediately for hard errors.

Hard errors include:

- auth and login problems;
- quota/credits/capacity;
- provider or bridge unavailable;
- permission blocked when action is required;
- payload mismatch;
- attachment payload unavailable or unsupported;
- project/runtime identity unavailable;
- terminal session/runtime errors with specific non-generic diagnostics.

For non-terminal records, keep current intent but narrow the scary path:

- non-terminal `session_error`, `tool_error`, `permission_blocked`, or `reconcile_failed` with action-required/hard reason can surface immediately;
- non-terminal generic retryable states should not create a member card error while retries or observe-later work can still run;
- non-terminal generic states should be handled by the delivery watchdog/direct-send pending UX, not by the member card.

Use existing `selectOpenCodeRuntimeDeliveryReason()` and `isActionRequiredOpenCodeRuntimeDeliveryReason()` first. Add a policy-local hard token set for app/runtime errors that are not provider API text.

Example hard token set:

```ts
const HARD_RUNTIME_DELIVERY_REASON_TOKENS = [
  'auth_unavailable',
  'authentication_failed',
  'invalid api key',
  'insufficient credits',
  'quota exceeded',
  'key limit exceeded',
  'opencode_prompt_delivery_payload_mismatch',
  'opencode_inbox_attachment_payload_unavailable',
  'opencode_inbox_attachment_payload_read_failed',
  'opencode_attachment_delivery_prepare_failed',
  'opencode_runtime_message_bridge_unavailable',
  'opencode_project_path_unavailable',
];
```

Do not classify generic proof states as hard only because the ledger is terminal.

Do not notify for recipient-shape or removed-member cases by default:

- `recipient_is_not_opencode`
- `recipient_removed`
- removed member filtered out by config/meta

Those are routing/config facts, not evidence that a live OpenCode participant is broken. They may be useful diagnostics in logs, but they should not produce the scary OpenCode runtime delivery notification path.

### Defer generic proof failures

Return `defer` when:

- record is `failed_terminal`;
- reason is generic proof missing;
- no proof supersedes it;
- `nowMs < failedAt + graceMs`.

Generic proof states include:

- `empty_assistant_turn`
- `prompt_delivered_no_assistant_message`
- `visible_reply_still_required`
- `visible_reply_ack_only_still_requires_answer`
- `plain_text_ack_only_still_requires_answer`
- `visible_reply_destination_not_found_yet`
- `visible_reply_missing_relayOfMessageId`
- `visible_reply_missing_relayofmessageid`
- `visible_reply_missing_task_refs`
- `visible_reply_missing_task_refs_after_merge`
- `visible_reply_task_refs_merge_failed`
- `non_visible_tool_without_task_progress`

Do not match only raw ledger tokens. `selectOpenCodeRuntimeDeliveryReason()` often returns readable fallback copy, for example `OpenCode returned an empty assistant turn.`. Add a helper that recognizes both raw and formatted reasons:

```ts
export function isOpenCodeRuntimeDeliveryProofOnlyReason(input: {
  record: OpenCodePromptDeliveryLedgerRecord;
  selectedReason: string;
}): boolean {
  const candidates = [
    input.record.responseState,
    input.record.lastReason,
    ...input.record.diagnostics,
    input.selectedReason,
  ]
    .map((value) => value?.trim().toLowerCase())
    .filter((value): value is string => Boolean(value));

  return candidates.some((value) =>
    OPEN_CODE_PROOF_ONLY_REASON_TOKENS.some((token) => value.includes(token))
  );
}

// Keep these lower-case because candidates are normalized with toLowerCase().
const OPEN_CODE_PROOF_ONLY_REASON_TOKENS = [
  'empty_assistant_turn',
  'opencode returned an empty assistant turn',
  'prompt_delivered_no_assistant_message',
  'opencode accepted the prompt, but no assistant turn was recorded',
  'visible_reply_still_required',
  'opencode responded, but did not create a visible message_send reply',
  'visible_reply_ack_only_still_requires_answer',
  'plain_text_ack_only_still_requires_answer',
  'visible_reply_destination_not_found_yet',
  'visible_reply_missing_relayofmessageid',
  'without the required relayofmessageid correlation',
  'visible_reply_missing_task_refs',
  'visible_reply_missing_task_refs_after_merge',
  'visible_reply_task_refs_merge_failed',
  'opencode created a reply without the required taskrefs metadata',
  'non_visible_tool_without_task_progress',
  'opencode used tools, but did not create a visible reply or task progress proof',
];
```

This helper is the reason `empty_assistant_turn` becomes `protocol_proof_missing` after grace instead of falling through to `backend_error`.

Code sketch:

```ts
if (isGenericOpenCodeRuntimeDeliveryProofFailure(input.record, reason)) {
  const terminalAt = getOpenCodeRuntimeDeliveryTerminalTimeMs(input.record);
  const nextReviewMs = terminalAt + (input.graceMs ?? OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS);
  if (input.nowMs < nextReviewMs) {
    return {
      action: 'defer',
      reason: 'proof_pending',
      observedAt: new Date(terminalAt).toISOString(),
      nextReviewAt: new Date(nextReviewMs).toISOString(),
    };
  }

  return {
    action: 'surface',
    reason: 'proof_missing_confirmed',
    severity: 'warning',
    reasonCode: 'protocol_proof_missing',
    message: reason,
    observedAt: new Date(terminalAt).toISOString(),
  };
}
```

### Surface confirmed soft warning

After grace expires with no proof, return `surface/warning` with:

- `reasonCode: 'protocol_proof_missing'`

Rationale:

- the member card and hover/detail surfaces can show a warning;
- human desktop notification is too noisy for a proof-only problem;
- lead notice can disturb the team and cause unnecessary human-facing messages;
- task-stall monitoring should handle real work inactivity.

If a product decision later wants lead notice for confirmed proof gaps, add a new soft notice path with different copy. Do not reuse `Treat @member as unavailable`.

### Surface immediate hard error

For hard errors:

```ts
return {
  action: 'surface',
  reason: 'hard_error',
  severity: 'error',
  reasonCode: classifyOpenCodeRuntimeDeliveryReasonCode(reason),
  message: reason,
  observedAt: new Date(recordTimeMs).toISOString(),
};
```

Notification eligibility is decided later from the event and the impact.

## Proof Reader Extraction

Extract the proof lookup out of `TeamMemberRuntimeAdvisoryService` into a reusable helper:

```txt
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofReader.ts
```

Also extract pure matching helpers from `TeamProvisioningService` before building the reader:

```txt
src/main/services/team/opencode/delivery/OpenCodeRuntimeDeliveryProofMatching.ts
```

Move or wrap the non-mutating parts of:

- `isOpenCodeRecoveredVisibleReplyCandidate`
- `isOpenCodeVisibleReplyTimestampEligible`
- `getOpenCodeVisibleReplyInboxCandidates`
- `openCodeTaskRefsIncludeAll`
- `normalizeOpenCodeTaskRefsForComparison`
- `openCodeTaskRefKey`

Then update `TeamProvisioningService` to call those shared helpers. Do this before changing advisory behavior so existing delivery recovery tests prove the extraction did not change semantics.

Recommended public surface:

```ts
export interface OpenCodeRuntimeDeliveryProofReaderInput {
  teamName: string;
  activeMemberKeys: ReadonlySet<string>;
  recordsByMember: ReadonlyMap<string, readonly OpenCodePromptDeliveryLedgerRecord[]>;
}

export interface OpenCodeRuntimeDeliveryProofIndex {
  // Raw batched reads, not final proof decisions.
  inboxMessagesByInbox: ReadonlyMap<string, readonly InboxMessage[]>;
  taskProgressTimes: ReadonlyMap<string, number>;
  configuredLeadName: string | null;
}

export interface OpenCodeRuntimeDeliveryRecordProofSnapshot
  extends OpenCodeRuntimeDeliveryProofSnapshot {
  recordId: string;
  visibleReplyCorrelation: OpenCodeDeliveryVisibleReplyCorrelation | null;
  visibleReplyMessageId: string | null;
  visibleReplyInbox: string | null;
  proofDiagnostics: string[];
}

export class OpenCodeRuntimeDeliveryProofReader {
  async readProofIndex(
    input: OpenCodeRuntimeDeliveryProofReaderInput
  ): Promise<OpenCodeRuntimeDeliveryProofIndex> {
    // Batch-read candidate inboxes and tasks once per team snapshot/status read.
  }

  getProofSnapshot(input: {
    memberName: string;
    record: OpenCodePromptDeliveryLedgerRecord;
    latestSuccessAt: number | null;
    proofIndex: OpenCodeRuntimeDeliveryProofIndex;
  }): OpenCodeRuntimeDeliveryRecordProofSnapshot {
    // Evaluate record-specific visible reply, task progress, and ledger proof.
  }
}
```

Do not reduce visible proof to only `Map<member+relayOfMessageId, timestamp>`. That shape cannot represent recovery by observed message id, recovery by `taskRefs`, lead-recipient fallback candidates, or existing `plain_assistant_text` ledger proof. The reader should batch I/O, but proof decisions must stay record-specific.

Use dependency injection/ports so this helper does not import `TeamProvisioningService`:

```ts
export interface OpenCodeRuntimeDeliveryProofReaderPorts {
  inboxReader: Pick<TeamInboxReader, 'getMessagesFor' | 'listInboxNames'>;
  taskReader: Pick<TeamTaskReader, 'getTasks'>;
  configReader: { readConfig(teamName: string): Promise<TeamConfig | null> };
}
```

This keeps dependencies one-way:

```txt
TeamProvisioningService -> ProofMatching / ProofReader
TeamMemberRuntimeAdvisoryService -> ProofReader
ProofReader -> ports/readers
```

Do not let `ProofReader` import `TeamProvisioningService`; that would create the wrong ownership boundary and make tests brittle.

Keep proof strict:

- no time-window heuristic message matching;
- no summary matching;
- no passive user reply summary;
- no cross-lane proof;
- no proof from another member;
- no proof from a task without matching `taskRefs`.

The existing `relayOfMessageId` and task progress checks are the right base shape, but do not only move the current `TeamMemberRuntimeAdvisoryService.readVisibleOpenCodeRuntimeDeliveryReplyTimes()` as-is. That code is narrower than the delivery recovery logic in `TeamProvisioningService`.

The proof reader must mirror the read-only parts of these current provisioning paths:

- `findOpenCodeVisibleReplyByRelayOfMessageId`
- `findOpenCodeVisibleReplyByObservedMessageId`
- `findOpenCodeVisibleReplyByTaskRefs`
- `isOpenCodeRecoveredVisibleReplyCandidate`
- `isOpenCodeVisibleReplyTimestampEligible`
- `openCodeTaskRefsIncludeAll`

It should recognize all existing visible proof correlations:

- `relayOfMessageId`
- `direct_child_message_send`
- `plain_assistant_text`

Do not call mutating repair/materialization helpers from snapshot advisory reads:

- no `correlateRuntimeDeliveryReply`
- no taskRef merge writes
- no plain-text visible reply materialization
- no ledger mutation from `getMemberAdvisories()`

If proof needs mutation to become durable, that belongs to the delivery/observe path. The advisory proof reader is read-only and should only suppress when proof is already visible in inbox/task/ledger state.

Timestamp rule:

- visible reply proof should use the existing `isOpenCodeVisibleReplyTimestampEligible` semantics, not `reply.timestamp > failedAt`;
- task progress proof should compare against the original prompt/inbox time, not terminal `failedAt`, because the terminal row can be written after the teammate already produced task progress and the app observed it late;
- use a small skew tolerance for visible replies, matching the existing `message.timestamp + 5s >= inboxTimestamp` behavior;
- never accept proof older than the prompt/inbox time unless it is explicitly correlated by the ledger's existing `visibleReplyMessageId`.

This prevents false warnings when a reply/progress existed for the prompt but the terminal failure row was written slightly later.

Performance constraints:

- `TeamDataService` gives member runtime advisory loading only `250ms` per snapshot.
- The proof reader must support batched member reads, as the current service does.
- Do not call the proof reader from the delivery hot path.
- For single-record status reads in Phase 1.3, wrap proof reads with a small budget and fall back to fact-only impact if the budget is exceeded.

## Integration - Member Advisory

Current `buildOpenCodeDeliveryAdvisoryFromRecords()` should become policy-driven.

Pseudo-flow:

```ts
private buildOpenCodeDeliveryAdvisoryFromRecords(
  memberName: string,
  records: readonly OpenCodePromptDeliveryLedgerRecord[],
  now: number,
  proofIndex: OpenCodeRuntimeDeliveryProofIndex
): MemberRuntimeAdvisory | null {
  const ordered = orderRecords(records);
  const latestSuccessAt = getLatestSuccessAt(ordered);
  const latestCandidate = findLatestPotentialError(ordered, now);
  if (!latestCandidate) return null;

  const proof = this.proofReader.getProofSnapshot({
    memberName,
    record: latestCandidate,
    latestSuccessAt,
    proofIndex,
  });

  const decision = decideOpenCodeRuntimeDeliveryAdvisory({
    record: latestCandidate,
    proof,
    nowMs: now,
  });

  if (decision.action !== 'surface') {
    return null;
  }

  return {
    kind: 'api_error',
    observedAt: decision.observedAt ?? new Date(now).toISOString(),
    reasonCode: decision.reasonCode,
    message: decision.message,
  };
}
```

Important: `defer` returns `null` for member card. The card should not show a temporary "checking" badge from Phase 1.2, because this is a teammate card, not a direct send composer.

## Integration - Notifications And Lead Notice

Replace the current boolean logic in `TeamProvisioningService` with two decisions:

1. a cheap delivery-event impact decision that does not scan inboxes/tasks;
2. a side-effect decision that preserves current notification scope.

Current risky behavior:

```ts
const shouldNotifyTerminalFailure =
  event === 'opencode_prompt_delivery_terminal_failure' && record.status === 'failed_terminal';

if (shouldNotifyTerminalFailure || shouldNotifyActionRequiredRetry) {
  void this.fireOpenCodeRuntimeDeliveryErrorNotification(record);
  return;
}
```

Do not call the full proof reader from this hot path. `logOpenCodePromptDeliveryEvent()` can run inside relay/watchdog delivery flow, and proof reads may scan inboxes and tasks. The hot path only needs to know:

- no selected reason -> no side effects;
- hard/action-required reason -> keep existing immediate notification behavior where the event is already notification-eligible;
- generic proof failure -> schedule delayed proof recheck and do not notify immediately.

Recommended cheap classifier:

```ts
private classifyOpenCodeRuntimeDeliveryEventImpact(
  event: string,
  record: OpenCodePromptDeliveryLedgerRecord
): OpenCodeRuntimeDeliveryAdvisoryDecision {
  const reason = selectOpenCodeRuntimeDeliveryReason(record);
  if (!reason) {
    return { action: 'suppress', reason: 'no_reason' };
  }

  const recordTimeMs = getOpenCodeRuntimeDeliveryRecordTimeMs(record);
  if (isHardOpenCodeRuntimeDeliveryReason(record, reason)) {
    return {
      action: 'surface',
      reason: 'hard_error',
      severity: 'error',
      reasonCode: classifyOpenCodeRuntimeDeliveryReasonCode(reason),
      message: reason,
      observedAt: new Date(recordTimeMs).toISOString(),
    };
  }

  if (record.status === 'failed_terminal' && isGenericOpenCodeRuntimeDeliveryProofFailure(record, reason)) {
    const terminalAt = getOpenCodeRuntimeDeliveryTerminalTimeMs(record);
    return {
      action: 'defer',
      reason: 'proof_pending',
      observedAt: new Date(terminalAt).toISOString(),
      nextReviewAt: new Date(terminalAt + OPENCODE_RUNTIME_DELIVERY_GENERIC_PROOF_GRACE_MS).toISOString(),
    };
  }

  if (isGenericOpenCodeRuntimeDeliveryProofFailure(record, reason)) {
    return { action: 'suppress', reason: 'not_user_visible' };
  }

  if (record.status !== 'failed_terminal') {
    return { action: 'suppress', reason: 'not_user_visible' };
  }

  // Unknown terminal non-generic failures remain visible, but keep this branch narrow
  // and covered by tests so proof-only states cannot fall through here.
  return {
    action: 'surface',
    reason: 'hard_error',
    severity: 'error',
    reasonCode: classifyOpenCodeRuntimeDeliveryReasonCode(reason),
    message: reason,
    observedAt: new Date(recordTimeMs).toISOString(),
  };
}
```

Recommended event side-effect policy:

```ts
private decideOpenCodeRuntimeDeliveryEventSideEffects(input: {
  event: string;
  record: OpenCodePromptDeliveryLedgerRecord;
  impact: OpenCodeRuntimeDeliveryAdvisoryDecision;
}): OpenCodeRuntimeDeliveryEventSideEffectDecision {
  if (input.impact.action === 'suppress') {
    return {
      emitMemberAdvisoryRefresh: false,
      notifyHuman: false,
      notifyLead: false,
    };
  }

  if (input.impact.action === 'defer') {
    return {
      emitMemberAdvisoryRefresh: true,
      scheduleReviewAt: input.impact.nextReviewAt,
      notifyHuman: false,
      notifyLead: false,
    };
  }

  const terminalFailureEvent =
    input.event === 'opencode_prompt_delivery_terminal_failure' &&
    input.record.status === 'failed_terminal';
  const actionRequiredBeforeTerminal =
    input.record.status !== 'failed_terminal' &&
    isActionRequiredOpenCodeRuntimeDeliveryReason(input.impact.message);

  return {
    emitMemberAdvisoryRefresh: true,
    notifyHuman: input.impact.severity === 'error' && (terminalFailureEvent || actionRequiredBeforeTerminal),
    notifyLead: input.impact.severity === 'error' && (terminalFailureEvent || actionRequiredBeforeTerminal),
  };
}
```

This preserves the current notification blast radius. For example, an attachment-payload terminal record can still surface as an advisory/direct-send diagnostic without suddenly generating a new OS notification path unless the event was already notification-eligible.

Important: deferred generic proof failures still emit `member-advisory` refresh. That refresh is needed to clear stale cached hard advisories or cached warnings immediately when the newest record is now `defer/null`. It is a cache/UI refresh only:

- no desktop notification;
- no lead notice;
- do not mark the deferred record as surfaced in the notification/advisory dedupe map;
- do not let this refresh block the delayed post-grace `surface/warning` refresh.

Prefer separate emit helpers:

```ts
private emitOpenCodeRuntimeDeliveryAdvisoryRefreshEvent(record: OpenCodePromptDeliveryLedgerRecord): void {
  // Invalidates card/snapshot caches. Optional short refresh dedupe is ok.
}

private emitOpenCodeRuntimeDeliveryAdvisorySurfaceEvent(record: OpenCodePromptDeliveryLedgerRecord): void {
  // Uses existing surface dedupe and can represent a visible advisory.
}
```

Do not reuse `emitOpenCodeRuntimeDeliveryAdvisorySurfaceEvent()` for `defer`, because the existing dedupe key includes record id/reason and can suppress the later post-grace warning refresh.

New handler:

```ts
private async handleOpenCodeRuntimeDeliveryAdvisorySideEffects(
  event: string,
  record: OpenCodePromptDeliveryLedgerRecord
): Promise<void> {
  const impact = this.classifyOpenCodeRuntimeDeliveryEventImpact(event, record);
  const effects = this.decideOpenCodeRuntimeDeliveryEventSideEffects({ event, record, impact });

  if (effects.scheduleReviewAt) {
    this.scheduleOpenCodeRuntimeDeliveryAdvisoryReview(record, effects.scheduleReviewAt);
  }
  if (effects.emitMemberAdvisoryRefresh) {
    if (impact.action === 'defer') {
      this.emitOpenCodeRuntimeDeliveryAdvisoryRefreshEvent(record);
    } else {
      this.emitOpenCodeRuntimeDeliveryAdvisorySurfaceEvent(record);
    }
  }
  if (effects.notifyHuman || effects.notifyLead) {
    await this.fireOpenCodeRuntimeDeliveryNotificationFromDecision(record, impact, effects);
  }
}
```

`logOpenCodePromptDeliveryEvent()` should call this asynchronously after logging.

Do not block the delivery path on notification writes:

```ts
void this.handleOpenCodeRuntimeDeliveryAdvisorySideEffects(event, record).catch((error) => {
  logger.warn(`[${record.teamName}] Failed to handle OpenCode runtime delivery advisory: ${getErrorMessage(error)}`);
});
```

### Delayed Review Timer

Add a narrow timer map:

```ts
private readonly openCodeRuntimeDeliveryAdvisoryReviewTimers = new Map<string, ReturnType<typeof setTimeout>>();
```

Timer key:

```ts
private getOpenCodeRuntimeDeliveryAdvisoryReviewKey(record: OpenCodePromptDeliveryLedgerRecord): string {
  return `${record.teamName}::${record.laneId}::${record.memberName}::${record.id}`;
}
```

Scheduler:

```ts
private scheduleOpenCodeRuntimeDeliveryAdvisoryReview(
  record: OpenCodePromptDeliveryLedgerRecord,
  nextReviewAt: string | undefined
): void {
  const reviewAtMs = Date.parse(nextReviewAt ?? '');
  if (!Number.isFinite(reviewAtMs)) return;

  const delayMs = Math.max(500, Math.min(reviewAtMs - Date.now(), 180_000));
  const key = this.getOpenCodeRuntimeDeliveryAdvisoryReviewKey(record);
  const existing = this.openCodeRuntimeDeliveryAdvisoryReviewTimers.get(key);
  if (existing) clearTimeout(existing);

  const timer = setTimeout(() => {
    this.openCodeRuntimeDeliveryAdvisoryReviewTimers.delete(key);
    void this.recheckOpenCodeRuntimeDeliveryAdvisory(record).catch((error) => {
      logger.warn(`[${record.teamName}] Delayed OpenCode advisory recheck failed: ${getErrorMessage(error)}`);
    });
  }, delayMs);

  timer.unref?.();
  this.openCodeRuntimeDeliveryAdvisoryReviewTimers.set(key, timer);
}
```

Delayed recheck must re-read current ledger/proof before emitting anything:

```ts
private async recheckOpenCodeRuntimeDeliveryAdvisory(
  original: OpenCodePromptDeliveryLedgerRecord
): Promise<void> {
  const ledger = this.createOpenCodePromptDeliveryLedger(original.teamName, original.laneId);
  const current = (await ledger.list()).find((record) => record.id === original.id);
  if (!current) return;

  const decision = await this.decideOpenCodeRuntimeDeliveryAdvisoryForRecord(current);
  if (decision.action === 'defer') {
    this.scheduleOpenCodeRuntimeDeliveryAdvisoryReview(current, decision.nextReviewAt);
    return;
  }
  if (decision.action === 'suppress') {
    this.emitOpenCodeRuntimeDeliveryAdvisoryRefreshEvent(current);
    return;
  }

  this.emitOpenCodeRuntimeDeliveryAdvisorySurfaceEvent(current);
  // Delayed generic proof warnings do not notify in Phase 1.2.
  // Delayed review is allowed to refresh cards, not to retro-fire desktop
  // notifications or lead notices.
}
```

Delayed review should emit `member-advisory` only. If a re-read somehow discovers a hard diagnostic that was not present in the original generic event, surface it in the snapshot/card and log it, but do not synthesize a new desktop notification or lead notice from the timer. Notification eligibility remains tied to live delivery events.

This timer is an optimization for visible teams. Correctness must not depend on it:

- if the app restarts, `TeamMemberRuntimeAdvisoryService` recomputes by wall clock;
- if the timer never fires, the next team snapshot still surfaces the confirmed warning;
- hard errors still notify immediately.

### Delayed Review Timer Lifecycle

The review timer must follow the same cleanup discipline as `openCodePromptDeliveryWatchdogTimers`.

Add a helper:

```ts
private clearOpenCodeRuntimeDeliveryAdvisoryReviewTimers(teamName?: string): void {
  for (const [key, timer] of this.openCodeRuntimeDeliveryAdvisoryReviewTimers) {
    if (teamName && !key.startsWith(`${teamName}::`)) continue;
    clearTimeout(timer);
    this.openCodeRuntimeDeliveryAdvisoryReviewTimers.delete(key);
  }
}
```

Call it from every path that currently clears per-team prompt delivery watchdog timers:

- `cleanupRun(teamName, ...)` and any team stop/cancel cleanup path;
- permanent team deletion cleanup;
- service shutdown/dispose cleanup;
- launch failure cleanup when a partially started team is abandoned.

The timer callback must also revalidate current ownership before emitting:

```ts
if (!this.teamRunStates.has(original.teamName)) return;
if (!this.isOpenCodeLaneStillCurrent(original.teamName, original.laneId, original.memberName)) return;
```

`isOpenCodeLaneStillCurrent()` must compare more than member name and lane id. Include `record.runId` when it is present, because a lane id can be reused across a respawn while the old ledger record still exists on disk.

Use existing state/config readers for the actual implementation. The point is to prevent a delayed proof-missing advisory from firing after:

- the team was stopped;
- the lane was respawned with a new process;
- the member was removed or renamed;
- a launch failed and cleaned up the run.

Do not persist these timers. After app restart, snapshot reads can show a warning if it is still true, but startup must not retro-fire desktop notifications or lead notices for old generic proof gaps. Live event side effects stay event-driven.

## Notification Copy

Hard error human notification:

```txt
Team <team>: @<member> hit an OpenCode runtime delivery error while handling #<task>. <reason>
```

Hard error lead notice:

```txt
System notice: OpenCode teammate @<member> hit a runtime delivery error while handling #<task>. Reason: <reason>. Treat @<member> as unavailable for that work until retry or restart succeeds. Do not message the human user solely because of this notice unless user action is required.
```

Generic proof warning:

- no human notification in Phase 1.2;
- no lead notice in Phase 1.2;
- member card warning only after grace.

If soft lead notice is added later, use different copy:

```txt
System notice: OpenCode delivery proof is still missing for @<member> while handling #<task>. Do not assume the teammate is unavailable. Check task progress or wait for a correlated reply before escalating.
```

Do not use this copy in Phase 1.2 unless there is a product decision to notify lead for proof gaps.

## Reason Code Mapping

Move or share `classifyRetryReason()` from `TeamMemberRuntimeAdvisoryService`.

Recommended name:

```ts
export function classifyOpenCodeRuntimeDeliveryReasonCode(
  message: string | undefined
): MemberRuntimeAdvisory['reasonCode'];
```

`MemberRuntimeAdvisory['reasonCode']` already includes `protocol_proof_missing`; do not add a duplicate local enum or renderer-only string. The implementation work is to route generic proof failures to that existing reason code after grace.

Do not let fallback `OpenCode returned an empty assistant turn.` classify as `backend_error`. It should classify as `protocol_proof_missing` after grace.

## Edge Cases

### Hard diagnostic mixed with generic state

Example:

```json
{
  "status": "failed_terminal",
  "responseState": "empty_assistant_turn",
  "diagnostics": [
    "Latest assistant message msg_1 failed with APIError - Insufficient credits.",
    "empty_assistant_turn"
  ]
}
```

Expected:

- immediate `surface/error`;
- `reasonCode: "quota_exhausted"`;
- human notification yes;
- lead notice yes;
- no grace.

### Late visible reply after terminal

Expected:

- before grace expires: `defer`;
- after reply appears: `suppress`;
- member card never shows error;
- delayed recheck emits `member-advisory` refresh to clear stale cached values if needed.

### Visible reply recovered by observed message id or task refs

Expected:

- suppress when an existing visible reply is recovered by `visibleReplyMessageId`;
- suppress when an existing visible reply is recovered by matching `taskRefs` and semantic sufficiency;
- support `direct_child_message_send` correlation;
- do not require `source: "runtime_delivery"` when the current recovery logic accepts a missing source;
- do not mutate inbox messages from the advisory snapshot path.

### Plain text reply already materialized

Expected:

- if the ledger already has `visibleReplyCorrelation: "plain_assistant_text"` and a visible reply id/inbox, suppress;
- if plain text could be materialized but has not been materialized yet, do not write from the advisory path;
- direct-send/status path may still use the delivery observer to materialize later.

### Late task progress after terminal

Expected:

- suppress only if task id matches record `taskRefs`;
- author/actor matches member;
- progress timestamp is after the original prompt/inbox time;
- no cross-task suppression.

### Newer success after older failure

Expected:

- suppress older failure if newer terminal success exists for same member/lane;
- this prevents a historical failed row from dominating a recovered member card.

### No proof after grace

Expected:

- `surface/warning`;
- `reasonCode: "protocol_proof_missing"`;
- label should render as `OpenCode proof missing`;
- no desktop notification;
- no hard lead notice.

### Removed member or stopped lane

Expected:

- removed members are already filtered by caller;
- stopped lane should not be scanned for fresh advisories;
- do not revive old stopped-lane errors on active team cards.

### Payload mismatch and attachment payload unavailable

Expected:

- immediate hard error;
- not delayed as generic proof;
- these are app/runtime data consistency problems, not late-proof problems.

### Permission blocked

Expected:

- if action required, immediate hard warning/error path;
- do not retry automatically while blocked;
- do not classify as proof pending.

### Cache behavior

Current advisory cache TTL is 30 seconds.

Required behavior:

- deferred generic proof returns `null`;
- defer event emits `member-advisory` refresh immediately to clear stale cached hard/warning advisories;
- cache may store null for up to TTL after that refresh;
- delayed `member-advisory` event at grace expiry invalidates cache;
- runtime reply event already invalidates cache through `emitRuntimeDeliveryReplyAdvisoryRefresh`.

### Worker cache invalidation

This is critical.

`team:getData` normally prefers `team-data-worker`. The worker owns a separate `TeamDataService` instance, and that instance owns a separate `TeamMemberRuntimeAdvisoryService` with its own 30 second member/batch advisory cache. Invalidating only the main-thread advisory service is not enough.

Add a worker request:

```ts
export interface InvalidateMemberRuntimeAdvisoryPayload {
  teamName: string;
  memberName?: string;
}

export type TeamDataWorkerRequest =
  | { id: string; op: 'invalidateMemberRuntimeAdvisory'; payload: InvalidateMemberRuntimeAdvisoryPayload }
  // existing variants
```

Worker handling:

```ts
case 'invalidateMemberRuntimeAdvisory': {
  if (msg.payload.memberName) {
    teamDataService.invalidateMemberRuntimeAdvisory(msg.payload.teamName, msg.payload.memberName);
  } else {
    teamDataService.invalidateTeamRuntimeAdvisories(msg.payload.teamName);
  }
  respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
  break;
}
```

Add public invalidators:

```ts
// TeamDataService
invalidateMemberRuntimeAdvisory(teamName: string, memberName: string): void {
  this.memberRuntimeAdvisoryService.invalidateMemberAdvisory(teamName, memberName);
}

invalidateTeamRuntimeAdvisories(teamName: string): void {
  this.memberRuntimeAdvisoryService.invalidateTeamAdvisories(teamName);
}

// TeamMemberRuntimeAdvisoryService
invalidateTeamAdvisories(teamName: string): void {
  // clear member cache entries, batch cache, in-flight batch requests, and bump generation
}
```

Then update the existing main invalidator wiring:

```ts
teamProvisioningService.setMemberRuntimeAdvisoryInvalidator((teamName, memberName) => {
  teamMemberRuntimeAdvisoryService.invalidateMemberAdvisory(teamName, memberName);
  getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(teamName, memberName);
});
```

Also update the `member-advisory` team-change forwarding path to invalidate the worker cache when the event was not emitted through `TeamProvisioningService` in the current process.

Without this, the renderer can receive a `member-advisory` refresh event, call `team:getData`, hit the worker, and still see a stale cached `null` or stale advisory for up to 30 seconds.

`TeamDataWorkerClient.invalidateMemberRuntimeAdvisory()` must also clear in-flight `getTeamData` requests for the team:

```ts
invalidateMemberRuntimeAdvisory(teamName: string, memberName?: string): void {
  if (!SAFE_NAME_RE.test(teamName)) return;
  this.clearTeamDataInFlightForTeam(teamName);
  this.postBestEffort('invalidateMemberRuntimeAdvisory', { teamName, memberName });
}
```

`postBestEffort()` currently returns immediately when the worker has not been created. That is acceptable for advisory invalidation because an uncreated worker has no worker-side advisory cache yet. The main-thread invalidation still must happen first, and `clearTeamDataInFlightForTeam(teamName)` still matters because main may be holding a worker-backed promise that was started before the invalidation event.

Also update `summarizeWorkerRequest()` so diagnostics and logs do not show the new operation as an unknown worker request:

```ts
case 'invalidateMemberRuntimeAdvisory':
  return {
    teamName: request.payload.teamName,
    memberName: request.payload.memberName,
  };
```

When `forwardTeamChange` handles config/meta changes, clear runtime advisories in both main and worker services. Team config changes can change the member roster, provider, model, cwd, lane metadata, or removed status, and a cached advisory from the previous shape should not survive a config invalidation.

Main thread:

```ts
if (
  event.type === 'config' &&
  (event.detail === 'config.json' ||
    event.detail === 'team.meta.json' ||
    event.detail === 'members.meta.json')
) {
  teamMemberRuntimeAdvisoryService.invalidateTeamAdvisories(event.teamName);
  getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
}
```

Do not call both `teamMemberRuntimeAdvisoryService.invalidateTeamAdvisories()` and `teamDataService.invalidateTeamRuntimeAdvisories()` in the current main wiring if they point at the same service instance. Pick one path to avoid double generation bumps in tests. The public `TeamDataService` invalidator still exists for worker and future encapsulated callers.

Worker:

```ts
case 'invalidateTeamConfig': {
  teamConfigReader.invalidateTeam(msg.payload.teamName);
  teamDataService.invalidateMessageFeed(msg.payload.teamName);
  teamDataService.invalidateTeamRuntimeAdvisories(msg.payload.teamName);
  respond({ id: msg.id, ok: true, result: null, diag: buildDiag() });
  break;
}
```

For `member-advisory` events in `forwardTeamChange`, invalidate before sending the renderer event. The renderer often responds to `member-advisory` by immediately calling `team:getData`; if the event is sent first, the refresh can race and read stale worker cache.

`TeamChangeEvent` currently has `type`, `teamName`, and optional string `detail`, but no structured `memberName`. Do not parse `memberName` from colon-delimited `detail`; member names are not a stable serialization format. In this forwarding path, clear the whole team's advisory cache:

```ts
if (event.type === 'member-advisory') {
  teamMemberRuntimeAdvisoryService.invalidateTeamAdvisories(event.teamName);
  getTeamDataWorkerClient().invalidateMemberRuntimeAdvisory(event.teamName);
}

safeSendToRenderer(mainWindow, TEAM_CHANGE, event);
httpServer?.broadcast('team-change', event);
```

Keep precise member invalidation in call sites that already have a real `memberName`, such as `setMemberRuntimeAdvisoryInvalidator((teamName, memberName) => ...)`.

Do not widen `TeamProvisioningService.setMemberRuntimeAdvisoryInvalidator()` to accept an optional member name just to support team-wide invalidation. That callback is currently a precise member-level contract. Team-wide invalidation belongs in the main `forwardTeamChange` wiring and in `TeamDataService`/worker invalidators.

This does not cancel a worker request that is already running and already awaited by a renderer refresh. Keep the existing `member-advisory` safety refresh that calls `refreshTeamData(teamName)` without dedup. That second fresh read is the guard that overwrites any stale in-flight snapshot that resolves after the advisory event.

### Dedupe behavior

Existing event dedupe key includes record id and reason key. With policy:

- do not mark deferred records as "sent";
- otherwise delayed surface could be deduped away;
- dedupe notification/advisory "surface" events only after `surface`;
- deferred `member-advisory` refreshes may use a separate short refresh dedupe key, but must not share the surface dedupe key.

## Implementation Steps

1. Add `OpenCodeRuntimeDeliveryAdvisoryPolicy.ts`.
2. Export generic/hard classification helpers from diagnostics or add policy-local helpers.
3. Move reason-code classification into a shared helper.
4. Add `OpenCodeRuntimeDeliveryProofReader.ts` and extract read-only proof matching from both `TeamMemberRuntimeAdvisoryService` and the non-mutating parts of `TeamProvisioningService` visible-reply recovery.
5. Update `TeamMemberRuntimeAdvisoryService` to use proof reader plus policy.
6. Add advisory invalidation methods to `TeamDataService`, `TeamMemberRuntimeAdvisoryService`, `TeamDataWorkerClient`, and `team-data-worker`.
7. Update `TeamProvisioningService.logOpenCodePromptDeliveryEvent()` to use cheap event impact classification and narrow side-effect policy.
8. Add delayed recheck timers in `TeamProvisioningService`.
9. Keep renderer mostly unchanged, except tests may need copy expectations if `protocol_proof_missing` becomes the normal reason code after grace.
10. Add tests.

## Tests

### New policy unit tests

File:

```txt
test/main/services/team/OpenCodeRuntimeDeliveryAdvisoryPolicy.test.ts
test/main/services/team/opencode/OpenCodeRuntimeDeliveryProofMatching.test.ts
test/main/services/team/opencode/OpenCodeRuntimeDeliveryProofReader.test.ts
```

Cases:

```ts
it('defers recent terminal empty assistant proof failures', () => {});
it('surfaces old terminal empty assistant proof failures as protocol warnings', () => {});
it('classifies formatted empty assistant fallback text as protocol proof missing', () => {});
it('surfaces quota diagnostics immediately even when responseState is empty_assistant_turn', () => {});
it('does not surface non-terminal generic proof states as hard errors', () => {});
it('does not let proof-only formatted reasons fall through to unknown hard error', () => {});
it('suppresses when a visible runtime reply is correlated and timestamp-eligible for the prompt', () => {});
it('suppresses when a visible reply is recovered by observed message id', () => {});
it('suppresses when a visible reply is recovered by taskRefs and semantic sufficiency', () => {});
it('suppresses when the ledger already has plain_assistant_text visible reply proof', () => {});
it('does not mutate inboxes or ledgers while reading advisory proof snapshots', () => {});
it('uses prompt inbox time rather than failedAt for late proof timestamp eligibility', () => {});
it('suppresses when task progress proof is newer than the original prompt inbox time', () => {});
it('suppresses when a newer terminal success exists', () => {});
it('treats payload mismatch as immediate hard error', () => {});
```

Add extraction-preservation tests around existing delivery recovery if they are not already covered:

```ts
it('keeps visible reply recovery by observed message id behavior unchanged after helper extraction', async () => {});
it('keeps visible reply recovery by taskRefs behavior unchanged after helper extraction', async () => {});
it('keeps lead-recipient user fallback candidate behavior unchanged after helper extraction', async () => {});
```

### Member advisory service tests

Update:

```txt
test/main/services/team/TeamMemberRuntimeAdvisoryService.test.ts
```

Add/adjust:

```ts
it('does not show a member advisory for recent generic OpenCode proof failure', async () => {});
it('shows protocol proof missing after generic proof failure grace expires', async () => {});
it('keeps hard OpenCode quota advisory immediate inside the grace window', async () => {});
it('does not cache deferred null past a member-advisory recheck event', async () => {});
it('invalidates team batch advisory cache when a single member advisory is invalidated', async () => {});
```

Existing test `classifies terminal OpenCode protocol proof failures as warnings` must be changed to use an old `failedAt`, not `new Date()`.

### Provisioning notification tests

Update:

```txt
test/main/services/team/TeamProvisioningService.test.ts
test/main/services/team/TeamProvisioningServiceRelay.test.ts
```

Add:

```ts
it('does not fire OpenCode runtime notification for recent terminal empty assistant turn', async () => {});
it('does not notify lead for recent terminal generic proof failure', async () => {});
it('emits member-advisory refresh for deferred generic proof failure to clear stale card cache', async () => {});
it('does not mark deferred member-advisory refresh as surfaced for delayed-warning dedupe', async () => {});
it('fires hard OpenCode runtime notification for insufficient credits immediately', async () => {});
it('does not use hard unavailable lead copy for protocol proof missing', async () => {});
it('schedules a member advisory recheck for deferred generic proof failure', async () => {});
it('clears delayed advisory recheck timers when the team run is cleaned up', async () => {});
it('does not emit a delayed advisory for a removed member or replaced lane', async () => {});
it('does not fire desktop or lead notification from delayed advisory recheck', async () => {});
it('does not broaden notification scope for attachment payload terminal records', async () => {});
```

Use fake timers for delayed recheck:

```ts
vi.useFakeTimers();
// terminal generic record at t0
// assert no notification
await vi.advanceTimersByTimeAsync(120_000);
// assert member-advisory event emitted, notification still not emitted
```

### Renderer tests

Most renderer tests should remain unchanged for cards if they already treat `protocol_proof_missing` as warning.

Expected affected tests:

- `test/renderer/utils/memberHelpers.test.ts`
- `test/renderer/components/team/members/MemberCard.test.tsx`
- `test/renderer/components/team/members/MemberHoverCard.test.tsx`
- `test/renderer/components/team/members/MemberDetailHeader.test.tsx`

No Phase 1.2 change should be required for:

- `test/renderer/utils/openCodeRuntimeDeliveryDiagnostics.test.ts`
- `test/renderer/store/teamSlice.test.ts`
- `OpenCodeDeliveryWarning.test.tsx`

Those belong to Phase 1.3.

### Worker invalidation tests

Update or add:

```txt
test/main/services/team/TeamDataWorkerClient.test.ts
test/main/workers/team-data-worker.test.ts
```

Cases:

```ts
it('posts invalidateMemberRuntimeAdvisory to the worker', async () => {});
it('clears worker-side member runtime advisory cache on invalidateMemberRuntimeAdvisory', async () => {});
it('clears main-thread advisory cache during config/team.meta/members.meta forwarding', async () => {});
it('clears worker-side advisory cache during invalidateTeamConfig', async () => {});
it('invalidates worker advisory cache before forwarding member-advisory events to the renderer', async () => {});
it('summarizes invalidateMemberRuntimeAdvisory worker requests in diagnostics', async () => {});
```

If there is no worker harness for this path, cover the public invalidator on `TeamDataService` and `TeamMemberRuntimeAdvisoryService`, then add an integration test around `forwardTeamChange` or the provisioning invalidator wiring.

## Verification

Focused:

```bash
pnpm vitest run test/main/services/team/OpenCodeRuntimeDeliveryAdvisoryPolicy.test.ts
pnpm vitest run test/main/services/team/TeamMemberRuntimeAdvisoryService.test.ts
pnpm vitest run test/main/services/team/TeamProvisioningService.test.ts --testNamePattern "OpenCode runtime"
pnpm vitest run test/main/services/team/TeamProvisioningServiceRelay.test.ts --testNamePattern "OpenCode"
```

Broader:

```bash
pnpm vitest run test/main/services/team/TeamProvisioningService.test.ts
pnpm vitest run test/main/services/team/TeamProvisioningServiceRelay.test.ts
pnpm vitest run test/main/services/team/TeamDataService.test.ts
pnpm vitest run test/renderer/utils/memberHelpers.test.ts
pnpm typecheck --pretty false
git diff --check
```

## Rollout Notes

- Do not change `failed_terminal` semantics.
- Do not mark failed OpenCode inbox rows read.
- Do not synthesize teammate replies.
- Do not treat generic proof failure as participant unavailable.
- Do not add heuristic proof matching by time or summary.
- Keep the policy pure and unit tested.
- Keep notification side effects outside the policy.

## Acceptance Criteria

- A recent `failed_terminal / empty_assistant_turn` record no longer creates a member card error.
- The same record with `Insufficient credits` still creates an immediate error.
- A late `runtime_delivery` reply suppresses the advisory.
- A late same-task progress event suppresses the advisory.
- A generic proof failure older than grace appears as warning `protocol_proof_missing`, not backend error.
- Generic proof failure does not create a desktop notification or hard lead notice.
- Hard OpenCode runtime errors still notify as before.
