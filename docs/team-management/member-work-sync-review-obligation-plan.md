# Member Work Sync Review Obligation Plan

**Status:** design proposal, ready for implementation review  
**Scope:** member-work-sync, review lifecycle, member nudges, stuck review pickup  
**Primary repo:** `claude_team`  
**Related controller boundary:** `agent-teams-controller`  
**Recommended option:** Work-sync review pickup obligations  
**Rating:** 🎯 9 🛡️ 9 🧠 8  
**Estimated size:** 850-1250 changed lines with tests for the reliable version. The smaller 350-550 LOC version is only safe for OpenCode-first rollout and does not fully fix the live Anthropic/Alice class.

---

## 1. Summary

The current `member-work-sync` feature already detects review work in the actionable agenda. It correctly detected the live `ember-collective` Alice case as:

```json
{
  "state": "needs_sync",
  "providerId": "anthropic",
  "agendaItems": [
    {
      "kind": "review",
      "priority": "review_requested",
      "taskId": "7142f765-76e5-4532-8a37-e228b841a6ed"
    }
  ]
}
```

But the current system does not yet enforce review pickup:

- Phase 2 nudges are blocked for Anthropic while metrics are not `shadow_ready`.
- The nudge text is generic and report-oriented.
- A `member_work_sync_report(still_working)` can suppress more nudges, but it does not prove that the reviewer called `review_start`.
- `currentReviewCycle.ts` can mix old `review_started` evidence with a newer `review_requested` event, because it does not model a strict review cycle boundary.
- Production delivery wake is OpenCode-only today, and even that wake is fire-and-forget. For Anthropic/native members, inbox insertion alone is not enough evidence that a live member was prompted.
- Review-cycle logic is duplicated across work-sync, controller, stall monitor, and renderer timer fallbacks. If these drift, the system can show a timer, skip a nudge, and still leave the task stuck.

The recommended fix is not a separate ping watchdog. The recommended fix is a precise extension of work-sync:

```text
review_requested -> review_pickup_required obligation
review_started   -> review_in_progress, handled by timers and stall monitor
review_decision  -> obligation gone
status reset     -> obligation gone
```

Only `review_pickup_required` should be allowed to bypass generic Phase 2 readiness. It should still use all existing anti-spam controls:

- durable outbox idempotency;
- current agenda revalidation before dispatch;
- active team check;
- provider delivery capability check;
- member busy signal;
- per-member rate limit;
- watchdog cooldown;
- one-shot member nudge keyed by `reviewRequestEventId`, not by the whole agenda fingerprint;
- lead-facing escalation after ignored correction instead of repeated member spam.

⚠️ Important correction to the earlier plan: do not enable Anthropic review-pickup bypass just because activation says `review_pickup_required`. Enable it only after a provider delivery outcome path is implemented and tested. Otherwise the system can correctly enqueue a nudge that nobody sees promptly.

---

## 2. Decision

Recommended implementation:

**Review pickup obligation inside member-work-sync**  
🎯 9 🛡️ 9 🧠 8, roughly 850-1250 LOC with tests for the full reliable version.

Why this is the best fit:

- It reuses the existing work-sync control plane instead of adding another notification loop.
- It is level-triggered: every dispatch revalidates the current task state.
- It already has durable outbox idempotency, and we can add the missing review-cycle idempotency on top.
- It handles the exact failure class where a reviewer reads a request, answers "duplicate", and never calls `review_start`.
- It avoids interrupting real work because busy signal and rate limiting already sit in the dispatcher.

Rejected or weaker options:

1. **Standalone review pickup watchdog** - 🎯 6 🛡️ 6 🧠 5, 180-300 LOC  
   Easy to add, but it duplicates work-sync and can spam. It would need to rediscover the same lifecycle, busy, idempotency, and rate-limit rules.

2. **Auto-open `review_start` when review request is delivered/read** - 🎯 6 🛡️ 7 🧠 5, 120-220 LOC  
   It improves timer visibility but can overcount time. Receiving a message is not the same as actually starting review.

3. **Only strengthen review request prompt text** - 🎯 7 🛡️ 5 🧠 2, 20-60 LOC  
   Useful as defense-in-depth, but not reliable. The Alice incident happened because the model reasoned itself out of following the tool protocol.

---

## 3. Live Incident That Motivated This

Task:

```text
team: ember-collective
task: #7142f765
subject: Docs: Workflows (runtime-setup/agent-workflow/code-review/troubleshooting) - EN+RU
owner: jack
reviewer: alice
```

Observed task history:

```text
08:02:35 review_requested reviewer=alice
08:02:43 review_started actor=alice
08:03:25 status_changed completed -> in_progress
08:03:45 status_changed in_progress -> completed
08:04:16 review_requested reviewer=alice
08:04:19 review_approved actor=alice
08:05:19 status_changed completed -> in_progress
08:05:24 status_changed in_progress -> completed
08:05:28 review_requested reviewer=alice
```

Current state:

```text
status: completed
reviewState: review
latest review cycle: requested only, no review_started
reviewIntervals: old closed interval only
```

Alice processed the latest message but replied that it was a duplicate. She did not call:

```text
review_start
review_approve
review_request_changes
```

Work-sync then evaluated her as `needs_sync`, but skipped the nudge:

```json
{
  "event": "nudge_skipped",
  "reason": "phase2_not_ready",
  "providerId": "anthropic",
  "taskRefs": [
    {
      "taskId": "7142f765-76e5-4532-8a37-e228b841a6ed",
      "displayId": "7142f765"
    }
  ]
}
```

Conclusion:

```text
work-sync detection works
review pickup enforcement is missing
```

---

## 4. Current Architecture Facts

### 4.1 Agenda already includes reviews

`buildActionableWorkAgenda()` produces `kind: "review"` items when a task is in review workflow and the current reviewer resolves to the member.

Current shape:

```ts
items.push({
  ...base,
  kind: 'review',
  priority: 'review_requested',
  reason: 'current_cycle_review_assigned',
  evidence: {
    status: task.status,
    owner,
    reviewer: memberName,
    reviewState: task.reviewState,
    historyEventIds: reviewOwner.historyEventIds,
  },
});
```

This is good for basic agenda computation, but insufficient for enforcement because the item does not say whether pickup is still required or review is already started.

### 4.2 Current review cycle resolver is too loose

Current resolver:

```ts
const latestStarted = [...historyEvents].reverse().find((event) => event.type === 'review_started');
const latestRequested = [...historyEvents]
  .reverse()
  .find((event) => event.type === 'review_requested');
```

Problem:

```text
old review_started can be returned together with a newer review_requested
```

This was visible in the live Alice status. The evidence had both:

```text
old review_started id
latest review_requested id
```

That should not happen for a strict cycle model.

### 4.3 Controller review lifecycle has better boundaries

The controller already treats these as review cycle boundaries:

```js
if (
  e.type === 'review_changes_requested' ||
  e.type === 'review_approved' ||
  (e.type === 'status_changed' &&
    (e.to === 'in_progress' || e.to === 'pending' || e.to === 'deleted')) ||
  e.type === 'task_created'
) {
  return null;
}
```

Work-sync should match this boundary logic, otherwise renderer/controller/work-sync can disagree about the current cycle.

### 4.4 Work-sync reports are leases, not task transitions

The task protocol explicitly says:

```text
member_work_sync_status and member_work_sync_report are only for reporting whether you have seen the current actionable-work agenda.
They do NOT start, complete, approve, or comment on tasks.
Never use member_work_sync_report instead of task_start, task_complete, review_approve, review_request_changes, task_set_clarification, or task_add_comment.
```

This means a review pickup nudge must not treat `still_working` as a successful review pickup. It can only be a bounded lease that prevents immediate repeated nudging.

### 4.5 Existing anti-spam infrastructure is useful

Current `MemberWorkSyncNudgeDispatcher` already revalidates before delivery:

```text
team active
status exists
agenda recomputed
decision is still needs_sync
agenda fingerprint still matches
phase activation allows it
rate limit allows it
busy signal allows it
watchdog cooldown allows it
```

This is the right place to add review-specific activation. The wrong place is a direct notification inside `review_request`.

### 4.6 Delivery wake is currently provider-asymmetric

Production composition wires `nudgeDeliveryWake` only for OpenCode:

```ts
nudgeDeliveryWake: {
  schedule: (input) => {
    if (input.providerId !== 'opencode') {
      return;
    }
    teamProvisioningService.scheduleOpenCodeMemberInboxDeliveryWake(...);
  },
}
```

The normal teammate inbox relay in `src/main/ipc/teams.ts` is explicitly disabled:

