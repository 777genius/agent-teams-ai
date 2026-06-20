import { appendMemberWorkSyncAudit } from './MemberWorkSyncAudit';

import type { MemberWorkSyncStatus } from '../../contracts';
import type { MemberWorkSyncUseCaseDeps } from './ports';

export const MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC = 'work_sync_suppressed_no_accepted_report';
export const MEMBER_WORK_SYNC_SUPPRESSION_RESET_DIAGNOSTIC =
  'work_sync_suppression_manual_retry_reset';
export const MEMBER_WORK_SYNC_SUPPRESSION_DELIVERED_NUDGE_LIMIT = 4;

function parseTime(value: string | undefined): number | null {
  if (!value) {
    return null;
  }
  const time = Date.parse(value);
  return Number.isFinite(time) ? time : null;
}

function latestIso(values: Array<string | undefined>): string | undefined {
  let latest: { iso: string; time: number } | null = null;
  for (const value of values) {
    const time = parseTime(value);
    if (!value || time == null) {
      continue;
    }
    if (!latest || time > latest.time) {
      latest = { iso: value, time };
    }
  }
  return latest?.iso;
}

function withDiagnostic(status: MemberWorkSyncStatus, diagnostic: string): MemberWorkSyncStatus {
  if (status.diagnostics.includes(diagnostic)) {
    return status;
  }
  return { ...status, diagnostics: [...status.diagnostics, diagnostic] };
}

function withoutDiagnostic(status: MemberWorkSyncStatus, diagnostic: string): MemberWorkSyncStatus {
  if (!status.diagnostics.includes(diagnostic)) {
    return status;
  }
  return {
    ...status,
    diagnostics: status.diagnostics.filter((entry) => entry !== diagnostic),
  };
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

function isSuppressionCandidate(status: MemberWorkSyncStatus): boolean {
  return (
    status.state === 'needs_sync' &&
    status.shadow?.wouldNudge === true &&
    status.agenda.items.length > 0 &&
    !hasActiveAcceptedWorkLease(status)
  );
}

function resolveSuppressionResetAt(input: {
  status: MemberWorkSyncStatus;
  previousStatus?: MemberWorkSyncStatus | null;
}): string | undefined {
  const { status, previousStatus } = input;
  if (!previousStatus) {
    return undefined;
  }

  const sameFingerprint = previousStatus.agenda.fingerprint === status.agenda.fingerprint;
  if (!sameFingerprint) {
    return status.evaluatedAt;
  }

  const acceptedReportResetAt =
    previousStatus.report?.accepted === true &&
    previousStatus.report.agendaFingerprint === status.agenda.fingerprint
      ? previousStatus.report.reportedAt
      : undefined;
  const manualResetAt = previousStatus.shadow?.nudgeSuppressionResetAt;

  return latestIso([acceptedReportResetAt, manualResetAt]);
}

export async function applyMemberWorkSyncNudgeSuppression(
  deps: Pick<MemberWorkSyncUseCaseDeps, 'auditJournal' | 'clock' | 'logger' | 'outboxStore'>,
  input: {
    status: MemberWorkSyncStatus;
    previousStatus?: MemberWorkSyncStatus | null;
    forceNudge?: boolean;
    source: string;
  }
): Promise<MemberWorkSyncStatus> {
  let status = input.status;
  if (!isSuppressionCandidate(status)) {
    return status;
  }
  const shadow = status.shadow;
  if (!shadow) {
    return status;
  }

  if (input.forceNudge === true) {
    const { nudgeSuppression: _nudgeSuppression, ...shadowWithoutSuppression } = shadow;
    return withDiagnostic(
      withoutDiagnostic(
        {
          ...status,
          shadow: {
            ...shadowWithoutSuppression,
            nudgeSuppressionResetAt: status.evaluatedAt,
          },
        },
        MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC
      ),
      MEMBER_WORK_SYNC_SUPPRESSION_RESET_DIAGNOSTIC
    );
  }

  const resetAt = resolveSuppressionResetAt({
    status,
    previousStatus: input.previousStatus,
  });
  if (resetAt) {
    status = {
      ...status,
      shadow: {
        ...(status.shadow ?? shadow),
        nudgeSuppressionResetAt: resetAt,
      },
    };
  }

  const outboxStore = deps.outboxStore;
  if (!outboxStore?.countDeliveredForAgenda) {
    return status;
  }

  const deliveredCount = await outboxStore.countDeliveredForAgenda({
    teamName: status.teamName,
    memberName: status.memberName,
    agendaFingerprint: status.agenda.fingerprint,
    ...(resetAt ? { sinceIso: resetAt } : {}),
  });
  if (deliveredCount < MEMBER_WORK_SYNC_SUPPRESSION_DELIVERED_NUDGE_LIMIT) {
    return status;
  }

  const suppressed = withDiagnostic(
    {
      ...status,
      shadow: {
        ...(status.shadow ?? shadow),
        wouldNudge: false,
        nudgeSuppression: {
          reason: 'no_accepted_report',
          agendaFingerprint: status.agenda.fingerprint,
          deliveredCount,
          suppressedAt: status.evaluatedAt,
          ...(resetAt ? { resetAt } : {}),
        },
      },
    },
    MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC
  );

  await appendMemberWorkSyncAudit(deps, {
    teamName: status.teamName,
    memberName: status.memberName,
    event: 'nudge_suppressed',
    source: input.source,
    agendaFingerprint: status.agenda.fingerprint,
    state: status.state,
    actionableCount: status.agenda.items.length,
    diagnostics: suppressed.diagnostics,
    metadata: {
      deliveredCount,
      suppressionLimit: MEMBER_WORK_SYNC_SUPPRESSION_DELIVERED_NUDGE_LIMIT,
      ...(resetAt ? { resetAt } : {}),
    },
  });

  return suppressed;
}
