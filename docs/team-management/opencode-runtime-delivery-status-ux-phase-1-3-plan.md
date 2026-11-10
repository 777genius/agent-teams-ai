# OpenCode Runtime Delivery User-Visible Status - Phase 1.3 Plan

## Summary

Extend the Phase 1.2 advisory policy into the direct send/composer runtime delivery status path.

Phase 1.2 fixes member cards, snapshots, notifications, and lead notices. Phase 1.3 makes the direct user send UX use the same user-impact classification, so a temporary generic proof gap does not show as `OpenCode runtime delivery failed` while the app is still inside the late-proof window.

Recommended scope: 🎯 8   🛡️ 8   🧠 8 - roughly `650-900` changed lines including tests.

## Why This Is Separate

The direct send path has an existing public-ish shared type:

```ts
SendMessageResult.runtimeDelivery
OpenCodeRuntimeDeliveryStatus
```

Renderer code currently maps:

```ts
runtimeDelivery.delivered === false -> failed warning
runtimeDelivery.responsePending === true -> pending warning
```

Changing `delivered` semantics directly would be risky because it is already used by store actions and tests. Phase 1.3 should add a user-visible impact field while preserving the old ledger fact fields for compatibility.

## Current Direct Send Paths

There are two runtime status entry points:

1. Immediate send result path:

```txt
src/main/ipc/teams.ts
handleSendMessage()
  -> provisioning.relayOpenCodeMemberInboxMessages()
  -> result.runtimeDelivery = relay.lastDelivery
```

2. Later polling path:

```txt
src/main/services/team/TeamProvisioningService.ts
getOpenCodeRuntimeDeliveryStatus()
  -> toOpenCodeRuntimeDeliveryStatus(record)
```

Renderer consumers:

```txt
src/renderer/store/slices/teamSlice.ts
src/renderer/utils/openCodeRuntimeDeliveryDiagnostics.ts
src/renderer/components/team/messages/OpenCodeDeliveryWarning.tsx
src/renderer/components/team/messages/MessageComposer.tsx
src/renderer/components/team/dialogs/SendMessageDialog.tsx
```

Important: both backend paths must use the same user-impact contract. If only polling is fixed, the initial composer warning can still flash the old failure text.

## Shared Type Extension

Extend `SendMessageResult.runtimeDelivery` in `src/shared/types/team.ts`.

Recommended additive fields:

```ts
export type OpenCodeRuntimeDeliveryUserVisibleState =
  | 'none'
  | 'checking'
  | 'warning'
  | 'error';

export interface OpenCodeRuntimeDeliveryUserVisibleImpact {
  state: OpenCodeRuntimeDeliveryUserVisibleState;
  reasonCode?: MemberRuntimeAdvisory['reasonCode'];
  message?: string;
  observedAt?: string;
  nextReviewAt?: string;
}
```

Inside `SendMessageResult.runtimeDelivery`:

```ts
userVisibleImpact?: OpenCodeRuntimeDeliveryUserVisibleImpact;
```

Why a nested object:

- avoids overloading `delivered`;
- keeps old fields readable for debugging;
- allows renderer to prefer the new impact but fall back to old behavior;
- makes Phase 1.3 backwards compatible with older IPC payloads during development.

## State Semantics

### `none`

No user warning should be shown.

Examples:

- successful visible reply proof;
- newer success suppressed older failure;
- late visible reply or task progress proof exists.

### `checking`

The ledger may already say terminal, but the user-facing policy is still in the grace window for generic proof.

Examples:

- recent `failed_terminal / empty_assistant_turn`;
- recent `failed_terminal / prompt_delivered_no_assistant_message`;
- recent `failed_terminal / visible_reply_still_required`;
- UI timeout pending;
- queued behind older OpenCode delivery.

Renderer copy should be non-scary:

```txt
OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.
```

### `warning`

Grace expired and proof is still missing, but this is not a hard provider/runtime error.

Examples:

- old `failed_terminal / empty_assistant_turn` with no late proof;
- old `failed_terminal / non_visible_tool_without_task_progress` with no same-task progress.

Renderer copy:

```txt
OpenCode reply could not be verified. Message was saved to inbox, but the app did not find a correlated reply or progress proof.
```

If there is a specific message:

```txt
OpenCode reply could not be verified. Message was saved to inbox, but the app did not find a correlated reply or progress proof. Detail: OpenCode returned an empty assistant turn.
```

### `error`

Hard delivery error. This is the old scary warning path and remains valid.

Examples:

- insufficient credits;
- invalid API key;
- runtime bridge unavailable;
- payload mismatch;
- attachment payload unavailable;
- recipient unavailable/removed for the direct send recovery path.