```text
Teammate inbox relay DISABLED (2026-03-23).
Codex/Claude teammates read their own inbox files directly via fs.watch.
Relaying through the lead caused multiple bugs.
```

This makes the live Alice case more subtle:

```text
work-sync can detect the stuck Anthropic review
work-sync can insert an inbox row
but without a delivery outcome path, the live member may not process it soon
```

Required conclusion:

```text
Review pickup bypass needs a delivery-outcome capability gate.
OpenCode can use the existing wake.
Anthropic/native needs either a proven fs-watch delivery outcome path or a new narrow delivery path.
Do not resurrect the old lead relay blindly.
```

### 4.7 Task impact routing can miss review owners

`MemberWorkSyncTaskImpactResolver` computes `taskWorkflowColumn` from kanban-aware state, but then resolves review owner using raw `task.reviewState`:

```ts
const taskWorkflowColumn = getTeamTaskWorkflowColumn({
  ...task,
  ...(taskKanbanColumn ? { kanbanColumn: taskKanbanColumn } : {}),
});

const reviewOwner =
  taskWorkflowColumn === 'review'
    ? resolveCurrentReviewOwner({
        reviewState: task.reviewState,
        kanbanReviewer: kanban.tasks[task.id]?.reviewer ?? null,
        historyEvents: task.historyEvents,
      })
    : null;
```

If kanban says the task is in review but persisted `task.reviewState` is stale or missing, full agenda recompute can still see the review, while task-impact routing may not wake the reviewer. The plan must fix this by passing the workflow column into the review-cycle resolver:

```ts
resolveCurrentReviewCycle({
  reviewState: taskWorkflowColumn,
  kanbanReviewer,
  historyEvents,
});
```

This is not a cleanup. It is required for reliable triggering.

### 4.8 Review-cycle logic is duplicated and can drift

Current related logic exists in several places:

- `src/features/member-work-sync/core/domain/currentReviewCycle.ts`
- `agent-teams-controller/src/internal/agenda.js`
- `src/main/services/team/stallMonitor/reviewerResolution.ts`
- `src/main/services/team/stallMonitor/TeamTaskStallPolicy.ts`
- renderer review timer fallback logic

These components do not need identical output, but they must agree on the same lifecycle boundaries:

```text
review_requested starts or replaces current review request
review_started only belongs to the current request if it happens after that request
review_approved closes the cycle
review_changes_requested closes the cycle
status_changed -> in_progress/pending/deleted closes the cycle
task_created resets history
```

Implementation should add shared fixtures or a shared helper where imports are practical. If controller JS cannot directly import TS shared code, keep the implementations separate but test the same event tables on both sides.

### 4.9 Nudge payload metadata is too thin for robust review intent

Current inbox messages preserve `messageKind`, but there is no structured `intent`, `intentKey`, or `reviewRequestEventId` in `InboxMessage` / `SendMessageRequest`.

That means a review-pickup nudge can only be recognized by generic `member_work_sync_nudge` kind or brittle text matching. This is weak for:

- OpenCode wrapper wording;
- one-shot per review request;
- lead escalation after ignored pickup;
- debugging delivered vs superseded rows.

Reliable implementation should extend the work-sync payload and inbox/sent-message persistence with structured intent metadata:

```ts
workSyncIntent?: 'agenda_sync' | 'review_pickup';
workSyncIntentKey?: string; // review-pickup:<reviewRequestEventId>
workSyncReviewRequestEventIds?: string[];
```

This costs more lines, but it avoids depending on prompt text as a machine-readable contract.

### 4.10 Outbox `delivered` currently means inbox row inserted

Current dispatcher order is:

```text
insert inbox row
mark outbox delivered
append nudge_delivered
schedule delivery wake
```

That is acceptable for passive sync reminders, but it is too weak for review pickup. If wake scheduling fails after the row is inserted, the outbox is already terminal `delivered`. Then:

- retry will not happen because `delivered` is terminal;
- rate limit can count a nudge that never reached live input;
- one-shot marker can incorrectly block future repair;
- lead escalation may think the member ignored the correction, when the member never saw it.

Reliable review pickup needs a stronger definition:

```text
inbox_persisted = JSON row exists
prompt_accepted = live runtime/provider accepted the prompt or direct member wake
response_proven = runtime saw acceptable proof, such as report or task progress
delivery unavailable = not delivered, audit and lead-escalate
```

For review pickup, one-shot should be written at `prompt_accepted`, not at `inbox_persisted`. The review obligation itself is cleared only by task state (`review_start`, `review_approve`, `review_request_changes`) or by a short report lease.

Implementation options:

1. **Three-state review-pickup delivery model** - 🎯 9 🛡️ 9 🧠 8, 180-320 LOC  
   Add explicit `inbox_persisted`, `prompt_accepted`, and `response_proven` metadata/statuses for review pickup. `prompt_accepted` is enough to prevent repeated member nudges; `response_proven` is useful for diagnostics. On prompt failure, keep retryable with `nextAttemptAt`.

2. **Synchronous review-pickup delivery port** - 🎯 9 🛡️ 8 🧠 7, 140-260 LOC  
   Add a dedicated port that persists the inbox row and immediately attempts provider delivery. For OpenCode, call the relay path that returns `lastDelivery` instead of only scheduling the watchdog. Mark prompt accepted only when provider delivery says accepted or response pending after accepted prompt.

3. **Reorder insert -> schedule wake -> mark delivered** - 🎯 6 🛡️ 5 🧠 4, 50-100 LOC  
   Better than current order, but still weak because `scheduleOpenCodeMemberInboxDeliveryWake()` is a fire-and-forget timer. Scheduling the watchdog is not proof that OpenCode accepted the prompt.

4. **Keep current order and audit wake failure** - 🎯 5 🛡️ 4 🧠 2, 10-30 LOC  
   Not reliable. It preserves the exact false-delivered failure mode.

Recommendation: Option 2 for the first implementation if it can return a real provider outcome. If not, use Option 1 and let the watchdog/relay result transition the item from `inbox_persisted` to `prompt_accepted`.

### 4.11 Fire-and-forget wake is not delivery proof

`scheduleOpenCodeMemberInboxDeliveryWake()` currently schedules a watchdog job and returns `void`. It can tell us that a timer was installed, but not whether:

- the runtime was still active when the timer fired;
- the relay found the message;
- OpenCode accepted the prompt;
- the prompt resulted in response proof;
- the inbox read commit succeeded.

For generic work-sync, this may be acceptable because the next queue/scheduler pass can keep nudging under rate limits. For review pickup, it is not acceptable because one-shot behavior and lead escalation depend on knowing whether the member was actually prompted.

Required plan change:

```text
nudgeDeliveryWake.schedule remains ok for generic nudges
review_pickup uses a delivery-outcome path, not fire-and-forget schedule alone
```

Possible API:

```ts
export interface MemberWorkSyncReviewPickupDeliveryPort {
  canDeliver(input: ReviewPickupDeliveryTarget): Promise<ReviewPickupDeliveryCapability>;
  deliver(input: ReviewPickupDeliveryRequest): Promise<ReviewPickupDeliveryOutcome>;
}

export type ReviewPickupDeliveryOutcome =
  | {
      ok: true;
      state: 'prompt_accepted' | 'response_proven';
      messageId: string;
      diagnostics?: string[];
    }
  | { ok: false; state: 'capability_absent'; reason: string; diagnostics?: string[] }
  | {
      ok: false;
      state: 'retryable_failure';
      reason: string;
      nextAttemptAt?: string;
      diagnostics?: string[];
    }
  | { ok: false; state: 'terminal_failure'; reason: string; diagnostics?: string[] };
```

### 4.12 Persisted status can be stale after restart

`MemberWorkSyncDiagnosticsReader.getStatus()` currently returns stored status immediately when it exists. The renderer hook also calls `getStatus`, not `refreshStatus`, for normal display. That means after app restart the UI can briefly or indefinitely show a persisted status that was evaluated before:

- a new task history event;
- a crash repair;
- a startup scan;
- a provider delivery retry;
- a report lease expiry.

For generic diagnostics this is tolerable. For review pickup it can hide the fact that no outbox planning has happened yet.

Required behavior:

```text
stored status should expose staleness
startup scan should repair/reconcile active members
UI/debugging should be able to tell persisted snapshot from fresh queue-planned status
```

Implementation options:

1. **Staleness-aware `getStatus`** - 🎯 8 🛡️ 8 🧠 5, 80-160 LOC  
   If stored status is older than a threshold, source revision changed, report lease expired, or app restart marker is newer, return status with `diagnostics: ['status_snapshot_stale']` and enqueue refresh. Do not plan nudges from plain UI reads.

