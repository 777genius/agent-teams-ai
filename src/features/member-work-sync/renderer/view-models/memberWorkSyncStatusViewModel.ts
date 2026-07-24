import type { MemberWorkSyncStatus } from '../../contracts';

export type MemberWorkSyncViewTone = 'neutral' | 'success' | 'working' | 'attention' | 'blocked';

const MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC = 'work_sync_suppressed_no_accepted_report';

export interface MemberWorkSyncStatusViewModel {
  label: 'Synced' | 'Working' | 'Needs sync' | 'Blocked' | 'Unknown';
  tone: MemberWorkSyncViewTone;
  actionableCount: number;
  tooltip: string;
  fingerprint?: string;
  leaseExpiresAt?: string;
  reportState?: string;
  wouldNudge?: boolean;
}

function describeAgenda(count: number): string {
  if (count === 0) {
    return 'No actionable work items.';
  }
  if (count === 1) {
    return '1 actionable work item.';
  }
  return `${count} actionable work items.`;
}

export function toMemberWorkSyncStatusViewModel(
  status: MemberWorkSyncStatus | null | undefined
): MemberWorkSyncStatusViewModel {
  if (!status) {
    return {
      label: 'Unknown',
      tone: 'neutral',
      actionableCount: 0,
      tooltip: 'Member work sync status has not been evaluated yet.',
    };
  }

  const actionableCount = status.agenda.items.length;
  const base = {
    actionableCount,
    fingerprint: status.agenda.fingerprint,
    ...(status.report?.expiresAt ? { leaseExpiresAt: status.report.expiresAt } : {}),
    ...(status.report?.state ? { reportState: status.report.state } : {}),
    ...(status.shadow ? { wouldNudge: status.shadow.wouldNudge } : {}),
  };

  if (status.state === 'caught_up') {
    return {
      ...base,
      label: 'Synced',
      tone: 'success',
      tooltip: `Synced with current work agenda. ${describeAgenda(actionableCount)}`,
    };
  }

  if (status.state === 'still_working') {
    return {
      ...base,
      label: 'Working',
      tone: 'working',
      tooltip: `Member reported still working on current agenda. ${describeAgenda(actionableCount)}`,
    };
  }

  if (status.state === 'blocked') {
    return {
      ...base,
      label: 'Blocked',
      tone: 'blocked',
      tooltip: `Member reported blocked on current agenda. ${describeAgenda(actionableCount)}`,
    };
  }

  if (status.state === 'needs_sync') {
    const nudgesSuppressed = status.diagnostics.includes(MEMBER_WORK_SYNC_SUPPRESSION_DIAGNOSTIC);
    return {
      ...base,
      label: 'Needs sync',
      tone: 'attention',
      tooltip: nudgesSuppressed
        ? `Automatic work-sync nudges are paused after repeated deliveries without a valid report. ${describeAgenda(
            actionableCount
          )}`
        : `Shadow status only: current agenda has no valid member report. ${describeAgenda(
            actionableCount
          )}`,
    };
  }

  return {
    ...base,
    label: 'Unknown',
    tone: 'neutral',
    tooltip: `Member work sync is not active for this member. ${describeAgenda(actionableCount)}`,
  };
}
