import type {
  MemberWorkSyncOutboxEnsureInput,
  MemberWorkSyncOutboxItem,
  MemberWorkSyncStatus,
} from '../../contracts';
import type { MemberWorkSyncNudgeActivationReason } from './MemberWorkSyncNudgeActivationPolicy';

const DELIVERED_STILL_STUCK_RECOVERY_MIN_AGE_MS = 6 * 60_000;

export function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

export function hasActiveAcceptedWorkLease(status: MemberWorkSyncStatus): boolean {
  const report = status.report;
  if (
    report?.accepted !== true ||
    report.agendaFingerprint !== status.agenda.fingerprint ||
    (report.state !== 'still_working' && report.state !== 'blocked')
  ) {
    return false;
  }

  const evaluatedAtMs = parseTime(status.evaluatedAt);
  const expiresAtMs = parseTime(report.expiresAt);
  return evaluatedAtMs != null && expiresAtMs != null && expiresAtMs > evaluatedAtMs;
}

function isDeliveredStillStuckRecoveryReason(reason: MemberWorkSyncNudgeActivationReason): boolean {
  return (
    reason === 'shadow_ready' ||
    reason === 'native_stale_in_progress' ||
    reason === 'native_stale_assigned_work' ||
    reason === 'opencode_targeted_shadow_collecting' ||
    reason === 'lead_targeted_shadow_collecting' ||
    reason === 'native_targeted_shadow_collecting'
  );
}

export function shouldPlanDeliveredStillStuckRecovery(input: {
  status: MemberWorkSyncStatus;
  baseInput: MemberWorkSyncOutboxEnsureInput;
  existingItem: MemberWorkSyncOutboxItem;
  activationReason: MemberWorkSyncNudgeActivationReason;
}): boolean {
  const recoverableExistingItem =
    input.existingItem.status === 'delivered' ||
    (input.existingItem.status === 'failed_terminal' &&
      input.existingItem.lastError === 'inbox_payload_conflict');

  if (
    input.status.state !== 'needs_sync' ||
    input.status.shadow?.wouldNudge !== true ||
    input.baseInput.payload.workSyncIntent !== 'agenda_sync' ||
    input.baseInput.payload.workSyncIntentKey !== undefined ||
    !recoverableExistingItem ||
    input.existingItem.agendaFingerprint !== input.baseInput.agendaFingerprint ||
    hasActiveAcceptedWorkLease(input.status) ||
    !isDeliveredStillStuckRecoveryReason(input.activationReason)
  ) {
    return false;
  }

  const deliveredAtMs = parseTime(input.existingItem.updatedAt);
  const evaluatedAtMs = parseTime(input.status.evaluatedAt);
  return (
    deliveredAtMs != null &&
    evaluatedAtMs != null &&
    evaluatedAtMs - deliveredAtMs >= DELIVERED_STILL_STUCK_RECOVERY_MIN_AGE_MS
  );
}