2. **Renderer calls `refreshStatus` for the panel** - 🎯 7 🛡️ 7 🧠 3, 20-50 LOC  
   Simpler, but it can turn UI visits into side-effectful reconciliation unless carefully separated from outbox planning.

3. **Keep current stored-first behavior** - 🎯 4 🛡️ 4 🧠 1, 0 LOC  
   Not enough for reliable review pickup after crash/restart.

Recommendation: Option 1. Keep `getStatus` cheap and mostly read-only, but make staleness explicit and enqueue a queue reconciliation when needed. Outbox planning still happens in queue reconciliation, not in the read path.

---

## 5. Core Model

Add a review obligation concept to the agenda item evidence.

```ts
export type MemberWorkSyncReviewObligation = 'review_pickup_required' | 'review_in_progress';

export interface MemberWorkSyncReviewCycleEvidence {
  reviewCycleId: string;
  reviewRequestEventId: string;
  reviewRequestedAt: string;
  reviewStartedEventId?: string;
  reviewStartedAt?: string;
  reviewStartedBy?: string;
  obligation: MemberWorkSyncReviewObligation;
  canBypassPhase2: boolean;
  diagnostics?: string[];
}
```

Suggested contract extension:

```ts
export interface MemberWorkSyncActionableWorkItem {
  taskId: string;
  displayId?: string;
  subject: string;
  kind: MemberWorkSyncActionableWorkKind;
  assignee: string;
  priority: MemberWorkSyncActionableWorkPriority;
  reason: string;
  evidence: {
    status: string;
    owner?: string;
    reviewer?: string;
    reviewState?: string;
    reviewCycleId?: string;
    reviewRequestEventId?: string;
    reviewRequestedAt?: string;
    reviewStartedEventId?: string;
    reviewStartedAt?: string;
    reviewStartedBy?: string;
    reviewObligation?: MemberWorkSyncReviewObligation;
    canBypassPhase2?: boolean;
    reviewDiagnostics?: string[];
    historyEventIds?: string[];
  };
}
```

The fingerprint must include this evidence. That gives one stable agenda fingerprint per active review request cycle.

For nudge idempotency, add a separate intent key that is stable even if the agenda contains other tasks:

```ts
export interface MemberWorkSyncReviewPickupIntent {
  intent: 'review_pickup';
  intentKey: `review-pickup:${string}`;
  reviewRequestEventIds: string[];
}
```

Do not use only `agendaFingerprint` for one-shot semantics. Agenda fingerprint can change when another task appears, a subject changes, or evidence formatting changes. The review request event id is the real lifecycle identity.

---

## 6. Review Cycle Resolver

Replace the loose owner resolver with a strict cycle resolver.

### 6.1 Desired resolver output

```ts
export interface CurrentReviewCycle {
  reviewer: string;
  reviewCycleId: string;
  requestEventId: string;
  requestedAt: string;
  startedEventId?: string;
  startedAt?: string;
  startedBy?: string;
  diagnostics: string[];
  canBypassPhase2: boolean;
  obligation: 'review_pickup_required' | 'review_in_progress';
  historyEventIds: string[];
}
```

### 6.2 Resolver algorithm

Pseudo-code:

```ts
const REVIEW_CYCLE_BOUNDARY_TYPES = new Set([
  'task_created',
  'review_approved',
  'review_changes_requested',
]);

function isStatusReset(event: ReviewHistoryEventLike): boolean {
  return (
    event.type === 'status_changed' &&
    (event.to === 'in_progress' || event.to === 'pending' || event.to === 'deleted')
  );
}

function getCurrentReviewCycle(input: {
  reviewState?: string | null;
  kanbanReviewer?: string | null;
  historyEvents?: ReviewHistoryEventLike[];
}): CurrentReviewCycle | null {
  if (input.reviewState !== 'review') {
    return null;
  }

  const events = (input.historyEvents ?? [])
    .map((event, index) => ({ event, index }))
    .sort((a, b) => compareEventsByTimestampThenIndex(a, b));

  let request: ReviewHistoryEventLike | null = null;
  let requestIndex = -1;
  let startedByReviewer: ReviewHistoryEventLike | null = null;
  let ambiguousStarted: ReviewHistoryEventLike | null = null;
  const diagnostics: string[] = [];

  for (const { event, index } of events) {
    if (REVIEW_CYCLE_BOUNDARY_TYPES.has(event.type) || isStatusReset(event)) {
      request = null;
      requestIndex = -1;
      startedByReviewer = null;
      ambiguousStarted = null;
      diagnostics.length = 0;
      continue;
    }

    if (event.type === 'review_requested') {
      request = event;
      requestIndex = index;
      startedByReviewer = null;
      ambiguousStarted = null;
      diagnostics.length = 0;
      continue;
    }

    if (event.type === 'review_started' && request && index > requestIndex) {
      const requestedReviewer =
        normalizeMemberName(request.reviewer) || normalizeMemberName(input.kanbanReviewer);
      const startedBy = normalizeMemberName(event.actor);

      if (!startedBy) {
        diagnostics.push('review_started_actor_missing');
        ambiguousStarted = event;
        continue;
      }

      if (requestedReviewer && startedBy !== requestedReviewer) {
        diagnostics.push('review_started_by_different_member');
        ambiguousStarted = event;
        continue;
      }

      startedByReviewer = event;
    }
  }

  if (!request) {
    return legacyKanbanFallback(input);
  }

  const reviewer =
    normalizeMemberName(request.reviewer) ||
    normalizeMemberName(input.kanbanReviewer) ||
    normalizeMemberName(startedByReviewer?.actor) ||
    normalizeMemberName(ambiguousStarted?.actor);

  if (!reviewer) {
    return null;
  }

  const effectiveStarted = startedByReviewer ?? ambiguousStarted;
  const hasStartedEvidence = Boolean(effectiveStarted);
  const validStartedByReviewer = startedByReviewer;

  return {
    reviewer,
    reviewCycleId: request.id ?? `${request.timestamp ?? ''}:${reviewer}`,
    requestEventId: request.id ?? '',
    requestedAt: request.timestamp ?? '',
    ...(effectiveStarted?.id ? { startedEventId: effectiveStarted.id } : {}),
    ...(effectiveStarted?.timestamp ? { startedAt: effectiveStarted.timestamp } : {}),
    ...(effectiveStarted?.actor ? { startedBy: effectiveStarted.actor } : {}),
    diagnostics,
    canBypassPhase2: Boolean(request.id) && !hasStartedEvidence && diagnostics.length === 0,
    obligation: hasStartedEvidence ? 'review_in_progress' : 'review_pickup_required',
    historyEventIds: [request.id, effectiveStarted?.id].filter(Boolean),
  };
}
```

Important behavior:

- A `review_started` before a later `status_changed -> in_progress` must not count.
- A `review_started` before a later `review_approved` must not count.
- A newer `review_requested` replaces earlier request evidence even if there was an old `review_started` in the same file.
- A latest `review_requested` without matching current-cycle `review_started` must be `review_pickup_required`.
- A legacy kanban reviewer can still create a review item, but should not get Phase 2 bypass unless there is a concrete `reviewRequestEventId`.
- A `review_started` by a different member is not a normal pickup case. Do not nudge the requested reviewer blindly; surface a diagnostic or lead escalation.
- A `review_started` with missing actor should not be treated as proof for Phase 2 bypass. It can suppress member spam, but it needs diagnostics because timer attribution may be impossible.
- If an anomalous `review_started` is followed by a valid current-cycle `review_started` by the requested reviewer, the valid start wins for obligation. Keep diagnostics for observability, but do not keep the task in pickup-required state.

---

## 7. Agenda Item Shape

For a requested-only review:

```json
{
  "kind": "review",
  "priority": "review_requested",
  "reason": "current_cycle_review_assigned",
  "evidence": {
    "status": "completed",
    "owner": "jack",
    "reviewer": "alice",
    "reviewState": "review",
    "reviewObligation": "review_pickup_required",
    "canBypassPhase2": true,
    "reviewCycleId": "420d47fb-be29-40ab-8d2e-c2e4fad63961",
    "reviewRequestEventId": "420d47fb-be29-40ab-8d2e-c2e4fad63961",
    "reviewRequestedAt": "2026-05-09T08:05:28.361Z",
    "historyEventIds": ["420d47fb-be29-40ab-8d2e-c2e4fad63961"]
  }
}
```

For an already started review:

