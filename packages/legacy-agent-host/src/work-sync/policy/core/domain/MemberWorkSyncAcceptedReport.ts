import type { MemberWorkSyncReport, MemberWorkSyncStatus } from '../../contracts/index.js';

/** Last diagnostic report cannot revoke an accepted lease. Legacy accepted report is adopted lazily. */
export function getMemberWorkSyncAcceptedReport(
  status: MemberWorkSyncStatus | null | undefined
): MemberWorkSyncReport | null {
  if (status?.lastAcceptedReport !== undefined)
    return status.lastAcceptedReport?.accepted === true ? status.lastAcceptedReport : null;
  return status?.report?.accepted === true ? status.report : null;
}
