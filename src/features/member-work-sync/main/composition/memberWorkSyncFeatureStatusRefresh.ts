import { normalizeMemberWorkSyncTeamOperationKey } from '../../core/application/MemberWorkSyncTeamOperationGate';

import {
  CAUGHT_UP_STATUS_MAX_AGE_MS,
  getAcceptedWorkLeaseStaleness,
  getReportTokenStaleness,
  isEmptyAgendaStaleState,
  STALE_STATUS_MAX_AGE_MS,
} from './memberWorkSyncStatusRefreshPolicy';

import type { MemberWorkSyncStatus } from '../../contracts';

export function statusNeedsBackgroundRefresh(status: MemberWorkSyncStatus, nowMs: number): boolean {
  if (getReportTokenStaleness(status, nowMs) !== null || isEmptyAgendaStaleState(status)) {
    return true;
  }
  const evaluatedAtMs = Date.parse(status.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    return true;
  }
  if (status.state === 'caught_up' && nowMs - evaluatedAtMs > CAUGHT_UP_STATUS_MAX_AGE_MS) {
    return true;
  }
  if (status.agenda.items.length === 0) {
    return false;
  }
  if (status.state === 'needs_sync' && nowMs - evaluatedAtMs > STALE_STATUS_MAX_AGE_MS) {
    return true;
  }
  return getAcceptedWorkLeaseStaleness(status, nowMs) !== null;
}

export function getStatusStalenessDiagnostics(
  status: MemberWorkSyncStatus,
  nowMs: number
): string[] {
  const diagnostics: string[] = [];
  const tokenStaleness = getReportTokenStaleness(status, nowMs);
  if (tokenStaleness === 'missing') {
    diagnostics.push('report_token_missing_refresh_enqueued');
  } else if (tokenStaleness === 'expired') {
    diagnostics.push('report_token_expired_refresh_enqueued');
  }

  const evaluatedAtMs = Date.parse(status.evaluatedAt);
  if (!Number.isFinite(evaluatedAtMs)) {
    diagnostics.push('status_evaluated_at_invalid');
  } else if (isEmptyAgendaStaleState(status)) {
    diagnostics.push('empty_agenda_state_refresh_enqueued');
  } else if (status.state === 'caught_up' && nowMs - evaluatedAtMs > CAUGHT_UP_STATUS_MAX_AGE_MS) {
    diagnostics.push('caught_up_stale_refresh_enqueued');
  } else if (
    status.agenda.items.length > 0 &&
    ['needs_sync', 'still_working', 'blocked'].includes(status.state) &&
    nowMs - evaluatedAtMs > STALE_STATUS_MAX_AGE_MS
  ) {
    diagnostics.push('status_stale_refresh_enqueued');
  }

  const leaseStaleness = getAcceptedWorkLeaseStaleness(status, nowMs);
  if (leaseStaleness === 'missing') {
    diagnostics.push('accepted_report_lease_missing_refresh_enqueued');
  } else if (leaseStaleness === 'expired') {
    diagnostics.push('accepted_report_lease_expired_refresh_enqueued');
  }
  return [...new Set(diagnostics)];
}

export function uniqueMemberWorkSyncTeamNames(teamNames: string[]): string[] {
  const seen = new Set<string>();
  const unique: string[] = [];
  for (const candidate of teamNames) {
    const teamName = candidate.trim();
    if (!teamName) {
      continue;
    }
    const teamKey = normalizeMemberWorkSyncTeamOperationKey(teamName);
    if (seen.has(teamKey)) {
      continue;
    }
    seen.add(teamKey);
    unique.push(teamName);
  }
  return unique;
}
