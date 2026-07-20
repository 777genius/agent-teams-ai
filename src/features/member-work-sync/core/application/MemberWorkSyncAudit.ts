import type { MemberWorkSyncPhase2ReadinessAssessment } from '../../contracts';
import type {
  MemberWorkSyncAuditEvent,
  MemberWorkSyncAuditEventName,
  MemberWorkSyncUseCaseDeps,
} from './ports';

export type MemberWorkSyncAuditEventInput = Omit<MemberWorkSyncAuditEvent, 'timestamp'> & {
  timestamp?: string;
};

export async function appendMemberWorkSyncAudit(
  deps: Pick<MemberWorkSyncUseCaseDeps, 'auditJournal' | 'clock' | 'logger'>,
  input: MemberWorkSyncAuditEventInput
): Promise<void> {
  if (!deps.auditJournal) {
    return;
  }
  try {
    await deps.auditJournal.append({
      ...input,
      timestamp: input.timestamp ?? deps.clock.now().toISOString(),
    });
  } catch (error) {
    deps.logger?.warn('member work sync audit event failed', {
      teamName: input.teamName,
      memberName: input.memberName,
      event: input.event,
      error: String(error),
    });
  }
}

export function buildMemberWorkSyncPhase2ReadinessAuditFields(
  phase2Readiness?: MemberWorkSyncPhase2ReadinessAssessment
): Pick<MemberWorkSyncAuditEvent, 'diagnostics' | 'metadata'> {
  if (!phase2Readiness) {
    return {};
  }
  return {
    diagnostics: phase2Readiness.diagnostics,
    metadata: {
      phase2ReadinessState: phase2Readiness.state,
      phase2ReadinessReasons: phase2Readiness.reasons.join(','),
      observationHours: phase2Readiness.rates.observationHours,
      statusEventCount: phase2Readiness.rates.statusEventCount,
      wouldNudgesPerMemberHour: phase2Readiness.rates.wouldNudgesPerMemberHour,
      maxWouldNudgesPerMemberHour: phase2Readiness.thresholds.maxWouldNudgesPerMemberHour,
      fingerprintChangesPerMemberHour: phase2Readiness.rates.fingerprintChangesPerMemberHour,
      maxFingerprintChangesPerMemberHour:
        phase2Readiness.thresholds.maxFingerprintChangesPerMemberHour,
      reportRejectionRate: phase2Readiness.rates.reportRejectionRate,
      maxReportRejectionRate: phase2Readiness.thresholds.maxReportRejectionRate,
    },
  };
}

export function reasonToAuditEvent(reason: string): MemberWorkSyncAuditEventName {
  if (reason === 'proof_missing_recovery_scheduled') {
    return 'proof_missing_recovery_scheduled';
  }
  if (reason === 'proof_missing_recovery_coalesced') {
    return 'proof_missing_recovery_coalesced';
  }
  if (reason === 'proof_missing_recovery_suppressed') {
    return 'proof_missing_recovery_suppressed';
  }
  if (reason === 'proof_missing_recovery_conflict') {
    return 'proof_missing_recovery_conflict';
  }
  if (reason.startsWith('member_busy:')) {
    return 'member_busy';
  }
  if (reason === 'watchdog_cooldown_active') {
    return 'watchdog_cooldown_active';
  }
  if (reason === 'work_sync_suppressed_no_accepted_report') {
    return 'nudge_suppressed';
  }
  if (reason === 'team_inactive') {
    return 'team_inactive';
  }
  return 'nudge_skipped';
}
