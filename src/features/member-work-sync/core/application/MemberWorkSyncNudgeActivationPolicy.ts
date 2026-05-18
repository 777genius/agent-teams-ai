import {
  isReviewPickupAgenda,
  isStrictReviewPickupItem,
} from './MemberWorkSyncNudgeAgendaPredicates';
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
  | 'native_stale_in_progress'
  | 'status_not_nudgeable'
  | 'blocking_metrics'
  | 'phase2_not_ready';

const NATIVE_STALE_IN_PROGRESS_MIN_AGE_MS = 6 * 60_000;
const NATIVE_STALE_IN_PROGRESS_PROVIDERS = new Set(['anthropic', 'codex', 'gemini']);

export interface MemberWorkSyncNudgeActivationDecision {
  active: boolean;
  reason: MemberWorkSyncNudgeActivationReason;
}

const BLOCKING_PHASE2_REASONS = new Set([
  'would_nudge_rate_high',
  'fingerprint_churn_high',
  'report_rejection_rate_high',
]);

function hasBlockingMetrics(metrics: MemberWorkSyncTeamMetrics): boolean {
  return metrics.phase2Readiness.reasons.some((reason) => BLOCKING_PHASE2_REASONS.has(reason));
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

function eventsForMember(
  status: MemberWorkSyncStatus,
  metrics: MemberWorkSyncTeamMetrics
): MemberWorkSyncMetricEvent[] {
  const memberName = normalizeMemberName(status.memberName);
  return metrics.recentEvents
    .filter((event) => normalizeMemberName(event.memberName) === memberName)
    .sort((left, right) => left.recordedAt.localeCompare(right.recordedAt));
}

function hasAcceptedReportForCurrentFingerprint(
  status: MemberWorkSyncStatus,
  metrics: MemberWorkSyncTeamMetrics
): boolean {
  return eventsForMember(status, metrics).some(
    (event) =>
      event.kind === 'report_accepted' && event.agendaFingerprint === status.agenda.fingerprint
  );
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
  for (const event of memberEvents) {
    const recordedAt = parseTime(event.recordedAt);
    if (recordedAt != null && isDifferentFingerprintBoundary(event, currentFingerprint)) {
      latestDifferentFingerprintMs = Math.max(latestDifferentFingerprintMs, recordedAt);
    }
  }

  const currentNeedsSyncEventTimes = memberEvents.flatMap((event) => {
    const recordedAt = parseTime(event.recordedAt);
    return event.kind === 'status_evaluated' &&
      event.state === 'needs_sync' &&
      event.agendaFingerprint === currentFingerprint &&
      recordedAt != null &&
      recordedAt >= latestDifferentFingerprintMs
      ? [recordedAt]
      : [];
  });

  return currentNeedsSyncEventTimes.length > 0 ? Math.min(...currentNeedsSyncEventTimes) : null;
}

function isNativeStaleInProgressCandidate(input: {
  status: MemberWorkSyncStatus;
  metrics: MemberWorkSyncTeamMetrics;
}): boolean {
  const { status, metrics } = input;
  if (
    status.state !== 'needs_sync' ||
    status.shadow?.wouldNudge !== true ||
    !status.diagnostics.includes('no_current_report') ||
    !status.providerId ||
    !NATIVE_STALE_IN_PROGRESS_PROVIDERS.has(status.providerId) ||
    isLeadLikeMemberName(status.memberName) ||
    status.agenda.items.length !== 1 ||
    hasAcceptedReportForCurrentFingerprint(status, metrics)
  ) {
    return false;
  }

  const [item] = status.agenda.items;
  if (
    item.kind !== 'work' ||
    item.reason !== 'owned_in_progress_task' ||
    item.evidence.status !== 'in_progress'
  ) {
    return false;
  }

  const nowMs = parseTime(metrics.generatedAt) ?? parseTime(status.evaluatedAt);
  if (nowMs == null) {
    return false;
  }
  const stableSinceMs = getCurrentFingerprintStableSinceMs(status, metrics, nowMs);
  return stableSinceMs != null && nowMs - stableSinceMs >= NATIVE_STALE_IN_PROGRESS_MIN_AGE_MS;
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
    input.metrics.phase2Readiness.state === 'collecting_shadow_data' &&
    isReviewPickupRequiredCandidate(input.status)
  ) {
    return { active: true, reason: 'review_pickup_required' };
  }

  const targetedRecovery = decideMemberWorkSyncTargetedRecovery(input.status);
  if (targetedRecovery.active) {
    return { active: true, reason: targetedRecovery.reason };
  }

  if (isNativeStaleInProgressCandidate(input)) {
    return { active: true, reason: 'native_stale_in_progress' };
  }

  if (hasBlockingMetrics(input.metrics)) {
    return { active: false, reason: 'blocking_metrics' };
  }

  if (isReviewPickupRequiredCandidate(input.status)) {
    return { active: true, reason: 'review_pickup_required' };
  }

  if (input.metrics.phase2Readiness.state === 'shadow_ready') {
    return { active: true, reason: 'shadow_ready' };
  }

  return { active: false, reason: 'phase2_not_ready' };
}
