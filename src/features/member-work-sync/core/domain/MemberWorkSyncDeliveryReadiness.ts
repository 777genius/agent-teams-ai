import type {
  MemberWorkSyncDeliveryReadinessAssessment,
  MemberWorkSyncDeliveryReadinessReason,
  MemberWorkSyncDeliveryReadinessThresholds,
  MemberWorkSyncMetricEvent,
} from '../../contracts';

export const DEFAULT_MEMBER_WORK_SYNC_DELIVERY_READINESS_THRESHOLDS: MemberWorkSyncDeliveryReadinessThresholds =
  {
    minObservedMembers: 1,
    minStatusEvents: 20,
    minObservationHours: 1,
    maxWouldNudgesPerMemberHour: 2,
    maxFingerprintChangesPerMemberHour: 1,
    maxReportRejectionRate: 0.2,
  };

interface AssessMemberWorkSyncDeliveryReadinessInput {
  memberCount: number;
  recentEvents: MemberWorkSyncMetricEvent[];
  thresholds?: Partial<MemberWorkSyncDeliveryReadinessThresholds>;
}

function parseTime(value: string): number | null {
  const time = new Date(value).getTime();
  return Number.isFinite(time) ? time : null;
}

function getObservationHours(events: MemberWorkSyncMetricEvent[]): number {
  const times = events.flatMap((event) => {
    const time = parseTime(event.recordedAt);
    return time == null ? [] : [time];
  });
  if (times.length < 2) {
    return 0;
  }
  const min = Math.min(...times);
  const max = Math.max(...times);
  return Math.max(0, (max - min) / 3_600_000);
}

function roundRate(value: number): number {
  return Math.round(value * 1000) / 1000;
}

function pushIf(
  reasons: MemberWorkSyncDeliveryReadinessReason[],
  condition: boolean,
  reason: MemberWorkSyncDeliveryReadinessReason
): void {
  if (condition) {
    reasons.push(reason);
  }
}

export function assessMemberWorkSyncDeliveryReadiness({
  memberCount,
  recentEvents,
  thresholds: thresholdOverrides,
}: AssessMemberWorkSyncDeliveryReadinessInput): MemberWorkSyncDeliveryReadinessAssessment {
  const thresholds = {
    ...DEFAULT_MEMBER_WORK_SYNC_DELIVERY_READINESS_THRESHOLDS,
    ...thresholdOverrides,
  };
  const statusEvents = recentEvents.filter((event) => event.kind === 'status_evaluated');
  const wouldNudgeEvents = recentEvents.filter((event) => event.kind === 'would_nudge');
  const fingerprintChangeEvents = recentEvents.filter(
    (event) => event.kind === 'fingerprint_changed'
  );
  const reportAcceptedEvents = recentEvents.filter((event) => event.kind === 'report_accepted');
  const reportRejectedEvents = recentEvents.filter((event) => event.kind === 'report_rejected');
  const observationHours = getObservationHours(recentEvents);
  const memberHourDenominator = Math.max(memberCount, 1) * Math.max(observationHours, 1 / 60);
  const wouldNudgesPerMemberHour = wouldNudgeEvents.length / memberHourDenominator;
  const fingerprintChangesPerMemberHour = fingerprintChangeEvents.length / memberHourDenominator;
  const reportEventCount = reportAcceptedEvents.length + reportRejectedEvents.length;
  const reportRejectionRate =
    reportEventCount > 0 ? reportRejectedEvents.length / reportEventCount : 0;

  const collectingReasons: MemberWorkSyncDeliveryReadinessReason[] = [];
  pushIf(collectingReasons, memberCount < thresholds.minObservedMembers, 'insufficient_members');
  pushIf(
    collectingReasons,
    statusEvents.length < thresholds.minStatusEvents,
    'insufficient_status_events'
  );
  pushIf(
    collectingReasons,
    observationHours < thresholds.minObservationHours,
    'insufficient_observation_window'
  );

  const blockingReasons: MemberWorkSyncDeliveryReadinessReason[] = [];
  pushIf(
    blockingReasons,
    wouldNudgesPerMemberHour > thresholds.maxWouldNudgesPerMemberHour,
    'would_nudge_rate_high'
  );
  pushIf(
    blockingReasons,
    fingerprintChangesPerMemberHour > thresholds.maxFingerprintChangesPerMemberHour,
    'fingerprint_churn_high'
  );
  pushIf(
    blockingReasons,
    reportRejectionRate > thresholds.maxReportRejectionRate,
    'report_rejection_rate_high'
  );

  const state =
    collectingReasons.length > 0
      ? 'collecting_shadow_data'
      : blockingReasons.length > 0
        ? 'blocked'
        : 'shadow_ready';
  const reasons = [...collectingReasons, ...blockingReasons];

  return {
    state,
    reasons,
    thresholds,
    rates: {
      observationHours: roundRate(observationHours),
      statusEventCount: statusEvents.length,
      wouldNudgesPerMemberHour: roundRate(wouldNudgesPerMemberHour),
      fingerprintChangesPerMemberHour: roundRate(fingerprintChangesPerMemberHour),
      reportRejectionRate: roundRate(reportRejectionRate),
    },
    diagnostics: reasons.map((reason) => `delivery_readiness:${reason}`),
  };
}
