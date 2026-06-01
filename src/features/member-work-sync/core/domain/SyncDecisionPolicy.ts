import type {
  MemberWorkSyncAgenda,
  MemberWorkSyncReport,
  MemberWorkSyncStatusState,
} from '../../contracts';

export interface SyncDecision {
  state: MemberWorkSyncStatusState;
  acceptedReport?: MemberWorkSyncReport;
  diagnostics: string[];
}

function getWorkLeaseDiagnostic(
  report: MemberWorkSyncReport,
  nowIso: string
): 'report_lease_missing' | 'report_lease_expired' | null {
  const expiresAtMs = Date.parse(report.expiresAt ?? '');
  const nowMs = Date.parse(nowIso);
  if (!Number.isFinite(expiresAtMs) || !Number.isFinite(nowMs)) {
    return 'report_lease_missing';
  }
  return expiresAtMs <= nowMs ? 'report_lease_expired' : null;
}

export function decideMemberWorkSyncStatus(input: {
  agenda: MemberWorkSyncAgenda;
  latestAcceptedReport?: MemberWorkSyncReport | null;
  nowIso: string;
  inactive?: boolean;
}): SyncDecision {
  if (input.inactive) {
    return { state: 'inactive', diagnostics: ['member_or_team_inactive'] };
  }

  if (input.agenda.items.length === 0) {
    return {
      state: 'caught_up',
      diagnostics: ['agenda_empty'],
      acceptedReport:
        input.latestAcceptedReport?.state === 'caught_up' &&
        input.latestAcceptedReport.agendaFingerprint === input.agenda.fingerprint
          ? input.latestAcceptedReport
          : undefined,
    };
  }

  const report = input.latestAcceptedReport ?? null;
  if (!report) {
    return { state: 'needs_sync', diagnostics: ['no_current_report'] };
  }
  if (report.agendaFingerprint !== input.agenda.fingerprint) {
    return { state: 'needs_sync', diagnostics: ['report_fingerprint_stale'] };
  }
  if (report.state === 'still_working') {
    const leaseDiagnostic = getWorkLeaseDiagnostic(report, input.nowIso);
    if (leaseDiagnostic) {
      return { state: 'needs_sync', diagnostics: [leaseDiagnostic] };
    }
    return { state: 'still_working', acceptedReport: report, diagnostics: ['lease_still_working'] };
  }
  if (report.state === 'blocked') {
    const leaseDiagnostic = getWorkLeaseDiagnostic(report, input.nowIso);
    if (leaseDiagnostic) {
      return { state: 'needs_sync', diagnostics: [leaseDiagnostic] };
    }
    return { state: 'blocked', acceptedReport: report, diagnostics: ['lease_blocked'] };
  }

  return { state: 'needs_sync', diagnostics: ['caught_up_report_not_valid_for_non_empty_agenda'] };
}
