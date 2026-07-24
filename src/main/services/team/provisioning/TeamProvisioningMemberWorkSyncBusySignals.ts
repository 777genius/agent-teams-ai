import type { MemberWorkSyncBusySignalPort } from '@features/member-work-sync/main';

interface TeamProvisioningMemberWorkSyncBusyStatusPort {
  getMemberToolApprovalBusyStatus: MemberWorkSyncBusySignalPort['isBusy'];
  getOpenCodeMemberDeliveryBusyStatus: MemberWorkSyncBusySignalPort['isBusy'];
}

export function createTeamProvisioningMemberWorkSyncBusySignals(
  port: TeamProvisioningMemberWorkSyncBusyStatusPort
): {
  priorityBusySignals: MemberWorkSyncBusySignalPort[];
  extraBusySignals: MemberWorkSyncBusySignalPort[];
} {
  return {
    priorityBusySignals: [{ isBusy: (input) => port.getMemberToolApprovalBusyStatus(input) }],
    extraBusySignals: [{ isBusy: (input) => port.getOpenCodeMemberDeliveryBusyStatus(input) }],
  };
}
