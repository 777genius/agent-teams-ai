import {
  hasAcceptedLeadWorkSyncReport,
  hasAcceptedMemberWorkSyncReport,
  type MemberWorkSyncAcceptedReportChecker,
  type MemberWorkSyncProofLogger,
  type MemberWorkSyncProofMissingRecoveryScheduler,
  scheduleLeadProofMissingWorkSyncRecovery,
} from './TeamProvisioningMemberWorkSyncProof';

import type { InboxMessage } from '@shared/types';

export interface TeamProvisioningMemberWorkSyncProofBoundaryDeps {
  getAcceptedReportChecker(): MemberWorkSyncAcceptedReportChecker | null;
  getProofMissingRecoveryScheduler(): MemberWorkSyncProofMissingRecoveryScheduler | null;
  logger: MemberWorkSyncProofLogger;
  getErrorMessage(error: unknown): string;
}

export interface TeamProvisioningMemberWorkSyncProofBoundary {
  hasAcceptedMemberWorkSyncReport(input: {
    teamName: string;
    memberName: string;
  }): Promise<boolean>;
  hasAcceptedLeadWorkSyncReport(input: { teamName: string; leadName: string }): Promise<boolean>;
  scheduleLeadProofMissingWorkSyncRecovery(input: {
    teamName: string;
    leadName: string;
    message: InboxMessage & { messageId: string };
  }): Promise<boolean>;
}

export function createTeamProvisioningMemberWorkSyncProofBoundary(
  deps: TeamProvisioningMemberWorkSyncProofBoundaryDeps
): TeamProvisioningMemberWorkSyncProofBoundary {
  const ports = {
    logger: deps.logger,
    getErrorMessage: deps.getErrorMessage,
  };

  return {
    hasAcceptedMemberWorkSyncReport(input) {
      return hasAcceptedMemberWorkSyncReport(input, deps.getAcceptedReportChecker(), ports);
    },
    hasAcceptedLeadWorkSyncReport(input) {
      return hasAcceptedLeadWorkSyncReport(input, deps.getAcceptedReportChecker(), ports);
    },
    scheduleLeadProofMissingWorkSyncRecovery(input) {
      return scheduleLeadProofMissingWorkSyncRecovery(
        input,
        deps.getProofMissingRecoveryScheduler(),
        ports
      );
    },
  };
}
