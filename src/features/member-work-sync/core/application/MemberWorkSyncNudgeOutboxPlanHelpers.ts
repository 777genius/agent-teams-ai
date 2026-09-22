import { hasActiveAcceptedWorkLease, parseTime } from './MemberWorkSyncNudgeRecoveryPolicy';

import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';

export const STATUS_ONLY_RECOVERY_INTENT_PREFIX = 'status-only';
export const AGENDA_SYNC_REFRESH_INTENT_PREFIX = 'agenda-sync-refresh';
export const DELIVERED_STILL_STUCK_RECOVERY_INTENT_PREFIX = 'agenda-sync-still-stuck';
export const TASK_PROTOCOL_REPAIR_INTENT_PREFIX = 'task-protocol-repair';
export const EARLY_CONTINUATION_INTENT_PREFIX = 'early-continuation';

export const DELIVERED_STILL_STUCK_RECOVERY_BUCKET_MS = 30 * 60_000;
export const DELIVERED_STILL_STUCK_RECOVERY_DELIVERY_WINDOW_MS = 60 * 60_000;
export const DELIVERED_STILL_STUCK_RECOVERY_MAX_DELIVERED_PER_WINDOW = 2;
export const TASK_PROTOCOL_REPAIR_DELIVERY_WINDOW_MS = 60 * 60_000;
export const TASK_PROTOCOL_REPAIR_MAX_DELIVERED_PER_WINDOW = 2;

export function getReviewRequestEventIds(status: MemberWorkSyncStatus): string[] {
  return [
    ...new Set(
      status.agenda.items
        .map((item) => item.evidence.reviewRequestEventId?.trim())
        .filter((id): id is string => Boolean(id))
    ),
  ].sort();
}

export function filterReviewPickupStatusByRequestIds(
  status: MemberWorkSyncStatus,
  reviewRequestEventIds: string[]
): MemberWorkSyncStatus {
  const allowed = new Set(reviewRequestEventIds);
  return {
    ...status,
    agenda: {
      ...status.agenda,
      items: status.agenda.items.filter((item) => {
        const eventId = item.evidence.reviewRequestEventId?.trim();
        return eventId ? allowed.has(eventId) : false;
      }),
    },
  };
}

export function isTurnSettledReconcile(status: MemberWorkSyncStatus): boolean {
  return status.shadow?.triggerReasons?.includes('turn_settled') === true;
}

export function shouldPlanStatusOnlyRecovery(input: {
  status: MemberWorkSyncStatus;
  baseInput: MemberWorkSyncOutboxEnsureInput;
  existingItemStatus: string;
}): boolean {
  return (
    input.status.state === 'needs_sync' &&
    input.status.shadow?.wouldNudge === true &&
    isTurnSettledReconcile(input.status) &&
    input.baseInput.payload.workSyncIntent === 'agenda_sync' &&
    input.baseInput.payload.workSyncIntentKey === undefined &&
    input.existingItemStatus === 'delivered' &&
    !hasActiveAcceptedWorkLease(input.status)
  );
}

export function shouldPlanAgendaSyncRefreshRecovery(input: {
  status: MemberWorkSyncStatus;
  baseInput: MemberWorkSyncOutboxEnsureInput;
  existingItem: { agendaFingerprint: string; status: string };
}): boolean {
  return (
    input.status.state === 'needs_sync' &&
    input.status.shadow?.wouldNudge === true &&
    input.baseInput.payload.workSyncIntent === 'agenda_sync' &&
    input.baseInput.payload.workSyncIntentKey === undefined &&
    input.existingItem.status === 'delivered' &&
    input.existingItem.agendaFingerprint === input.baseInput.agendaFingerprint &&
    !hasActiveAcceptedWorkLease(input.status)
  );
}

export function shouldRepairDeliveredAgendaSyncNudge(input: {
  status: MemberWorkSyncStatus;
  requestedInput: MemberWorkSyncOutboxEnsureInput;
  existingItem: MemberWorkSyncOutboxItem;
}): boolean {
  return (
    input.status.state === 'needs_sync' &&
    input.requestedInput.payload.workSyncIntent === 'agenda_sync' &&
    input.existingItem.status === 'delivered' &&
    input.existingItem.agendaFingerprint === input.requestedInput.agendaFingerprint &&
    input.existingItem.payloadHash === input.requestedInput.payloadHash &&
    !hasActiveAcceptedWorkLease(input.status)
  );
}

export function isOutboxItemAwaitingDelivery(item: MemberWorkSyncOutboxItem): boolean {
  return item.status !== 'delivered' && item.status !== 'failed_terminal';
}

export function getDeliveredStillStuckRecoveryBucket(status: MemberWorkSyncStatus): string | null {
  const evaluatedAtMs = parseTime(status.evaluatedAt);
  if (evaluatedAtMs == null) {
    return null;
  }
  const bucketMs =
    Math.floor(evaluatedAtMs / DELIVERED_STILL_STUCK_RECOVERY_BUCKET_MS) *
    DELIVERED_STILL_STUCK_RECOVERY_BUCKET_MS;
  return new Date(bucketMs).toISOString();
}

export function getTaskProtocolRepairTaskIds(status: MemberWorkSyncStatus): string[] {
  return [
    ...new Set(
      status.agenda.items
        .filter(
          (item) =>
            item.kind === 'work' &&
            item.reason === 'owned_in_progress_task' &&
            item.evidence.status === 'in_progress'
        )
        .map((item) => item.taskId)
        .filter(Boolean)
    ),
  ].sort();
}

export function isMemberWorkSyncRecoveryAllocationEnabled(deps: {
  recoveryAllocation?: { enabled: boolean };
  recoveryProtocol?: { version: number };
}): boolean {
  if (deps.recoveryAllocation) {
    return deps.recoveryAllocation.enabled === true;
  }
  return (deps.recoveryProtocol?.version ?? 0) >= 1;
}