```json
{
  "kind": "review",
  "priority": "review_requested",
  "reason": "current_cycle_review_assigned",
  "evidence": {
    "status": "completed",
    "owner": "jack",
    "reviewer": "alice",
    "reviewState": "review",
    "reviewObligation": "review_in_progress",
    "canBypassPhase2": false,
    "reviewCycleId": "420d47fb-be29-40ab-8d2e-c2e4fad63961",
    "reviewRequestEventId": "420d47fb-be29-40ab-8d2e-c2e4fad63961",
    "reviewRequestedAt": "2026-05-09T08:05:28.361Z",
    "reviewStartedEventId": "abc-start",
    "reviewStartedAt": "2026-05-09T08:06:10.000Z",
    "reviewStartedBy": "alice",
    "historyEventIds": ["420d47fb-be29-40ab-8d2e-c2e4fad63961", "abc-start"]
  }
}
```

---

## 8. Nudge Activation Policy

### 8.1 Current behavior

Current activation allows:

- all providers when `phase2Readiness.state === 'shadow_ready'`;
- OpenCode targeted candidates during `collecting_shadow_data`;
- no Anthropic/Codex/Gemini bypass while collecting.

### 8.2 Desired review-specific bypass

Add a narrow condition:

```ts
function isReviewPickupRequired(status: MemberWorkSyncStatus): boolean {
  return (
    status.state === 'needs_sync' &&
    status.shadow?.wouldNudge === true &&
    status.agenda.items.length > 0 &&
    status.agenda.items.every(
      (item) =>
        item.kind === 'review' &&
        item.evidence.reviewObligation === 'review_pickup_required' &&
        Boolean(item.evidence.reviewRequestEventId) &&
        item.evidence.canBypassPhase2 === true
    )
  );
}
```

Then activation can allow planning:

```ts
if (hasBlockingMetrics(input.metrics)) {
  return { active: false, reason: 'blocking_metrics' };
}

if (isReviewPickupRequired(input.status)) {
  return { active: true, reason: 'review_pickup_required' };
}
```

Important: keep `blocking_metrics` before review bypass. If the team has unsafe nudge rates or fingerprint churn, do not bypass.

But activation is not enough. Dispatch must also verify delivery capability:

```ts
function hasReviewPickupDeliveryCapability(status: MemberWorkSyncStatus): boolean {
  if (status.providerId === 'opencode') {
    return true; // existing runtime wake
  }

  return status.deliveryCapabilities?.memberWorkSyncNudgeWake === true;
}

if (isReviewPickupRequired(status) && !hasReviewPickupDeliveryCapability(status)) {
  return { active: false, reason: 'review_pickup_delivery_unavailable' };
}
```

Without this gate, Anthropic can pass activation but still only get a passive inbox row. That is not a reliable repair.

Use two different failure classes:

```text
delivery capability absent = do not create/dispatch member outbox, audit and lead-escalate
provider delivery temporarily failed = retryable dispatch failure with nextAttemptAt
fire-and-forget wake scheduled = not enough to mark prompt_accepted
```

This distinction matters because a provider that has no implementation should not create an infinite retry loop, while an active provider with a transient wake error should retry.

Suggested type change:

```ts
export type MemberWorkSyncNudgeActivationReason =
  | 'shadow_ready'
  | 'opencode_targeted_shadow_collecting'
  | 'review_pickup_required'
  | 'review_pickup_delivery_unavailable'
  | 'status_not_nudgeable'
  | 'blocking_metrics'
  | 'phase2_not_ready';
```

If delivery capability is hard to expose through `MemberWorkSyncStatus`, keep it in dispatcher deps instead:

```ts
nudgeDeliveryWake.canWake?.({
  teamName,
  memberName,
  providerId,
  messageKind: 'member_work_sync_nudge',
  workSyncIntent: 'review_pickup',
});
```

The important part is the product invariant, not the exact API shape:

```text
review pickup bypass may create a prompt only when the app can wake that member path
```

---

## 9. Nudge Payload

### 9.1 Current payload is too generic

Current text:

```text
Work sync check: you have current actionable work assigned.
Required sync action: call member_work_sync_status...
Then call member_work_sync_report...
```

For review pickup, this is not enough. It can produce a valid `still_working` lease without `review_start`, which would hide the stuck review for up to 15 minutes.

### 9.2 Review-specific payload

If every item is `review_pickup_required`, build a different payload:

```ts
function buildReviewPickupNudgePayload(status: MemberWorkSyncStatus): MemberWorkSyncNudgePayload {
  const reviewItems = status.agenda.items.filter(
    (item) => item.kind === 'review' && item.evidence.reviewObligation === 'review_pickup_required'
  );

  const taskIds = reviewItems.map((item) => item.taskId);
  const taskList = reviewItems
    .map((item) => `${item.displayId ?? item.taskId.slice(0, 8)} ${item.subject}`)
    .join('; ');

  return {
    from: 'system',
    to: status.memberName,
    messageKind: 'member_work_sync_nudge',
    workSyncIntent: 'review_pickup',
    workSyncIntentKey: buildReviewPickupIntentKey(reviewItems),
    workSyncReviewRequestEventIds: reviewItems.map((item) => item.evidence.reviewRequestEventId),
    source: 'member-work-sync',
    actionMode: 'do',
    taskRefs: reviewItems.map((item) => ({
      teamName: status.teamName,
      taskId: item.taskId,
      displayId: item.displayId ?? item.taskId.slice(0, 8),
    })),
    text: [
      'Review pickup check: you have a current review request that is still waiting for review_start.',
      `Current review agenda: ${taskList}.`,
      `First call task_get for the task. If it is still in review for member "${status.memberName}", call review_start now.`,
      `After review_start, either approve with review_approve or request fixes with review_request_changes.`,
      'Do not treat this as a duplicate only because you reviewed an earlier cycle. A later review request starts a new review cycle.',
      `If you are blocked from reviewing, add or request concrete blocker evidence on the task before reporting blocked.`,
      `member_work_sync_report may be used only to lease the sync state while you continue. It does not start or finish the review.`,
      taskIds.length
        ? `When reporting, include taskIds: ${taskIds.map((id) => `"${id}"`).join(', ')}.`
        : '',
      `Do not use provider names, runtime names, or team names as memberName; use exactly "${status.memberName}".`,
      'Do not reply only with acknowledgement.',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}
```

Required payload contract change:

```ts
export interface MemberWorkSyncNudgePayload {
  from: 'system';
  to: string;
  messageKind: 'member_work_sync_nudge';
  workSyncIntent: 'agenda_sync' | 'review_pickup';
  workSyncIntentKey?: string;
  workSyncReviewRequestEventIds?: string[];
  source: 'member-work-sync';
  actionMode: 'do';
  text: string;
  taskRefs: TaskRef[];
}
```

The same metadata should survive through:

```text
MemberWorkSyncNudgePayload
-> TeamInboxMemberWorkSyncNudgeSink
-> SendMessageRequest
-> InboxMessage
-> TeamInboxWriter
-> TeamInboxReader
-> OpenCode delivery ledger / runtime adapter where applicable
```

Do not use text parsing as the main way to detect review-pickup intent. Text can remain a fallback for legacy rows only.

### 9.3 OpenCode wrapper also needs review-specific wording

OpenCode currently wraps work-sync nudges with:

```text
Concrete task progress or member_work_sync_report is sufficient response proof.
```

For review pickup, that wording is wrong. The wrapper should inspect the payload or new payload kind and say:

```text
This delivered app message is a review pickup work-sync nudge.
Concrete proof is review_start, review_approve, review_request_changes, or a valid member_work_sync_report lease.
The lease prevents repeated sync nudges but does not start or finish review.
```

This matters because OpenCode delivery proof currently treats report proof as enough to mark prompt delivery complete. That is fine for delivery, but not enough to clear the work-sync obligation unless the agenda changes or a lease is still active.

Use structured metadata first:

```ts
const isReviewPickupNudge =
  input.messageKind === 'member_work_sync_nudge' && input.workSyncIntent === 'review_pickup';
```

Text marker fallback is acceptable only for already persisted legacy messages:

```ts
const isLegacyReviewPickupNudge = input.text.includes('Review pickup check:');
```

---

## 10. Report Semantics

### 10.1 Keep `still_working` as a lease

Do not reject `still_working` for review pickup by default. If an agent is actually about to review, a short lease is useful. The important constraint is:

```text
still_working suppresses repeat nudge
still_working does not satisfy review pickup
```

Current `decideMemberWorkSyncStatus()` already implements this behavior by returning `still_working` only until `expiresAt`.

### 10.2 Shorter default lease for review pickup

Current default still-working lease is 15 minutes. For review pickup this is too long.

Suggested rule:

```ts
const DEFAULT_REVIEW_PICKUP_STILL_WORKING_LEASE_MS = 3 * 60 * 1000;
```

