import type { MemberWorkSyncStatus, MemberWorkSyncTeamMetrics } from '../../contracts';

export type MemberWorkSyncNudgeActivationReason =
  | 'shadow_ready'
  | 'opencode_targeted_shadow_collecting'
  | 'review_pickup_required'
  | 'status_not_nudgeable'
  | 'blocking_metrics'
  | 'phase2_not_ready';

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

function isOpenCodeTargetedCandidate(status: MemberWorkSyncStatus): boolean {
  return (
    status.providerId === 'opencode' &&
    status.state === 'needs_sync' &&
    status.agenda.items.length > 0 &&
    !isReviewPickupAgenda(status) &&
    status.shadow?.wouldNudge === true
  );
}

function isStrictReviewPickupItem(item: MemberWorkSyncStatus['agenda']['items'][number]): boolean {
  return (
    item.kind === 'review' &&
    item.evidence.reviewObligation === 'review_pickup_required' &&
    item.evidence.canBypassPhase2 === true &&
    typeof item.evidence.reviewRequestEventId === 'string' &&
    item.evidence.reviewRequestEventId.length > 0 &&
    (item.evidence.reviewDiagnostics?.length ?? 0) === 0
  );
}

function isReviewPickupAgenda(status: MemberWorkSyncStatus): boolean {
  return status.agenda.items.length > 0 && status.agenda.items.every(isStrictReviewPickupItem);
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

  if (hasBlockingMetrics(input.metrics)) {
    return { active: false, reason: 'blocking_metrics' };
  }

  if (isReviewPickupRequiredCandidate(input.status)) {
    return { active: true, reason: 'review_pickup_required' };
  }

  if (input.metrics.phase2Readiness.state === 'shadow_ready') {
    return { active: true, reason: 'shadow_ready' };
  }

  if (
    input.metrics.phase2Readiness.state === 'collecting_shadow_data' &&
    isOpenCodeTargetedCandidate(input.status)
  ) {
    return { active: true, reason: 'opencode_targeted_shadow_collecting' };
  }

  return { active: false, reason: 'phase2_not_ready' };
}
