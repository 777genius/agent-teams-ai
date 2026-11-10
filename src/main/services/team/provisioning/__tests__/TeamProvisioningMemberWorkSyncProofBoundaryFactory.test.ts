import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningMemberWorkSyncProofBoundary } from '../TeamProvisioningMemberWorkSyncProofBoundaryFactory';

import type {
  MemberWorkSyncAcceptedReportChecker,
  MemberWorkSyncProofMissingRecoveryScheduler,
} from '../TeamProvisioningMemberWorkSyncProof';
import type { InboxMessage } from '@shared/types';

function message(): InboxMessage & { messageId: string } {
  return {
    from: 'system',
    to: 'lead',
    text: 'Work sync required.',
    timestamp: '2026-01-01T00:00:00.000Z',
    read: false,
    messageId: 'msg-1',
    taskRefs: [{ teamName: 'alpha', taskId: 'task-1', displayId: '#1' }],
  };
}

describe('TeamProvisioningMemberWorkSyncProofBoundaryFactory', () => {
  it('resolves accepted report checks through the current checker', async () => {
    let checker: MemberWorkSyncAcceptedReportChecker | null = vi.fn().mockResolvedValue(false);
    const boundary = createTeamProvisioningMemberWorkSyncProofBoundary({
      getAcceptedReportChecker: () => checker,
      getProofMissingRecoveryScheduler: () => null,
      logger: { warn: vi.fn() },
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    });

    await expect(
      boundary.hasAcceptedMemberWorkSyncReport({ teamName: 'alpha', memberName: 'worker' })
    ).resolves.toBe(false);

    checker = vi.fn().mockResolvedValue(true);
    await expect(
      boundary.hasAcceptedLeadWorkSyncReport({ teamName: 'alpha', leadName: 'lead' })
    ).resolves.toBe(true);
    expect(checker).toHaveBeenCalledWith({ teamName: 'alpha', memberName: 'lead' });
  });

  it('resolves lead proof-missing recovery through the current scheduler', async () => {
    let scheduler: MemberWorkSyncProofMissingRecoveryScheduler | null = null;
    const boundary = createTeamProvisioningMemberWorkSyncProofBoundary({
      getAcceptedReportChecker: () => null,
      getProofMissingRecoveryScheduler: () => scheduler,
      logger: { warn: vi.fn() },
      getErrorMessage: (error) => (error instanceof Error ? error.message : String(error)),
    });

    await expect(
      boundary.scheduleLeadProofMissingWorkSyncRecovery({
        teamName: 'alpha',
        leadName: 'lead',
        message: message(),
      })
    ).resolves.toBe(false);

    scheduler = vi.fn().mockResolvedValue({ scheduled: true });
    await expect(
      boundary.scheduleLeadProofMissingWorkSyncRecovery({
        teamName: 'alpha',
        leadName: 'lead',
        message: message(),
      })
    ).resolves.toBe(true);
    expect(scheduler).toHaveBeenCalledWith({
      teamName: 'alpha',
      memberName: 'lead',
      originalMessageId: 'msg-1',
      taskRefs: [{ teamName: 'alpha', taskId: 'task-1', displayId: '#1' }],
      reason: 'lead_member_work_sync_report_required',
    });
  });
});