Recipient unavailable/removed should not create a member-card runtime advisory or notification by itself. For direct send UX it can still be an `error` impact so the draft is preserved and the user can choose another recipient.

Renderer copy:

```txt
OpenCode runtime delivery failed. Message was saved to inbox, but live delivery did not complete.
```

## Backend Mapping

Add a converter from Phase 1.2 decision to shared `userVisibleImpact`.

There are two backend mapping modes:

1. **Full status mapping** for explicit status reads and polling. This may read proof sources with a small budget.
2. **Immediate result mapping** for `sendMessage` IPC. This must stay cheap and should not scan tasks/inboxes before returning the send result.

Example:

```ts
function toOpenCodeRuntimeDeliveryUserVisibleImpact(
  decision: OpenCodeRuntimeDeliveryAdvisoryDecision
): OpenCodeRuntimeDeliveryUserVisibleImpact {
  if (decision.action === 'suppress') {
    return { state: 'none' };
  }
  if (decision.action === 'defer') {
    return {
      state: 'checking',
      observedAt: decision.observedAt,
      nextReviewAt: decision.nextReviewAt,
    };
  }
  return {
    state: decision.severity === 'error' ? 'error' : 'warning',
    reasonCode: decision.reasonCode,
    message: decision.message,
    observedAt: decision.observedAt,
  };
}
```

Special immediate statuses that may not have a ledger record:

```ts
function getImmediateOpenCodeRuntimeDeliveryImpact(input: {
  delivered?: boolean;
  responsePending?: boolean;
  reason?: string;
  diagnostics?: string[];
  queuedBehindMessageId?: string;
}): OpenCodeRuntimeDeliveryUserVisibleImpact {
  const observedAt = new Date().toISOString();
  if (input.responsePending === true) {
    return { state: 'checking', observedAt };
  }
  if (input.queuedBehindMessageId) {
    return { state: 'checking', observedAt };
  }
  if (input.reason === 'opencode_runtime_delivery_ui_timeout_pending') {
    return { state: 'checking', observedAt };
  }
  if (input.reason === 'opencode_delivery_response_pending') {
    return { state: 'checking', observedAt };
  }
  if (
    input.reason === 'opencode_runtime_not_active' &&
    (input.diagnostics ?? []).some((line) =>
      line.toLowerCase().includes('will be retried after runtime check-in')
    )
  ) {
    return { state: 'checking', observedAt };
  }
  if (input.delivered === false) {
    return { state: 'error', message: input.reason, observedAt };
  }
  return { state: 'none' };
}
```

Do not use the immediate fallback when a full ledger status read is available. Ledger plus policy is authoritative there.

For immediate `sendMessage` responses, use cheap ledger-fact classification first and leave full proof reconciliation to the later status poll or member-advisory refresh.

## Service Changes

### `TeamProvisioningService.getOpenCodeRuntimeDeliveryStatus`

Current:

```ts
if (record) {
  return this.toOpenCodeRuntimeDeliveryStatus(record);
}
```

Recommended:

```ts
if (record) {
  return await this.toOpenCodeRuntimeDeliveryStatus(record);
}
```

Make `toOpenCodeRuntimeDeliveryStatus` async, or pass in a precomputed impact.

Example:

```ts
private async toOpenCodeRuntimeDeliveryStatus(
  record: OpenCodePromptDeliveryLedgerRecord
): Promise<OpenCodeRuntimeDeliveryStatus> {
  const base = this.toOpenCodeRuntimeDeliveryStatusFacts(record);
  const decision = await this.decideOpenCodeRuntimeDeliveryAdvisoryForRecord(record, {
    proofReadBudgetMs: 750,
  });
  return {
    ...base,
    userVisibleImpact: toOpenCodeRuntimeDeliveryUserVisibleImpact(decision),
  };
}
```

If proof reading exceeds the budget, fall back conservatively:

- hard/action-required reason -> `error`;
- recent generic terminal proof gap -> `checking`;
- old generic terminal proof gap -> `warning`;
- responded or newer success visible in the ledger -> `none`.

Keep fact semantics unchanged:

```ts
const failed = record.status === 'failed_terminal';
return {
  delivered: !failed,
  responsePending: !failed && !responded,
  ledgerStatus: record.status,
  responseState: record.responseState,
  reason: record.lastReason ?? undefined,
  diagnostics: record.diagnostics,
};
```

The renderer should no longer interpret these fact fields directly when `userVisibleImpact` exists.

### Immediate `sendMessage` IPC result

In `src/main/ipc/teams.ts`, after relay:

```ts
result.runtimeDelivery = {
  providerId: 'opencode',
  attempted: true,
  delivered: delivery.delivered,
  responsePending: delivery.responsePending,
  acceptanceUnknown: delivery.acceptanceUnknown,
  responseState: delivery.responseState,
  ledgerStatus: delivery.ledgerStatus,
  visibleReplyMessageId: delivery.visibleReplyMessageId,
  visibleReplyCorrelation: delivery.visibleReplyCorrelation,
  reason: delivery.reason,
  diagnostics: delivery.diagnostics,
};
```

This path should ask provisioning to decorate the delivery with impact, but it should not run the full proof reader. The user is waiting for the send call to return, and the relay path may already have done substantial I/O.

Important timestamp caveat: `OpenCodeMemberInboxDelivery` does not currently carry `failedAt` or `updatedAt`. If immediate classification needs exact grace-age, either:

- read the single ledger record by `ledgerRecordId` and `laneId` without scanning inboxes/tasks; or
- conservatively classify generic terminal proof failures as `checking` and let `getOpenCodeRuntimeDeliveryStatus()` correct the state on the next poll.

Prefer the conservative fallback unless a single-record ledger read is already cheap in the call site.

Recommended helper:

```ts
async getOpenCodeRuntimeDeliveryImpactForResult(input: {
  teamName: string;
  delivery: OpenCodeMemberInboxDelivery;
}): Promise<OpenCodeRuntimeDeliveryUserVisibleImpact>
```

Implementation:

```ts
async getOpenCodeRuntimeDeliveryImpactForResult(input: {
  teamName: string;
  delivery: OpenCodeMemberInboxDelivery;
}): Promise<OpenCodeRuntimeDeliveryUserVisibleImpact> {
  if (input.delivery.responsePending === true) {
    return { state: 'checking' };
  }

  const factImpact = getImmediateOpenCodeRuntimeDeliveryImpact({
    delivered: input.delivery.delivered,
    responsePending: input.delivery.responsePending,
    reason: input.delivery.reason,
  });

  if (factImpact.state !== 'error') {
    return factImpact;
  }

  // If the immediate delivery result carries generic terminal proof failure facts,
  // report checking during the grace window rather than hard failure.
  const deliveryRecordFacts = {
    ledgerStatus: input.delivery.ledgerStatus,
    responseState: input.delivery.responseState,
    reason: input.delivery.reason,
    diagnostics: input.delivery.diagnostics ?? [],
  };
  // Without record timestamps, generic terminal proof gaps should become checking,
  // not warning. The next explicit status poll can use the full record time.
  return classifyOpenCodeRuntimeDeliveryFactsForImmediateUx(deliveryRecordFacts);
}
```

If a caller needs exact suppression because a late proof already exists, it should call `getOpenCodeRuntimeDeliveryStatus()` after the send result. The immediate result can temporarily say `checking`; it should not temporarily say hard failed for generic proof gaps.

Then IPC:

```ts
const userVisibleImpact = await provisioning.getOpenCodeRuntimeDeliveryImpactForResult({
  teamName: tn,
  delivery,
});

result.runtimeDelivery = {
  ...oldFacts,
  userVisibleImpact,
};
```

## Renderer Diagnostics

Update:

```txt
src/renderer/utils/openCodeRuntimeDeliveryDiagnostics.ts
```

Preferred logic:

```ts
export function buildOpenCodeRuntimeDeliveryDiagnostics(
  result: SendMessageResult
): OpenCodeRuntimeDeliveryDiagnostics {
  const runtimeDelivery = result.runtimeDelivery;
  if (runtimeDelivery?.attempted !== true) {
    return { warning: null, debugDetails: null };
  }

  const impact = runtimeDelivery.userVisibleImpact;
  if (impact) {
    return buildDiagnosticsFromUserVisibleImpact(result, impact);
  }

  return buildLegacyDiagnostics(result);
}
```

Impact mapping:

```ts
function buildDiagnosticsFromUserVisibleImpact(
  result: SendMessageResult,
  impact: OpenCodeRuntimeDeliveryUserVisibleImpact
): OpenCodeRuntimeDeliveryDiagnostics {
  if (impact.state === 'none') {
    return { warning: null, debugDetails: null };
  }

  if (impact.state === 'checking') {
    return {
      warning: CHECKING_WARNING,
      debugDetails: buildDebugDetails(result),
    };
  }

  if (impact.state === 'warning') {
    const detail = formatOpenCodeRuntimeDeliveryFailureReason(impact.message);
    return {
      warning: detail ? `${PROOF_WARNING} Detail: ${detail}` : PROOF_WARNING,
      debugDetails: buildDebugDetails(result),
    };
  }

  const detail = formatOpenCodeRuntimeDeliveryFailureReason(
    impact.message ?? result.runtimeDelivery?.reason
  );
  return {
    warning: detail ? `${FAILED_WARNING} Reason: ${detail}` : FAILED_WARNING,
    debugDetails: buildDebugDetails(result),
  };
}
```

