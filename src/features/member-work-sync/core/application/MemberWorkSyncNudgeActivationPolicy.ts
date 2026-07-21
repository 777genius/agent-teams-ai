import { isStrictReviewPickupItem } from './MemberWorkSyncNudgeAgendaPredicates';
import {
  MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC,
  MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX,
} from './MemberWorkSyncRuntimeStallDiagnostics';
import {
  decideMemberWorkSyncTargetedRecovery,
  type MemberWorkSyncTargetedRecoveryReason,
} from './MemberWorkSyncTargetedRecoveryPolicy';

import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '../../contracts';

export type MemberWorkSyncNudgeActivationReason =
  | 'shadow_ready'
  | MemberWorkSyncTargetedRecoveryReason
  | 'review_pickup_required'
  | 'native_task_protocol_repair'
  | 'native_stale_in_progress'
  | 'native_stale_assigned_work'
  | 'status_not_nudgeable'
  | 'blocking_metrics'
  | 'delivery_not_ready';

const NATIVE_STALE_IN_PROGRESS_MIN_AGE_MS = 6 * 60_000;
const NATIVE_STALE_IN_PROGRESS_PROVIDERS = new Set(['anthropic', 'codex', 'gemini']);
const NATIVE_TASK_PROTOCOL_REPAIR_PROVIDERS = new Set(['codex']);
const NATIVE_TASK_PROTOCOL_REPAIR_TURN_SETTLED_DIAGNOSTIC = `${MEMBER_WORK_SYNC_RUNTIME_STALL_TRIGGER_DIAGNOSTIC_PREFIX}turn_settled`;

export interface MemberWorkSyncNudgeActivationDecision {
  active: boolean;
  reason: MemberWorkSyncNudgeActivationReason;
}

// Would-nudge and fingerprint churn are intentionally diagnostic-only here.
// A stalled member emits another would-nudge sample on each reconcile, while
// legitimate board changes create fingerprint samples. Using either team-wide
// rate to suppress recovery locks out the members that currently need syncing.
// Actual deliveries remain bounded by per-fingerprint outbox idempotency,
// dispatcher rate limits, busy checks, and cooldowns.
const DELIVERY_READINESS_BLOCKING_REASONS = new Set(['report_rejection_rate_high']);

function hasBlockingMetrics(metrics: MemberWorkSyncTeamMetrics): boolean {
  return metrics.deliveryReadiness.reasons.some((reason) =>
    DELIVERY_READINESS_BLOCKING_REASONS.has(reason)
  );
}

function normalizeMemberName(value: string): string {
  return value.trim().toLowerCase();
}

