import type { MemberWorkSyncStatus } from '../../contracts';

const STALE_STATUS_MAX_AGE_MS = 2 * 60_000;
const CAUGHT_UP_STATUS_MAX_AGE_MS = 5 * 60_000;

function isAcceptedWorkLeaseStatus(status: MemberWorkSyncStatus): boolean {
  return (
    status.report?.accepted === true &&
    (status.state === 'still_working' || status.state === 'blocked')
  );
}

export function getAcceptedWorkLeaseStaleness(
  status: MemberWorkSyncStatus,
  nowMs: number
): 'missing' | 'expired' | null {
  if (!isAcceptedWorkLeaseStatus(status)) {
    return null;
  }

  const reportExpiresAtMs = Date.parse(status.report?.expiresAt ?? '');
  if (!Number.isFinite(reportExpiresAtMs) || !Number.isFinite(nowMs)) {
    return 'missing';
  }
  return reportExpiresAtMs <= nowMs ? 'expired' : null;
}

export function getReportTokenStaleness(
  status: MemberWorkSyncStatus,
  nowMs: number
): 'missing' | 'expired' | null {
  if (!status.reportToken?.trim()) {
    return 'missing';
  }

  const tokenExpiresAtMs = Date.parse(status.reportTokenExpiresAt ?? '');
  if (!Number.isFinite(tokenExpiresAtMs) || !Number.isFinite(nowMs)) {
    return 'missing';
  }

  return tokenExpiresAtMs <= nowMs ? 'expired' : null;
}

export function isEmptyAgendaStaleState(status: MemberWorkSyncStatus): boolean {
  return (
    status.agenda.items.length === 0 &&
    (status.state === 'needs_sync' ||
      status.state === 'still_working' ||
      status.state === 'blocked' ||
      status.state === 'unknown')
  );
}

export { CAUGHT_UP_STATUS_MAX_AGE_MS, STALE_STATUS_MAX_AGE_MS };