Recommended copy constants:

```ts
const CHECKING_WARNING =
  'OpenCode delivery is still being checked. Message was saved and will be observed before retry if needed.';

const PROOF_WARNING =
  'OpenCode reply could not be verified. Message was saved to inbox, but the app did not find a correlated reply or progress proof.';
```

Keep the old fallback for safety:

```ts
function buildLegacyDiagnostics(result: SendMessageResult): OpenCodeRuntimeDeliveryDiagnostics {
  // Current logic.
}
```

## Renderer Success/Failure Semantics

Update renderer code that currently treats `delivered === false` as a terminal UX failure.

Current examples:

```ts
// teamSlice.ts
const runtimeDeliveryFailed =
  result.runtimeDelivery?.attempted === true && result.runtimeDelivery.delivered === false;

// SendMessageDialog.tsx
if (
  result?.runtimeDelivery?.attempted === true &&
  result.runtimeDelivery.delivered === false
) {
  return;
}
```

After Phase 1.3, `delivered === false` is a ledger fact, not a UX decision. Use `userVisibleImpact` first:

```ts
function isOpenCodeRuntimeDeliveryHardUxFailure(
  runtimeDelivery: SendMessageResult['runtimeDelivery'] | undefined
): boolean {
  if (runtimeDelivery?.attempted !== true) {
    return false;
  }
  if (runtimeDelivery.userVisibleImpact) {
    return runtimeDelivery.userVisibleImpact.state === 'error';
  }
  return runtimeDelivery.delivered === false;
}
```

Use this helper for:

- `lastSendMessageResult` decision in `teamSlice.ts`;
- draft-clearing decision in `SendMessageDialog.tsx`;
- pending-send restore/finalize decision in `MessageComposer.tsx`;
- any test that currently uses `delivered === false` as "do not clear draft".

Expected UX:

- `checking` clears the draft like a saved send, because the message is persisted and still being observed;
- `warning` also should not invite blind duplicate resend;
- `error` preserves the draft for user recovery, preserving the existing hard-failure behavior;
- legacy payloads without `userVisibleImpact` keep the old `delivered === false` behavior.

`MessageComposer.tsx` currently computes pending-send failure from:

```ts
const failed = sendError !== null || sendDebugDetails?.delivered === false;
```

That must become user-visible-impact aware. Otherwise a terminal generic proof gap with `userVisibleState: "checking"` and `delivered: false` will restore the draft even though the message was saved and is still being observed.

Recommended helper:

```ts
function isOpenCodeRuntimeDeliveryHardUxFailureFromDebugDetails(
  debugDetails: OpenCodeRuntimeDeliveryDebugDetails | null | undefined
): boolean {
  if (!debugDetails) return false;
  if (debugDetails.userVisibleState) {
    return debugDetails.userVisibleState === 'error';
  }
  return debugDetails.delivered === false;
}
```

Use it only for the optimistic draft restore path. If a delayed status poll later changes from `checking` to `error`, do not resurrect an old draft automatically; by then the saved user message is already in the conversation and restoring a stale composer draft would look like a duplicate-send prompt.

Pending-reply clearing needs a different helper.

Current paths:

- `src/renderer/components/team/messages/MessagesPanel.tsx`
- `src/renderer/components/team/TeamDetailView.tsx`

They currently clear `pendingRepliesByMember` when `runtimeDelivery.delivered === false`. After Phase 1.3:

```ts
function shouldClearPendingReplyForOpenCodeRuntimeDelivery(
  runtimeDelivery: SendMessageResult['runtimeDelivery'] | undefined
): boolean {
  if (runtimeDelivery?.attempted !== true) {
    return false;
  }
  if (runtimeDelivery.userVisibleImpact) {
    return (
      runtimeDelivery.userVisibleImpact.state === 'warning' ||
      runtimeDelivery.userVisibleImpact.state === 'error'
    );
  }
  return runtimeDelivery.delivered === false;
}
```

Expected pending behavior:

- `checking` keeps pending reply, because a real reply can still arrive;
- `none` clears only through the existing visible-reply reconciliation;
- `warning` clears pending reply because the live reply could not be verified after grace;
- `error` clears pending reply because live delivery failed;
- legacy payloads keep current `delivered === false` clearing behavior.

## Debug Details

Extend renderer debug details to include impact:

```ts
export interface OpenCodeRuntimeDeliveryDebugDetails {
  messageId: string;
  statusMessageId: string | null;
  ledgerRecordId: string | null;
  laneId: string | null;
  queuedBehindMessageId: string | null;
  providerId: string;
  delivered: boolean | null;
  responsePending: boolean | null;
  responseState: string | null;
  ledgerStatus: string | null;
  acceptanceUnknown: boolean | null;
  reason: string | null;
  diagnostics: string[];
  userVisibleState: string | null;
  userVisibleReasonCode: string | null;
  userVisibleMessage: string | null;
  userVisibleObservedAt: string | null;
  userVisibleNextReviewAt: string | null;
}
```

This keeps support/debugging transparent for visible warning/checking/error states. For `userVisibleImpact.state === 'none'`, return `debugDetails: null` so the store clears stale hidden runtime diagnostics.

Update `formatOpenCodeRuntimeDeliveryDebugDetails()` as well as the debug details builder. The expandable JSON/details view should include the user-visible impact fields when a warning/checking/error is visible, otherwise support logs will show `ledgerStatus: failed_terminal` without the reason the UI chose not to render it as a hard failure.

Also update the expanded details grid in `OpenCodeDeliveryWarning.tsx` to render:

- `statusMessageId`;
- `ledgerRecordId`;
- `laneId`;
- `queuedBehindMessageId`;
- `userVisibleState`;
- `userVisibleReasonCode`;
- `userVisibleMessage`;
- `userVisibleObservedAt`;
- `userVisibleNextReviewAt`.

Do not attach debug details for `state: "none"`:

```ts
if (runtimeDelivery.userVisibleImpact?.state === 'none') {
  return { warning: null, debugDetails: null };
}
```

This matters for stale UI cleanup. A hidden `none` state with non-null debug details can keep `OpenCodeDeliveryWarning` mounted, keep polling dependencies alive, or leave a collapsed "delivery details" affordance with no user-facing warning.

`messageId` should remain the original user-sent inbox row id because `clearSendMessageRuntimeDiagnostics(messageId)` and visible-reply reconciliation use it. `statusMessageId` is the id to poll:

```ts
const statusMessageId =
  runtimeDelivery.queuedBehindMessageId?.trim() ||
  result.messageId;
```

Do not replace `debugDetails.messageId` with `queuedBehindMessageId`; that breaks clearing the warning for the original send row. Use `statusMessageId` only for `getOpenCodeRuntimeDeliveryStatus()`.

## Warning Delay Logic

Update:

```txt
src/renderer/components/team/messages/OpenCodeDeliveryWarning.tsx
```

Current delay logic only delays when:

```ts
debugDetails?.responsePending === true && debugDetails.delivered !== false
```

That will not work for Phase 1.3 because a generic terminal ledger fact can be:

```ts
delivered: false
ledgerStatus: 'failed_terminal'
userVisibleState: 'checking'
```

Change the delay condition to prefer user-visible state:

```ts
const delayPendingWarning =
  debugDetails?.userVisibleState === 'checking' ||
  (debugDetails?.userVisibleState == null &&
    debugDetails?.responsePending === true &&
    debugDetails.delivered !== false);
```

This keeps the existing legacy behavior and prevents a terminal-generic proof gap from flashing even as a non-scary checking warning.

## Status Polling Logic

Update:

```txt
src/renderer/components/team/messages/MessagesPanel.tsx
```

Current polling starts only when:

```ts
debugDetails?.responsePending === true
```

That is insufficient after Phase 1.3. A terminal generic proof gap should have:

```ts
responsePending: false
ledgerStatus: 'failed_terminal'
userVisibleState: 'checking'
```

Change the polling gate:

```ts
const messageId = debugDetails?.messageId;
const statusMessageId = debugDetails?.statusMessageId || messageId;
const shouldPollRuntimeDeliveryStatus =
  debugDetails?.responsePending === true ||
  debugDetails?.userVisibleState === 'checking';

if (!messageId || !statusMessageId || sendMessageRuntimeReplyVisible || !shouldPollRuntimeDeliveryStatus) {
  return;
}
```

Update the effect dependencies to include:

- `sendMessageDebugDetails?.statusMessageId`;
- `sendMessageDebugDetails?.userVisibleState`;
- `sendMessageDebugDetails?.userVisibleNextReviewAt`.

Without this, the composer can show a checking warning forever after the immediate send result, because the follow-up `getOpenCodeRuntimeDeliveryStatus()` call never runs.

When calling `refreshSendMessageRuntimeDeliveryStatus`, pass both ids or add a small wrapper:

```ts
void refreshSendMessageRuntimeDeliveryStatus(teamName, {
  messageId,
  statusMessageId,
});
```

