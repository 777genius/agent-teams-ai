import type {
  MemberWorkSyncMetricEvent,
  MemberWorkSyncPhase2ReadinessAssessment,
  MemberWorkSyncPhase2ReadinessReason,
  MemberWorkSyncPhase2ReadinessThresholds,
} from '../../contracts';

export const DEFAULT_MEMBER_WORK_SYNC_PHASE2_READINESS_THRESHOLDS: MemberWorkSyncPhase2ReadinessThresholds =
  {
    minObservedMembers: 1,
    minStatusEvents: 20,
    minObservationHours: 1,
    maxWouldNudgesPerMemberHour: 2,
    maxFingerprintChangesPerMemberHour: 1,
    maxReportRejectionRate: 0.2,
  };

interface AssessMemberWorkSyncPhase2ReadinessInput {
  memberCount: number;
  recentEvents: MemberWorkSyncMetricEvent[];
  thresholds?: Partial<MemberWorkSyncPhase2ReadinessThresholds>;
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
  reasons: MemberWorkSyncPhase2ReadinessReason[],
  condition: boolean,
  reason: MemberWorkSyncPhase2ReadinessReason
): void {
  if (condition) {
    reasons.push(reason);
  }
}

export function assessMemberWorkSyncPhase2Readiness({
  memberCount,
  recentEvents,
  thresholds: thresholdOverrides,
}: AssessMemberWorkSyncPhase2ReadinessInput): MemberWorkSyncPhase2ReadinessAssessment {
  const thresholds = {
    ...DEFAULT_MEMBER_WORK_SYNC_PHASE2_READINESS_THRESHOLDS,
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

  const collectingReasons: MemberWorkSyncPhase2ReadinessReason[] = [];
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

  const blockingReasons: MemberWorkSyncPhase2ReadinessReason[] = [];
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
    diagnostics: reasons.map((reason) => `phase2_readiness:${reason}`),
  };
}