Option A:

- pass agenda into `clampLeaseTtlMs`;
- if agenda has `review_pickup_required`, default to 3 minutes and max to 10 minutes.
- 🎯 9 🛡️ 9 🧠 4, roughly 30-70 LOC.

Option B:

- keep report validator unchanged;
- nudge text explicitly asks for smaller `leaseTtlMs`.
- 🎯 6 🛡️ 5 🧠 2, roughly 10-25 LOC.

Recommendation: Option A. It is safer because the app controls the lease.

### 10.3 `blocked` must still require board evidence

Current report validator rejects blocked unless agenda has blocker evidence:

```ts
if (
  input.request.state === 'blocked' &&
  !agendaHasBlockedEvidence(input.agenda, input.request.taskIds)
) {
  return {
    ok: false,
    code: 'blocked_without_evidence',
    message: 'Blocked report requires current blocker evidence in the task board.',
  };
}
```

For review pickup, this should remain strict. A reviewer saying "blocked" without a task comment or blocker flag is not durable.

Potential future improvement:

```text
review_blocked_without_comment -> reject with message telling reviewer to add task comment first
```

### 10.4 Delivered outbox rows are terminal

Current outbox semantics should be treated as:

```text
pending / claimed / failed_retryable can be retried
delivered is terminal for that outbox id
```

That means after the short `still_working` lease expires, we must not rely on reviving the same delivered member nudge. If the same `reviewRequestEventId` is still `review_pickup_required`, the next action should be lead escalation or a new explicit escalation row, not another member poke under a churned agenda fingerprint.

For review pickup, write the one-shot member marker only after the stronger delivery definition is met:

```text
do not mark one-shot on outbox planned
do not mark one-shot on inbox inserted alone
do not mark one-shot on fire-and-forget wake scheduled
mark one-shot after prompt_accepted or response_proven
```

If wake fails after inbox insertion, the retry should be able to reuse the same message id and schedule wake again.

---

## 11. One-Shot Member Nudge And Lead Escalation

A key anti-spam requirement:

```text
Do not keep poking the reviewer forever.
```

Recommended behavior:

1. First failure after turn-settled:
   - work-sync computes `needs_sync`;
   - obligation is `review_pickup_required`;
   - one member nudge is delivered for that review request cycle.

2. If reviewer calls `review_start`, `review_approve`, or `review_request_changes`:
   - agenda changes;
   - outbox item is superseded or no longer matches;
   - no more pickup nudges.

3. If reviewer reports `still_working`:
   - status becomes `still_working`;
   - pending nudge is superseded;
   - after short lease expires, work-sync can re-enter `needs_sync`.

4. If after one delivered member nudge the same review cycle remains `review_pickup_required`:
   - do not deliver another member nudge immediately;
   - create a lead-facing escalation or diagnostic.

Possible escalation payload:

```text
Review pickup still pending after member correction.

Task #7142f765 is still in review for alice, but no review_start, review_approve, or review_request_changes was recorded after the current review request.

The member already received one review pickup correction for this cycle. Consider reassigning reviewer or sending a direct instruction.
```

Implementation options:

- Minimal: record `review_pickup_member_nudge_delivered` in audit and rely on existing rate limit - 🎯 5 🛡️ 4 🧠 2, 20-40 LOC. This is not enough for reliable production because fingerprint churn can create repeated member nudges.
- Better: add outbox terminal reason or sidecar marker keyed by `(team, member, reviewRequestEventId)` - 🎯 8 🛡️ 8 🧠 5, 80-150 LOC.
- Best: add the sidecar marker plus a lead notification outbox path for ignored review pickup obligations - 🎯 9 🛡️ 9 🧠 7, 160-260 LOC.

Recommended first pass:

```text
one member nudge per reviewRequestEventId
lead notification after lease expiry or next turn-settled if obligation persists
```

This avoids repeated member spam while making the stuck state visible.

Do not make lead escalation optional if the goal is to prevent future silent stuck reviews. Without escalation, the system avoids spam but can still leave the task invisible after the first ignored correction.

---

## 12. Edge Cases

### 12.1 Reviewer already started review in this cycle

History:

```text
review_requested alice
review_started alice
```

Expected:

- obligation is `review_in_progress`;
- no review pickup bypass;
- timer can show reviewing;
- stall monitor handles no-progress-after-start cases.

### 12.2 Reviewer approved without explicit `review_start`

History:

```text
review_requested alice
review_approved alice
```

Expected:

- no review agenda item;
- any pending pickup nudge is superseded during dispatch revalidation;
- do not create a pickup nudge after approval.

### 12.3 Reviewer requested changes without explicit `review_start`

History:

```text
review_requested alice
review_changes_requested alice
status_changed completed -> pending
```

Expected:

- review obligation gone;
- owner gets needs-fix work item;
- no pickup nudge.

### 12.4 Task returned to work after review

History:

```text
review_requested alice
review_started alice
status_changed completed -> in_progress
status_changed in_progress -> completed
review_requested alice
```

Expected:

- old `review_started` is not part of current cycle;
- current cycle is requested-only;
- pickup obligation exists for latest request only.

This is the exact live Alice shape.

### 12.5 Repeated review request in same cycle

History:

```text
review_requested alice
review_requested alice
```

Expected:

- latest request should become the current request event;
- older request should not keep the same fingerprint;
- one nudge per latest request event.

Reason: a new request often means the owner added new context or asked for another pass.

### 12.6 Reviewer changed before pickup

History:

```text
review_requested alice
review_requested bob
```

Expected:

- Alice agenda loses the review item;
- Bob agenda gets `review_pickup_required`;
- any Alice pending nudge is superseded because fingerprint no longer matches.

### 12.7 Kanban reviewer exists but no review_requested event

State:

```text
kanban.tasks[task].column = review
kanban.tasks[task].reviewer = alice
history has no review_requested
```

Expected:

- agenda may include review item for backwards compatibility;
- do not allow Phase 2 bypass;
- reason should be legacy or diagnostics should mention missing request event.

Reason: without a concrete request event, idempotency by review cycle is weak.

### 12.8 Self-review

State:

```text
owner = alice
reviewer = alice
```

Current controller agenda treats self-review as lead oversight in some paths. Work-sync should avoid nudging Alice to review her own task unless the system explicitly allows self-review.

Expected:

- no review pickup bypass for self-review;
- lead-facing issue is safer.

### 12.9 Reviewer inactive or removed

Expected:

- `activeMemberNames` validation prevents valid report;
- agenda source should not create a member agenda for removed member;
- task impact resolver should fall back to lead if reviewer missing/invalid;
- no member nudge.

### 12.10 Team offline or stopping

Expected:

- `isTeamActive` false makes status `inactive`;
- outbox dispatch supersedes with `team_inactive`;
- no inbox insertion.

### 12.11 Member busy

Expected:

- active or recent tool activity defers dispatch;
- retry happens after busy `retryAfterIso`;
- no interruption during active tool calls.

### 12.12 Existing stall monitor alert

Expected:

- `TeamTaskStallJournalWorkSyncCooldown` prevents duplicate nudge if stall monitor recently alerted for same task;
- review pickup and stall monitor should not both spam.

Important distinction:

```text
review_pickup_required = reviewer has not started current review
started-review stall = reviewer started but stopped progressing
```

### 12.13 Agent reports `still_working` but does nothing

Expected:

- status becomes `still_working` for short lease;
- no repeated immediate nudge;
- after lease expires, obligation returns to `needs_sync`;
- if member already got one pickup nudge for this reviewRequestEventId, escalate to lead instead of repeatedly nudging the member.

### 12.14 App crash between outbox creation and dispatch

Expected:

- pending outbox item remains durable;
- dispatch scheduler claims it after restart;
- revalidation prevents stale delivery.

### 12.15 App crash after inbox write but before mark delivered

Expected:

- `insertIfAbsent` uses stable `messageId`;
- retry sees existing inbox row and does not duplicate message;
- outbox can mark delivered on retry.

### 12.16 Agent reads nudge but app crashes before mark read

Expected:

- native inbox behavior may re-relay unread rows;
- stable `messageId` and relayed ids reduce duplicates during a run;
- for OpenCode, delivery ledger should handle response proof separately;
- for native, this is acceptable because nudge is idempotent and review tools are idempotent.

### 12.17 OpenCode-specific delivery proof

OpenCode wrapper currently treats work-sync report as enough delivery proof. For review pickup:

- report is enough proof that the nudge was processed;
- report is not enough proof that review started;
- work-sync status remains `still_working` until lease expires unless task state changes.

### 12.18 Non-OpenCode delivery outcome