The store should still update/clear only if `state.sendMessageDebugDetails?.messageId === messageId`. The IPC status lookup uses `statusMessageId`.

If `statusMessageId !== messageId`, treat the returned status as blocker status, not as the final status of the original send:

- `checking` keeps the original send in checking;
- `none` means the blocker cleared, so schedule or attempt a follow-up status read for the original `messageId`;
- `warning` or `error` on the blocker should not be copied as the new message's warning/error;
- if the original `messageId` still has no ledger record, keep checking until the stale-check window expires.

This prevents a hard failure from an older active delivery row being shown as the failure for a newly queued message.

Stop polling when impact becomes terminal from a UX perspective:

- `none` clears warning/debug details;
- `warning` stops polling because the proof grace window has expired;
- `error` stops polling because delivery is a hard failure;
- legacy `responsePending: false` keeps current behavior.

Do not keep polling a `warning` forever waiting for a late reply. Late runtime replies already reach the renderer through message-feed/member-advisory refresh paths; status polling should only cover the short "checking" window.

## Polling And Refresh Behavior

Current store behavior:

- send action stores warning/debug details from immediate `runtimeDelivery`;
- `refreshSendMessageRuntimeDeliveryStatus()` polls `getOpenCodeRuntimeDeliveryStatus`;
- `OpenCodeDeliveryWarning` delays pending warning display.

Phase 1.3 expected behavior:

1. Direct send returns terminal generic proof inside grace:
   - ledger facts: `delivered: false`, `ledgerStatus: "failed_terminal"`
   - impact: `{ state: "checking", nextReviewAt }`
   - renderer warning: checking copy, not failed copy.

2. Poll before grace expires:
   - still checking.

3. Late reply arrives:
   - impact becomes `none`;
   - warning clears.

4. Grace expires without proof:
   - impact becomes `warning`;
   - copy changes to proof warning.

The polling caller must not rely only on `responsePending`.

If `nextReviewAt` is present, add one extra status refresh just after that time in addition to the existing short poll cadence. The current fixed delays are `[15s, 45s, 90s]`; if the backend grace is around 120s, those fixed timers can all fire before the proof window closes and leave `checking` visible forever.

Clamp the extra delay to a sane range. Do not schedule an arbitrary long timer from IPC data:

```ts
const nextReviewDelayMs = Number.isFinite(Date.parse(nextReviewAt ?? ''))
  ? Math.max(1_000, Math.min(Date.parse(nextReviewAt!) - Date.now() + 500, 180_000))
  : null;
```

Schedule it only when `userVisibleState === 'checking'`. De-dupe it against existing fixed delays if it is within roughly 500ms of one of them.

This is an optimization only. Correctness still comes from explicit status calls and from team/message refresh events, but this timer prevents the common "checking never transitions to proof warning" case.

Handle status failures inside `refreshSendMessageRuntimeDeliveryStatus()`:

```ts
try {
  const status = await unwrapIpc(...);
  if (!status) {
    maybeClearStaleCheckingDiagnostics(normalizedMessageId);
    return;
  }
  // existing diagnostic update
} catch (error) {
  logger.debug('OpenCode runtime delivery status refresh failed', error);
  maybeClearStaleCheckingDiagnostics(normalizedMessageId);
}
```

`maybeClearStaleCheckingDiagnostics()` should only clear non-terminal `checking` after the backend review window is already stale, for example `now > userVisibleNextReviewAt + 60s`. If `userVisibleNextReviewAt` is absent, fall back to a conservative max checking age from `userVisibleObservedAt`, for example three minutes. It must not convert a transient status miss into a hard delivery error.

## Edge Cases

### Backward-compatible IPC

If `userVisibleImpact` is absent:

- use current legacy behavior;
- do not crash browser mode or tests with older fixtures.

### Immediate hard error without ledger

Example:

```json
{
  "attempted": true,
  "delivered": false,
  "reason": "opencode_runtime_message_bridge_unavailable"
}
```

Expected:

- impact fallback `error`;
- old failed warning still appears.

### Runtime not active but bootstrap still checking in

Example:

```json
{
  "attempted": true,
  "delivered": false,
  "reason": "opencode_runtime_not_active",
  "diagnostics": [
    "OpenCode runtime bootstrap is not confirmed for jack. Message was saved and will be retried after runtime check-in."
  ]
}
```

Expected:

- impact `checking`;
- draft clears like a saved send;
- pending reply remains;
- no hard failed copy.

If `opencode_runtime_not_active` has no retry/check-in diagnostic and the lane is stopped/deleted, keep `error` for direct-send recovery.

### UI timeout pending

Example:

```json
{
  "attempted": true,
  "delivered": true,
  "responsePending": true,
  "reason": "opencode_runtime_delivery_ui_timeout_pending"
}
```

