import type { MemberWorkSyncProofMissingRecoveryScheduler } from './TeamProvisioningOpenCodeRuntimeDeliveryAdvisory';
import type { InboxMessage } from '@shared/types/team';

export type MemberWorkSyncAcceptedReportChecker = (input: {
  teamName: string;
  memberName: string;
}) => Promise<boolean> | boolean;

export async function hasAcceptedMemberWorkSyncReport(input: {
  teamName: string;
  memberName: string;
  checker: MemberWorkSyncAcceptedReportChecker | null;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (!input.checker) {
    return false;
  }

  try {
    return (
      (await input.checker({
        teamName: input.teamName,
        memberName: input.memberName,
      })) === true
    );
  } catch (error) {
    input.onError(error);
    return false;
  }
}

export async function scheduleLeadProofMissingWorkSyncRecovery(input: {
  teamName: string;
  leadName: string;
  message: InboxMessage & { messageId: string };
  scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null;
  onError: (error: unknown) => void;
}): Promise<boolean> {
  if (!input.scheduler) {
    return false;
  }

  try {
    const result = (await input.scheduler({
      teamName: input.teamName,
      memberName: input.leadName,
      originalMessageId: input.message.messageId,
      taskRefs: input.message.taskRefs,
      reason: 'lead_member_work_sync_report_required',
    })) as { scheduled?: boolean; reason?: string } | null | undefined;
    return result?.scheduled === true || result?.reason === 'coalesced_recent';
  } catch (error) {
    input.onError(error);
    return false;
  }
}