function isLeadLikeMemberName(memberName: string): boolean {
  const normalized = normalizeMemberName(memberName).replace(/[\s_]+/g, '-');
  return (
    normalized === 'lead' ||
    normalized === 'team-lead' ||
    normalized === 'teamlead' ||
    normalized === 'team-leader'
  );
}

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function hasActiveAcceptedWorkLease(status: MemberWorkSyncStatus): boolean {
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

function hasNoCurrentAcceptedWorkProof(status: MemberWorkSyncStatus): boolean {
  return (
    status.diagnostics.includes('no_current_report') ||
    status.diagnostics.includes('report_lease_missing') ||
    status.diagnostics.includes('report_lease_expired') ||
    status.diagnostics.includes('report_fingerprint_stale')
  );
}

function eventsForMember(
  status: MemberWorkSyncStatus,
  metrics: MemberWorkSyncTeamMetrics
): MemberWorkSyncMetricEvent[] {
  const memberName = normalizeMemberName(status.memberName);
  return metrics.recentEvents
    .filter((event) => normalizeMemberName(event.memberName) === memberName)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

function isDifferentFingerprintBoundary(
  event: MemberWorkSyncMetricEvent,
  currentFingerprint: string
): boolean {
  if (event.agendaFingerprint !== currentFingerprint) {
    return true;
  }
  return (
    event.kind === 'fingerprint_changed' &&
    event.previousFingerprint !== undefined &&
    event.previousFingerprint !== currentFingerprint
  );
}

function getCurrentFingerprintStableSinceMs(
  status: MemberWorkSyncStatus,
  metrics: MemberWorkSyncTeamMetrics,
  nowMs: number
): number | null {
  const currentFingerprint = status.agenda.fingerprint;
  const memberEvents = eventsForMember(status, metrics).filter((event) => {
    const recordedAt = parseTime(event.recordedAt);
    return recordedAt != null && recordedAt <= nowMs;
  });
  let latestDifferentFingerprintMs = Number.NEGATIVE_INFINITY;
  let latestAcceptedReportMs = Number.NEGATIVE_INFINITY;
  for (const event of memberEvents) {
    const recordedAt = parseTime(event.recordedAt);
    if (recordedAt != null && isDifferentFingerprintBoundary(event, currentFingerprint)) {
      latestDifferentFingerprintMs = Math.max(latestDifferentFingerprintMs, recordedAt);
    }
    if (
      recordedAt != null &&
      event.kind === 'report_accepted' &&
      event.agendaFingerprint === currentFingerprint
    ) {
      latestAcceptedReportMs = Math.max(latestAcceptedReportMs, recordedAt);
    }
  }

  const currentNeedsSyncEventTimes = memberEvents.flatMap((event) => {
    const recordedAt = parseTime(event.recordedAt);
    return event.kind === 'status_evaluated' &&
      event.state === 'needs_sync' &&
      event.agendaFingerprint === currentFingerprint &&
      recordedAt != null &&
      recordedAt >= latestDifferentFingerprintMs &&
      recordedAt > latestAcceptedReportMs
      ? [recordedAt]
      : [];
  });

  return currentNeedsSyncEventTimes.length > 0 ? Math.min(...currentNeedsSyncEventTimes) : null;
}

function isNativeStaleWorkItem(status: MemberWorkSyncStatus['agenda']['items'][number]): boolean {
  return (
    status.kind === 'work' &&
    ((status.reason === 'owned_in_progress_task' && status.evidence.status === 'in_progress') ||
      (status.reason === 'owned_pending_task' && status.evidence.status === 'pending'))
  );
}

function isNativeStaleEligibleItem(
  status: MemberWorkSyncStatus['agenda']['items'][number]
): boolean {
  return isNativeStaleWorkItem(status) || isStrictReviewPickupItem(status);
}

function isOwnedInProgressWorkItem(
  status: MemberWorkSyncStatus['agenda']['items'][number]
): boolean {
  return (
    status.kind === 'work' &&
    status.reason === 'owned_in_progress_task' &&
    status.evidence.status === 'in_progress'
  );
}

function hasNativeTaskProtocolRepairTurnSignal(status: MemberWorkSyncStatus): boolean {
  const diagnostics = new Set(status.diagnostics);
  return (
    diagnostics.has(MEMBER_WORK_SYNC_RUNTIME_STALL_DIAGNOSTIC) &&
    diagnostics.has(NATIVE_TASK_PROTOCOL_REPAIR_TURN_SETTLED_DIAGNOSTIC)
  );
}

function shouldActivateNativeTaskProtocolRepair(input: {
  status: MemberWorkSyncStatus;
  metrics: MemberWorkSyncTeamMetrics;
}): boolean {
  const { status } = input;
  if (
    status.state !== 'needs_sync' ||
    status.shadow?.wouldNudge !== true ||
    !hasNoCurrentAcceptedWorkProof(status) ||
    !status.providerId ||
    !NATIVE_TASK_PROTOCOL_REPAIR_PROVIDERS.has(status.providerId) ||
    isLeadLikeMemberName(status.memberName) ||
    status.agenda.items.length !== 1 ||
    hasActiveAcceptedWorkLease(status)
  ) {
    return false;
  }

  const [item] = status.agenda.items;
  return (
    Boolean(item && isOwnedInProgressWorkItem(item)) &&
    hasNativeTaskProtocolRepairTurnSignal(status)
  );
}

function getNativeStaleWorkRecoveryReason(input: {
  status: MemberWorkSyncStatus;
  metrics: MemberWorkSyncTeamMetrics;
}): 'native_stale_in_progress' | 'native_stale_assigned_work' | null {
  const { status, metrics } = input;
  if (
    status.state !== 'needs_sync' ||
    status.shadow?.wouldNudge !== true ||
    !hasNoCurrentAcceptedWorkProof(status) ||
    !status.providerId ||
    !NATIVE_STALE_IN_PROGRESS_PROVIDERS.has(status.providerId) ||
    isLeadLikeMemberName(status.memberName) ||
    status.agenda.items.length === 0 ||
    hasActiveAcceptedWorkLease(status)
  ) {
    return null;
  }

  if (!status.agenda.items.every(isNativeStaleEligibleItem)) {
    return null;
  }
  if (!status.agenda.items.some(isNativeStaleWorkItem)) {
    return null;
  }

  const nowMs = parseTime(metrics.generatedAt) ?? parseTime(status.evaluatedAt);
  if (nowMs == null) {
    return null;
  }
  const stableSinceMs = getCurrentFingerprintStableSinceMs(status, metrics, nowMs);
  if (stableSinceMs == null || nowMs - stableSinceMs < NATIVE_STALE_IN_PROGRESS_MIN_AGE_MS) {
    return null;
  }

  return status.agenda.items.every(
    (item) =>
      item.kind === 'work' &&
      item.reason === 'owned_in_progress_task' &&
      item.evidence.status === 'in_progress'
  )
    ? 'native_stale_in_progress'
    : 'native_stale_assigned_work';
}

function isReviewPickupRequiredCandidate(status: MemberWorkSyncStatus): boolean {
  return (
    status.state === 'needs_sync' &&
    status.shadow?.wouldNudge === true &&
    status.agenda.items.length > 0 &&
    status.agenda.items.every(isStrictReviewPickupItem)
  );
}

export function decideMemberWorkSyncNudgeActivation(input: {
  status: MemberWorkSyncStatus;
  metrics: MemberWorkSyncTeamMetrics;
}): MemberWorkSyncNudgeActivationDecision {
  if (input.status.state !== 'needs_sync' || input.status.agenda.items.length === 0) {
    return { active: false, reason: 'status_not_nudgeable' };
  }

  if (
    input.metrics.deliveryReadiness.state === 'collecting_shadow_data' &&
    isReviewPickupRequiredCandidate(input.status)
  ) {
    return { active: true, reason: 'review_pickup_required' };
  }

  if (shouldActivateNativeTaskProtocolRepair(input)) {
    return { active: true, reason: 'native_task_protocol_repair' };
  }

  const nativeStaleWorkReason = getNativeStaleWorkRecoveryReason(input);
  if (nativeStaleWorkReason) {
    return { active: true, reason: nativeStaleWorkReason };
  }

  const targetedRecovery = decideMemberWorkSyncTargetedRecovery(input.status);
  if (targetedRecovery.active) {
    if (targetedRecovery.reason !== 'native_targeted_shadow_collecting') {
      return { active: true, reason: targetedRecovery.reason };
    }
    if (hasBlockingMetrics(input.metrics)) {
      return { active: false, reason: 'blocking_metrics' };
    }
    if (input.metrics.deliveryReadiness.state !== 'shadow_ready') {
      return { active: true, reason: targetedRecovery.reason };
    }
  }

  if (hasBlockingMetrics(input.metrics)) {
    return { active: false, reason: 'blocking_metrics' };
  }

  if (isReviewPickupRequiredCandidate(input.status)) {
    return { active: true, reason: 'review_pickup_required' };
  }

  if (input.metrics.deliveryReadiness.state === 'shadow_ready') {
    return { active: true, reason: 'shadow_ready' };
  }

  return { active: false, reason: 'delivery_not_ready' };
}