Production composition currently wires `nudgeDeliveryWake` only for OpenCode:

```ts
nudgeDeliveryWake: {
  schedule: (input) => {
    if (input.providerId !== 'opencode') {
      return;
    }
    teamProvisioningService.scheduleOpenCodeMemberInboxDeliveryWake(...);
  },
}
```

That is fine for generic Phase 2 because OpenCode was the targeted early-delivery candidate. For review pickup bypass, this becomes an implementation risk because the first target provider in the live incident is Anthropic.

Delivery options:

1. **Generic provider delivery outcome using a narrow, tested path** - 🎯 8 🛡️ 8 🧠 7, 180-300 LOC  
   Add a `canDeliver` / `deliver` capability for `member_work_sync_nudge` and route providers explicitly. OpenCode can reuse relay/ledger internals, but not just fire-and-forget scheduling. Native providers use a proven direct member inbox watcher result or `relayInboxFileToLiveRecipient` only if the service test proves it reaches the live member without the old lead-relay loop.

2. **OpenCode-only rollout first** - 🎯 7 🛡️ 8 🧠 3, 40-80 LOC  
   Safe and fast, but it does not fix the live Anthropic/Alice incident. Use only as an incremental rollout, not as the final answer.

3. **Re-enable old `relayMemberInboxMessages` for native** - 🎯 4 🛡️ 4 🧠 5, 60-140 LOC  
   Not recommended. The code comment says this path caused lead misrouting, duplicate messages, and relay loops.

Required behavior:

- work-sync may insert an inbox row for Anthropic;
- review pickup bypass may dispatch only when delivery capability is available;
- if capability is missing, do not create a member nudge outbox row; audit `review_pickup_delivery_unavailable` and surface lead diagnostic instead of pretending the member was corrected;
- if capability exists but provider delivery fails, keep the outbox retryable, because the persisted inbox row alone is not enough for review pickup;
- if provider delivery is fire-and-forget only, treat it as not capable for review pickup until there is a follow-up result path;
- do not assume inbox insertion alone is enough.

Implementation gate:

```text
Before enabling Anthropic review pickup bypass, add a service or live-smoke test proving that member_work_sync_nudge reaches an active Anthropic/native member path.
```

### 12.19 Native delivery marked read but not semantically processed

Some delivery paths can verify "row written" or "prompt sent" without proving the member called a review tool. That is okay only if the task state remains the source of truth.

Expected:

- delivery proof can mark an outbox item delivered;
- delivery proof must not clear `review_pickup_required`;
- only `review_start`, `review_approve`, `review_request_changes`, or a short `member_work_sync_report` lease can change the next status decision;
- ignored delivered nudges escalate to lead.

### 12.20 Multiple review items in one agenda

If reviewer has multiple pending review pickups:

- one nudge can list all current review pickups;
- idempotency by full agenda fingerprint still works;
- one-shot marker should be per `(member, reviewRequestEventId)`, not per whole agenda, otherwise adding a second review can accidentally unlock another nudge for the first.

### 12.21 Fingerprint churn

Changing subject, display id, or evidence can change the fingerprint. The bypass must still respect `blocking_metrics` when churn is high.

Potential mitigation:

- keep review pickup evidence minimal and stable;
- do not include non-essential timestamps beyond cycle timestamps;
- keep generatedAt out of fingerprint, as current code already does.

### 12.22 Clock skew or malformed timestamps

Expected:

- event sort should preserve file order as fallback when timestamps are invalid or equal;
- `reviewCycleId` should prefer event id, not timestamp;
- malformed timestamps should not create duplicate cycles if event id exists.

### 12.23 `review_started` actor missing or mismatched

History:

```text
review_requested alice
review_started actor missing
```

or:

```text
review_requested alice
review_started bob
```

Expected:

- do not use this as a normal review pickup bypass case;
- add diagnostics such as `review_started_actor_missing` or `review_started_by_different_member`;
- avoid repeatedly nudging Alice if evidence suggests the task lifecycle is corrupted;
- escalate to lead if the review remains stuck.

### 12.24 Kanban/workflow mismatch in task impact routing

State:

```text
kanban column = review
task.reviewState missing or stale
kanban reviewer = alice
```

Expected:

- full agenda and task-impact resolver both route Alice;
- resolver input must use kanban-aware `taskWorkflowColumn`, not raw `task.reviewState`;
- test this explicitly because otherwise the bug only appears in incremental updates.

---

## 13. Implementation Plan

### Phase 0 - Provider delivery capability gate

Files:

```text
src/features/member-work-sync/core/application/ports.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/main/composition/createMemberWorkSyncFeature.ts
src/main/index.ts
src/main/services/team/TeamProvisioningService.ts
test/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.test.ts
test/main/services/team/TeamProvisioningServiceRelay.test.ts
```

Changes:

- add a way for work-sync to ask whether a review-pickup nudge can wake this provider/member path;
- keep existing OpenCode wake behavior;
- add or prove a narrow native delivery outcome path before enabling Anthropic/Codex/Gemini review pickup bypass;
- audit `review_pickup_delivery_unavailable` when detection works but prompt delivery is not safe;
- classify capability failures as absent vs temporarily failed;
- do not re-enable the old lead relay path without new tests covering the bugs listed in `src/main/ipc/teams.ts`.

Recommended API shape:

```ts
export interface MemberWorkSyncNudgeDeliveryWakePort {
  canWake?(input: {
    teamName: string;
    memberName: string;
    providerId?: MemberWorkSyncProviderId | null;
    messageKind: 'member_work_sync_nudge';
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
  }): Promise<boolean> | boolean;

  schedule(input: {
    teamName: string;
    memberName: string;
    messageId: string;
    providerId?: MemberWorkSyncProviderId | null;
    reason: 'member_work_sync_nudge_inserted' | 'member_work_sync_nudge_existing';
    delayMs?: number;
    workSyncIntent?: 'agenda_sync' | 'review_pickup';
  }): Promise<void> | void;
}
```

Important: this existing wake-style API is not sufficient by itself for review pickup. Either extend it with a delivery outcome callback/result, or introduce a separate `MemberWorkSyncReviewPickupDeliveryPort` as described above.

### Phase 1 - Strict review cycle domain

Files:

```text
src/features/member-work-sync/core/domain/currentReviewCycle.ts
test/features/member-work-sync/core/ActionableWorkAgenda.test.ts
agent-teams-controller/test/controller.test.js
test/main/services/team/stallMonitor/TeamTaskStallPolicy.test.ts
```

Changes:

- add `resolveCurrentReviewCycle`;
- keep `resolveCurrentReviewOwner` as compatibility wrapper or replace its callers;
- model boundaries matching controller logic;
- expose `reviewObligation`, `canBypassPhase2`, and diagnostics;
- add shared lifecycle fixture tables and run equivalent cases against work-sync, controller agenda, and stall monitor where practical.

Compatibility wrapper:

```ts
export function resolveCurrentReviewOwner(input: {
  reviewState?: string | null;
  kanbanReviewer?: string | null;
  historyEvents?: ReviewHistoryEventLike[];
}): CurrentReviewOwner | null {
  const cycle = resolveCurrentReviewCycle(input);
  return cycle
    ? {
        reviewer: cycle.reviewer,
        historyEventIds: cycle.historyEventIds,
      }
    : null;
}
```

Do not ship this phase if repeated `review_requested` still keeps an older `review_started`. That is the exact Alice failure.

### Phase 2 - Agenda evidence and fingerprint

Files:

```text
src/features/member-work-sync/contracts/types.ts
src/features/member-work-sync/core/domain/ActionableWorkAgenda.ts
src/features/member-work-sync/core/domain/AgendaFingerprint.ts
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTaskImpactResolver.ts
test/features/member-work-sync/main/adapters/input/MemberWorkSyncTaskImpactResolver.test.ts
```

Changes:

- add review evidence fields;
- include fields in fingerprint through existing evidence copy;
- add diagnostics for legacy reviewer fallback.
- fix task-impact routing to pass kanban-aware `taskWorkflowColumn` into the review-cycle resolver.

Example:

```ts
const reviewCycle = isReviewWorkflow
  ? resolveCurrentReviewCycle({
      reviewState: workflowColumn,
      kanbanReviewer: input.kanbanReviewersByTaskId?.[task.id] ?? null,
      historyEvents: task.historyEvents,
    })
  : null;

if (reviewCycle && sameMemberName(reviewCycle.reviewer, memberName)) {
  items.push({
    ...base,
    kind: 'review',
    priority: 'review_requested',
    reason: 'current_cycle_review_assigned',
    evidence: {
      status: task.status,
      ...(owner ? { owner } : {}),
      reviewer: memberName,
      ...(task.reviewState ? { reviewState: task.reviewState } : {}),
      reviewObligation: reviewCycle.obligation,
      reviewCycleId: reviewCycle.reviewCycleId,
      reviewRequestEventId: reviewCycle.requestEventId,
      reviewRequestedAt: reviewCycle.requestedAt,
      ...(reviewCycle.startedEventId ? { reviewStartedEventId: reviewCycle.startedEventId } : {}),
      ...(reviewCycle.startedAt ? { reviewStartedAt: reviewCycle.startedAt } : {}),
      ...(reviewCycle.startedBy ? { reviewStartedBy: reviewCycle.startedBy } : {}),
      canBypassPhase2: reviewCycle.canBypassPhase2,
      ...(reviewCycle.diagnostics.length > 0 ? { reviewDiagnostics: reviewCycle.diagnostics } : {}),
      ...(reviewCycle.historyEventIds.length > 0
        ? { historyEventIds: reviewCycle.historyEventIds }
        : {}),
    },
  });
}
```

### Phase 3 - Review-specific activation

Files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner.ts
test/features/member-work-sync/core/application/MemberWorkSyncNudgeActivationPolicy.test.ts
```

Changes:

- add activation reason `review_pickup_required`;
- add activation/audit reason `review_pickup_delivery_unavailable`;
- allow bypass only if all nudgeable items are requested-only review pickups;
- keep blocking metrics guard first;
- require delivery capability before planning or dispatching non-OpenCode review pickup nudges;
- do not create a member outbox row for permanent capability absence.

### Phase 4 - Review-specific payload and metadata

Files:

```text
src/features/member-work-sync/core/domain/MemberWorkSyncNudge.ts
src/features/member-work-sync/contracts/types.ts
src/features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink.ts
src/shared/types/team.ts
src/main/services/team/TeamInboxWriter.ts
src/main/services/team/TeamInboxReader.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Changes:

- detect review pickup agenda;
- build review-specific text;
- keep generic text for normal work-sync agendas;
- persist `workSyncIntent`, `workSyncIntentKey`, and review request ids through inbox read/write;
- make payload hash include metadata so payload conflicts are real.

### Phase 5 - Runtime wrapper and delivery outcome update

Files:

```text
src/main/services/team/runtime/OpenCodeTeamRuntimeAdapter.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryLedger.ts
src/main/services/team/opencode/delivery/OpenCodePromptDeliveryRepairPolicy.ts
src/main/services/team/TeamProvisioningService.ts
test/main/services/team/OpenCodeTeamRuntimeAdapter.test.ts
test/main/services/team/TeamProvisioningServiceRelay.test.ts
```

Changes:

- detect review pickup nudge by payload metadata, with text fallback only for legacy rows;
- explain `review_start` as required domain action;
- preserve metadata in OpenCode delivery ledger records;
- for review-pickup, record `prompt_accepted` or `response_proven` before marking the member outbox terminal delivered;
- fire-and-forget watchdog scheduling is not enough for terminal delivered;
- provider delivery failure after inbox insertion must become retryable, not terminal delivered;
- add native delivery outcome only if a focused test proves it reaches live member input without the disabled lead relay bugs.

### Phase 6 - Short lease and one-shot marker

Files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncReportValidator.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncOutboxStore.ts
test/features/member-work-sync/core/MemberWorkSyncUseCases.test.ts
```

Changes:

- default `still_working` lease for review pickup to 3 minutes;
- cap requested review-pickup lease at 10 minutes;
- add one-shot member nudge marker keyed by `(teamName, memberName, reviewRequestEventId)`;
- write one-shot marker only after `prompt_accepted` or `response_proven`;
- never use full agenda fingerprint as the only one-shot key.

```text
if delivered member nudge exists for same reviewRequestEventId:
  do not deliver second member nudge
  plan lead escalation
```

### Phase 7 - Queue, startup scan, and planning coverage

Files:

```text
src/features/member-work-sync/main/adapters/input/MemberWorkSyncTeamChangeRouter.ts
src/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.ts
src/features/member-work-sync/core/application/MemberWorkSyncDiagnosticsReader.ts
src/features/member-work-sync/core/application/MemberWorkSyncReconciler.ts
src/features/member-work-sync/core/application/MemberWorkSyncNudgeOutboxPlanner.ts
test/features/member-work-sync/main/adapters/input/MemberWorkSyncTeamChangeRouter.test.ts
test/features/member-work-sync/main/infrastructure/MemberWorkSyncEventQueue.test.ts
```

Why this phase exists:

```text
outbox planning happens only during queue reconciliation
manual status reads do not plan nudges
startup scan is the recovery path after app restart
task_changed routing must include reviewer, owner, and lead fallback correctly
getStatus may return persisted status and must expose staleness
```

Required changes/tests:

- preserve the existing queue-only planning model, but document it in diagnostics;
- after app restart, startup scan must enqueue active members and then dispatch due review-pickup nudges;
- if task impact resolver cannot parse the task id, fallback team-wide must still include the reviewer;
- if a queue item is dropped because team is inactive, startup/member-spawn/turn-settled must be enough to re-evaluate later;
- planner should preserve actual activation reason. Do not collapse `review_pickup_delivery_unavailable`, `blocking_metrics`, and `phase2_not_ready` into the same audit code.
- `getStatus` should not silently return an old pre-restart snapshot as if it were fresh;
- stale `getStatus` should enqueue queue reconciliation or show explicit diagnostics without directly planning an outbox row from the read path.

### Phase 8 - Lead escalation

Files:

```text
src/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.ts
src/features/member-work-sync/main/adapters/output/TeamInboxMemberWorkSyncNudgeSink.ts
src/main/services/team/TeamDataService.ts
test/features/member-work-sync/core/application/MemberWorkSyncNudgeDispatcher.test.ts
```

Possible implementation:

- new audit event `review_pickup_escalated`;
- use existing lead system notification path;
- only after one member nudge was delivered and the same `reviewRequestEventId` still has pickup obligation after lease expiry or next turn-settled.
- also escalate when delivery capability is absent, because there is no member prompt path to wait for.

This phase is required for the non-spam reliability goal. Without it, the first ignored correction can still leave the review stuck silently.

---

## 14. Test Plan

### 14.1 Domain tests

Add tests for `resolveCurrentReviewCycle`:

```ts
it('returns pickup required for latest requested-only review cycle', () => {});
it('does not reuse review_started before status reset', () => {});
it('returns in-progress when review_started follows current review_requested', () => {});
it('returns null after review_approved', () => {});
it('returns null after review_changes_requested', () => {});
it('falls back to kanban reviewer without phase bypass evidence', () => {});
it('uses event id as stable cycle id when timestamps are duplicated', () => {});
it('uses latest review_requested when two requests exist in one open window', () => {});
it('does not phase-bypass when review_started actor is missing', () => {});
it('diagnoses review_started by a different member', () => {});
it('uses later valid review_started even after earlier malformed started event', () => {});
```

### 14.2 Agenda tests

Add or update `ActionableWorkAgenda.test.ts`:

```ts
it('marks requested-only review agenda with review_pickup_required', () => {});
it('marks started review agenda with review_in_progress', () => {});
it('keeps old review_started out of reopened review cycle evidence', () => {});
it('moves review obligation from alice to bob when reviewer changes', () => {});
it('does not create owner work while task is in review workflow', () => {});
it('sets canBypassPhase2 only for requested-only cycles with concrete event id', () => {});
it('carries review diagnostics into evidence without making them nudgeable', () => {});
```

### 14.2.1 Task impact routing tests

Add tests for `MemberWorkSyncTaskImpactResolver`:

```ts
it('routes kanban review reviewer when task.reviewState is stale', () => {});
it('routes lead when review workflow has no resolvable reviewer', () => {});
it('does not route old reviewer after a newer review_requested assigns another member', () => {});
```

### 14.3 Activation tests

Add tests:

```ts
it('activates review pickup nudges while phase2 is collecting', () => {});
it('does not activate review pickup when blocking metrics are present', () => {});
it('does not dispatch review pickup when delivery capability is unavailable', () => {});
it('does not activate started-review nudges through review pickup bypass', () => {});
it('does not activate legacy kanban-only review through review pickup bypass', () => {});
it('keeps existing OpenCode targeted behavior', () => {});
```

### 14.4 Payload tests

Add tests:

```ts
it('builds review pickup nudge with review_start instructions', () => {});
it('says member_work_sync_report does not start or finish review', () => {});
it('keeps generic nudge for work agenda', () => {});
it('persists workSyncIntent and reviewRequestEventIds through inbox write/read', () => {});
it('uses structured review pickup metadata in payload hash', () => {});
```

### 14.5 Use case tests

Add tests in `MemberWorkSyncUseCases.test.ts`:

```ts
it('plans OpenCode review pickup while phase2 is collecting', async () => {});
it('skips Anthropic review pickup when no native delivery outcome is configured', async () => {});
it('plans Anthropic review pickup only when native delivery outcome capability is configured', async () => {});
it('supersedes review pickup nudge when review_start appears before dispatch', async () => {});
it('does not dispatch review pickup nudge while member is busy', async () => {});
it('keeps review pickup retryable when provider delivery fails after inbox insertion', async () => {});
it('does not mark review pickup delivered only because fire-and-forget wake was scheduled', async () => {});
it('marks review pickup delivered only after prompt_accepted or response_proven', async () => {});
it('does not write one-shot marker when only inbox insertion succeeded', async () => {});
it('does not write one-shot marker when only fire-and-forget wake was scheduled', async () => {});
it('does not dispatch duplicate member nudge for same reviewRequestEventId after fingerprint churn', async () => {});
it('escalates to lead when same reviewRequestEventId remains stuck after one delivered member nudge', async () => {});
it('shortens still_working lease for review pickup agenda', async () => {});
```

### 14.6 Feature integration tests

Add tests in `createMemberWorkSyncFeature.test.ts`:

```ts
it('audits delivery unavailable for Anthropic/native when delivery outcome capability is absent', async () => {});
it('delivers review pickup through real outbox and provider wake when capability is configured', async () => {});
it('retries provider delivery using the existing inbox row after restart before markDelivered', async () => {});
it('revalidates and supersedes when the task is approved before dispatch', async () => {});
it('keeps team inactive review pickup nudges undelivered', async () => {});
```

### 14.7 OpenCode wrapper tests

Add tests:

```ts
it('sends review pickup work-sync nudges with review_start oriented instructions', async () => {});
it('does not say report alone starts or finishes review', async () => {});
it('detects review pickup by structured workSyncIntent before text fallback', async () => {});
```

### 14.8 Cross-component lifecycle fixture tests

Use one shared table of history shapes for:

```text
work-sync currentReviewCycle
agent-teams-controller agenda reviewer resolution
stall monitor review window handling
renderer review timer fallback, if practical
```

Minimum fixture rows:

```text
requested only
requested -> started
requested -> started -> approved
requested -> started -> in_progress -> completed -> requested
requested alice -> requested bob
requested alice -> started bob
requested alice -> started missing actor
duplicate timestamps with stable event order
```

### 14.9 Queue and restart tests

Add tests:

```ts
it('plans review pickup during queue reconciliation but not during manual status read', async () => {});
it('startup scan after app restart plans stuck review pickup before UI relies on stale status', async () => {});
it('getStatus marks old persisted review pickup status stale after restart', async () => {});
it('getStatus enqueues refresh for stale persisted status without planning outbox directly', async () => {});
it('falls back team-wide when task change detail cannot be parsed', async () => {});
it('preserves review_pickup_delivery_unavailable in planner audit reason', async () => {});
it('re-enqueues after inactive-team drop once member_spawned or turn_settled arrives', async () => {});
```

---

## 15. Debugging Flow After Implementation

When a review seems stuck:

```bash
jq '.status | {state, providerId, diagnostics, shadow, agenda: .agenda.items}' \
  ~/.claude/teams/<team>/members/<member>/.member-work-sync/status.json