Expected:

- impact `checking`;
- pending/checking warning;
- no failed copy.

### Terminal generic proof inside grace

Example:

```json
{
  "attempted": true,
  "delivered": false,
  "responsePending": false,
  "responseState": "empty_assistant_turn",
  "ledgerStatus": "failed_terminal",
  "reason": "empty_assistant_turn",
  "userVisibleImpact": {
    "state": "checking",
    "nextReviewAt": "2026-05-09T07:54:30.998Z"
  }
}
```

Expected:

- renderer shows checking, not failed;
- debug details still show `ledgerStatus: "failed_terminal"`.

### Terminal generic proof after grace

Expected:

- impact `warning`;
- renderer shows proof warning;
- not hard failed warning.

### Hard diagnostic mixed with generic state

Expected:

- impact `error`;
- renderer shows failed warning with provider/auth/quota reason;
- no checking state.

### Late proof between immediate send and polling

Expected:

- immediate result may show checking;
- next poll returns `none`;
- warning clears.

### Terminal facts with none impact

Example:

```json
{
  "attempted": true,
  "delivered": false,
  "ledgerStatus": "failed_terminal",
  "userVisibleImpact": {
    "state": "none"
  }
}
```

Expected:

- renderer clears warning;
- renderer clears debug details;
- draft remains cleared because the send was saved;
- pending reply clears only through existing visible-reply reconciliation, not through a hard-failure path.

### Message queued behind older active delivery

Expected:

- impact `checking`;
- copy should not say failed;
- debug reason can include older message id.
- `debugDetails.messageId` remains the newly sent user message id;
- `debugDetails.statusMessageId` uses `queuedBehindMessageId` while the older active delivery is blocking;
- status polling must not clear the original send warning only because the queued-behind active record is not the same message id.

### Acceptance unknown

Expected:

- impact `checking` while observe-first watchdog can still recover;
- if later hard failure, impact `error`;
- if later generic terminal and inside grace, still `checking`.

### Status request fails during checking

Expected:

- keep the current checking state for one retry window;
- do not convert a transient IPC/status error into `OpenCode delivery error`;
- surface hard failure only when backend status returns `error` or legacy hard facts without `userVisibleImpact`.
- if the backend status remains unavailable past `userVisibleNextReviewAt + 60s`, clear the checking diagnostic instead of leaving a permanent warning;
- if `userVisibleNextReviewAt` is missing, use a conservative max age from `userVisibleObservedAt`.

### Warning after grace with late reply later

Expected:

- proof warning can appear after grace;
- a later visible correlated reply still clears advisory through the normal message/member refresh path;
- no desktop notification or lead notice is retro-fired for the previous proof warning.

## Tests

### Shared type tests

No runtime test required for type-only additions, but compile must pass:

```bash
pnpm typecheck --pretty false
```

### Backend status tests

Update:

```txt
test/main/services/team/TeamProvisioningService.test.ts
test/main/services/team/TeamProvisioningServiceRelay.test.ts
```

Add:

```ts
it('decorates getOpenCodeRuntimeDeliveryStatus with checking impact for recent generic terminal proof failure', async () => {});
it('decorates getOpenCodeRuntimeDeliveryStatus with warning impact after proof grace expires', async () => {});
it('decorates getOpenCodeRuntimeDeliveryStatus with error impact for quota diagnostics', async () => {});
it('decorates immediate sendMessage runtimeDelivery with checking impact for generic terminal proof failure', async () => {});
it('decorates immediate runtime_not_active bootstrap check-in retry as checking', async () => {});
it('decorates stopped runtime_not_active without retry diagnostic as error', async () => {});
it('returns none impact when late visible runtime reply supersedes terminal proof failure', async () => {});
it('returns none impact when late visible reply is recovered by observed message id or taskRefs', async () => {});
it('returns none impact when ledger already has plain_assistant_text visible reply proof', async () => {});
```

### Renderer diagnostics tests

Update:

```txt
test/renderer/utils/openCodeRuntimeDeliveryDiagnostics.test.ts
```

Existing tests that expect failed copy for terminal generic states should split:

```ts
it('shows checking copy for terminal empty assistant turn while impact is checking', () => {});
it('shows proof warning for terminal empty assistant turn when impact is warning', () => {});
it('keeps legacy failed copy when impact is absent', () => {});
it('shows hard failed copy when impact is error', () => {});
it('returns null warning and null debug details when impact is none', () => {});
it('formats user-visible impact fields in debug details for checking and warning states', () => {});
it('preserves original messageId and stores statusMessageId for queued-behind delivery', () => {});
```

### Store tests

Update:

