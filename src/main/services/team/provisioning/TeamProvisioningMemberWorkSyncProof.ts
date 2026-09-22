import type { InboxMessage, TaskRef } from '@shared/types';

export type MemberWorkSyncAcceptedReportChecker = (input: {
  teamName: string;
  memberName: string;
}) => Promise<boolean> | boolean;

export type MemberWorkSyncProofMissingRecoveryScheduler = (input: {
  teamName: string;
  memberName: string;
  originalMessageId: string;
  taskRefs?: TaskRef[];
  reason?: string;
}) => Promise<unknown> | unknown;

export interface MemberWorkSyncProofLogger {
  warn(message: string): void;
}

export interface MemberWorkSyncProofPorts {
  logger: MemberWorkSyncProofLogger;
  getErrorMessage(error: unknown): string;
}

export async function hasAcceptedMemberWorkSyncReport(
  input: {
    teamName: string;
    memberName: string;
  },
  checker: MemberWorkSyncAcceptedReportChecker | null,
  ports: MemberWorkSyncProofPorts
): Promise<boolean> {
  if (!checker) {
    return false;
  }

  try {
    return (
      (await checker({
        teamName: input.teamName,
        memberName: input.memberName,
      })) === true
    );
  } catch (error) {
    ports.logger.warn(
      `[${input.teamName}] Failed to check accepted work sync report for ${input.memberName}: ${ports.getErrorMessage(error)}`
    );
    return false;
  }
}

export async function hasAcceptedLeadWorkSyncReport(
  input: {
    teamName: string;
    leadName: string;
  },
  checker: MemberWorkSyncAcceptedReportChecker | null,
  ports: MemberWorkSyncProofPorts
): Promise<boolean> {
  return hasAcceptedMemberWorkSyncReport(
    {
      teamName: input.teamName,
      memberName: input.leadName,
    },
    checker,
    ports
  );
}

export async function scheduleLeadProofMissingWorkSyncRecovery(
  input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  },
  scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null,
  ports: MemberWorkSyncProofPorts
): Promise<boolean> {
  if (!scheduler) {
    return false;
  }

  try {
    const result = (await scheduler({
      teamName: input.teamName,
      memberName: input.leadName,
      originalMessageId: input.message.messageId,
      taskRefs: input.message.taskRefs,
      reason: 'lead_member_work_sync_report_required',
    })) as { scheduled?: boolean; reason?: string } | null | undefined;
    return result?.scheduled === true || result?.reason === 'coalesced_recent';
  } catch (error) {
    ports.logger.warn(
      `[${input.teamName}] Failed to schedule lead proof-missing work sync recovery for ${input.leadName}: ${ports.getErrorMessage(error)}`
    );
    return false;
  }
}