```

Expected stuck pickup:

```json
{
  "state": "needs_sync",
  "agenda": [
    {
      "kind": "review",
      "evidence": {
        "reviewObligation": "review_pickup_required",
        "reviewRequestEventId": "..."
      }
    }
  ]
}
```

Then inspect audit:

```bash
tail -n 80 ~/.claude/teams/<team>/members/<member>/.member-work-sync/journal.jsonl
```

Useful events:

```text
agenda_loaded
decision_made
nudge_planned
nudge_delivered
nudge_skipped
nudge_superseded
member_busy
team_inactive
review_pickup_delivery_unavailable
review_pickup_wake_failed_retryable
review_pickup_member_nudge_delivered
review_pickup_escalated
```

Expected after successful pickup:

```text
task history contains review_started after latest review_requested
work-sync agenda either changes to review_in_progress or remains still_working only while leased
member card shows reviewing timer from reviewIntervals or current review_started fallback
```

If status remains stale after app restart, inspect queue diagnostics:

```bash
jq '.status.shadow, .status.diagnostics' \
  ~/.claude/teams/<team>/members/<member>/.member-work-sync/status.json
```

Expected startup recovery path:

```text
startup_scan -> queue_reconciled -> nudge_planned -> provider delivery outcome
```

If the journal shows only manual `reconcile_started` from UI reads, that is not enough. Outbox planning should happen from queue reconciliation or an explicit queue-triggered repair.

---

## 16. Rollout Notes

Recommended rollout:

1. Ship strict cycle resolver, agenda evidence, and task-impact routing fix first with bypass disabled.
2. Ship structured payload metadata and wrapper tests.
3. Enable OpenCode review pickup bypass first only through an outcome-returning relay/ledger path.
4. Enable Anthropic/Codex/Gemini only after delivery capability tests pass for that provider path.
5. Keep generic Phase 2 behavior unchanged.
6. Observe audit journals for:
   - nudge volume;
   - repeated fingerprints;
   - `review_pickup_delivery_unavailable`;
   - `review_pickup_escalated`;
   - report rejection rate;
   - stale fingerprint supersedes.

Do not enable broad Anthropic/Codex/Gemini nudges as part of this. The bypass should be limited to:

```text
review_pickup_required
```

Anthropic/native rollout gate:

```text
provider review pickup bypass = disabled unless member_work_sync_nudge wake is proven for that provider path
```

---

## 17. Acceptance Criteria

The implementation is correct when:

- A latest requested-only review creates `review_pickup_required`.
- A current-cycle `review_started` changes obligation to `review_in_progress`.
- Old `review_started` events before status reset do not affect the latest cycle.
- Repeated `review_requested` uses the latest request and does not inherit old started evidence.
- Generic work-sync Phase 2 readiness remains unchanged.
- Requested-only review pickup can nudge OpenCode while phase2 is collecting.
- Requested-only review pickup can nudge Anthropic/native only when delivery outcome capability is implemented and tested.
- If native delivery capability is unavailable, the system audits/escalates instead of silently claiming repair.
- A review-pickup outbox row is not terminal `delivered` until provider outcome is `prompt_accepted` or `response_proven`.
- Fire-and-forget wake scheduling alone does not write `delivered` or one-shot marker.
- Provider delivery failure after inbox insertion is retryable and reuses the existing message id.
- Started reviews do not use pickup bypass.
- `still_working` leases review pickup briefly but does not clear the obligation forever.
- Dispatch revalidates and supersedes stale outbox rows.
- The member is not nudged while busy or team inactive.
- Repeated reconciles do not duplicate inbox messages for the same `reviewRequestEventId`, even if agenda fingerprint changes.
- A persisted one-shot marker prevents repeated member nudges for the same review request.
- One-shot marker is written only after the stronger review-pickup delivery definition is met.
- Lead escalation is emitted when a delivered review pickup nudge is ignored and the same review request remains stuck.
- OpenCode delivery text does not imply that report alone starts or finishes review.
- Structured `workSyncIntent` metadata survives inbox write/read and runtime delivery.
- Startup scan after restart can plan review pickup even when no new task event arrives.
- Stored `getStatus` snapshots expose staleness and enqueue reconciliation instead of silently looking fresh.
- Planner audit preserves exact skip reason, including delivery unavailable vs phase2 not ready.

---

## 18. Final Recommendation

Implement the review pickup path as a narrow obligation in work-sync, not as a separate watchdog.

The safest version is:

```text
strict current review cycle
+ review_pickup_required agenda evidence
+ task-impact routing uses kanban-aware workflow state
+ provider delivery capability gate
+ delivered means prompt_accepted/response_proven, not inbox inserted or watchdog scheduled
+ review-specific Phase 2 activation bypass
+ structured review-specific nudge metadata and text
+ short still_working lease
+ one member nudge per reviewRequestEventId
+ lead escalation if still stuck
```

This directly fixes the Alice class of failures only when the provider delivery gate and delivery outcome model are included. Without those, the plan would detect the stuck review but could still fail to prompt the live Anthropic member or falsely mark a scheduled wake as delivered. The full version keeps spam risk low because it stays inside the existing work-sync outbox, revalidation, busy-signal, cooldown, and rate-limit machinery, then escalates to lead instead of repeatedly poking the reviewer.