```txt
test/renderer/store/teamSlice.test.ts
```

Cases:

```ts
it('updates pending OpenCode diagnostics to checking when terminal generic proof is still in grace', async () => {});
it('updates checking OpenCode diagnostics to proof warning after grace impact is warning', async () => {});
it('clears OpenCode diagnostics when status impact becomes none', async () => {});
it('does not retain hidden debug details when impact becomes none', async () => {});
it('keeps failed warning for hard OpenCode runtime error impact', async () => {});
it('keeps polling while userVisibleState is checking even when responsePending is false', async () => {});
it('polls statusMessageId while updating diagnostics for the original messageId', async () => {});
it('does not copy a queued-behind blocker hard error onto the newly sent message', async () => {});
it('rechecks the original messageId after queued-behind blocker status becomes none', async () => {});
it('schedules an extra status refresh at userVisibleNextReviewAt for checking impact', async () => {});
it('clears stale checking diagnostics after the review window is stale and status stays unavailable', async () => {});
it('does not treat checking impact as lastSendMessageResult failure when delivered is false', async () => {});
it('keeps pending reply for checking impact even when delivered is false', async () => {});
it('clears pending reply for warning and error impacts', async () => {});
it('stops status polling when checking becomes warning', async () => {});
it('does not convert a transient status request failure into a hard delivery error', async () => {});
```

### Component tests

Update:

```txt
test/renderer/components/team/messages/OpenCodeDeliveryWarning.test.tsx
test/renderer/components/team/messages/MessagesPanel.test.tsx
test/renderer/components/team/messages/MessageComposer.pendingSend.test.tsx
test/renderer/components/team/dialogs/SendMessageDialog.test.tsx
```

Expected:

- checking warning respects the delay even when ledger facts say `delivered: false`;
- proof warning appears immediately once impact is `warning`;
- hard error appears immediately;
- debug details include both ledger fact and impact.

Add a focused component case:

```ts
it('delays checking impact even when ledger facts are terminal failed', async () => {});
```

Dialog draft cases:

```ts
it('does not restore the composer draft for checking impact even when delivered is false', async () => {});
it('clears the send dialog draft for checking impact even when delivered is false', async () => {});
it('preserves the send dialog draft for hard error impact', async () => {});
it('keeps legacy delivered-false draft preservation when userVisibleImpact is absent', async () => {});
```

## Verification

Focused:

```bash
pnpm vitest run test/renderer/utils/openCodeRuntimeDeliveryDiagnostics.test.ts
pnpm vitest run test/renderer/store/teamSlice.test.ts --testNamePattern "OpenCode"
pnpm vitest run test/renderer/components/team/messages/OpenCodeDeliveryWarning.test.tsx
pnpm vitest run test/renderer/components/team/messages/MessageComposer.pendingSend.test.tsx
pnpm vitest run test/main/services/team/TeamProvisioningService.test.ts --testNamePattern "OpenCode runtime"
pnpm vitest run test/main/services/team/TeamProvisioningServiceRelay.test.ts --testNamePattern "OpenCode"
```

Broader:

```bash
pnpm vitest run test/renderer/components/team/messages/MessagesPanel.test.tsx
pnpm vitest run test/renderer/components/team/dialogs/SendMessageDialog.test.tsx
pnpm vitest run test/main/services/team/TeamProvisioningService.test.ts
pnpm vitest run test/main/services/team/TeamProvisioningServiceRelay.test.ts
pnpm typecheck --pretty false
git diff --check
```

Manual smoke:

1. Send a direct message to an OpenCode teammate.
2. Force or simulate a recent `failed_terminal / empty_assistant_turn`.
3. Confirm composer/dialog shows checking copy.
4. Add a correlated runtime reply.
5. Confirm warning clears after refresh.
6. Simulate old proof missing record.
7. Confirm proof warning copy, not hard failed copy.
8. Simulate quota/auth diagnostic.
9. Confirm hard failed copy.

## Rollout Notes

- Do not remove old `delivered`, `responsePending`, `ledgerStatus`, or `responseState` fields.
- Renderer must prefer `userVisibleImpact` when present and fall back to legacy fields when absent.
- Do not hide debug details.
- Do not make `failed_terminal` mean success.
- Do not mark failed inbox rows read.
- Do not delay hard provider/runtime failures.

## Acceptance Criteria

- Direct send no longer flashes `OpenCode runtime delivery failed` for recent generic proof gaps.
- The same status still exposes `failed_terminal` in debug details.
- Hard errors still show failed copy.
- Confirmed proof gaps after grace show a warning, not hard error.
- Late proof clears the warning.
- Existing legacy payloads without `userVisibleImpact` still render with old behavior.
