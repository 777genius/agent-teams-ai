import { describe, expect, it, vi } from 'vitest';

import {
  hasAcceptedLeadWorkSyncReport,
  hasAcceptedMemberWorkSyncReport,
  scheduleLeadProofMissingWorkSyncRecovery,
} from '../TeamProvisioningMemberWorkSyncProof';

import type { InboxMessage } from '@shared/types';

function createPorts() {
  return {
    logger: {
      warn: vi.fn(),
    },
    getErrorMessage: (error: unknown) => (error instanceof Error ? error.message : String(error)),
  };
}

describe('member work sync proof helpers', () => {
  it('returns false when no accepted report checker is configured', async () => {
    await expect(
      hasAcceptedMemberWorkSyncReport({ teamName: 'alpha', memberName: 'dev' }, null, createPorts())
    ).resolves.toBe(false);
  });

  it('checks accepted member and lead work sync reports', async () => {
    const checker = vi.fn().mockResolvedValue(true);
    const ports = createPorts();

    await expect(
      hasAcceptedMemberWorkSyncReport({ teamName: 'alpha', memberName: 'dev' }, checker, ports)
    ).resolves.toBe(true);
    await expect(
      hasAcceptedLeadWorkSyncReport({ teamName: 'alpha', leadName: 'lead' }, checker, ports)
    ).resolves.toBe(true);

    expect(checker).toHaveBeenCalledWith({ teamName: 'alpha', memberName: 'dev' });
    expect(checker).toHaveBeenCalledWith({ teamName: 'alpha', memberName: 'lead' });
  });

  it('logs checker failures and returns false', async () => {
    const ports = createPorts();

    await expect(
      hasAcceptedMemberWorkSyncReport(
        { teamName: 'alpha', memberName: 'dev' },
        vi.fn().mockRejectedValue(new Error('boom')),
        ports
      )
    ).resolves.toBe(false);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[alpha] Failed to check accepted work sync report for dev: boom'
    );
  });

  it('schedules lead proof-missing recovery and treats coalesced recent as success', async () => {
    const message = {
      messageId: 'msg-1',
      taskRefs: [{ teamName: 'alpha', taskId: 'task-1', displayId: 'T-1' }],
    } as InboxMessage & { messageId: string };
    const scheduler = vi.fn().mockResolvedValue({ reason: 'coalesced_recent' });

    await expect(
      scheduleLeadProofMissingWorkSyncRecovery(
        { teamName: 'alpha', leadName: 'lead', message },
        scheduler,
        createPorts()
      )
    ).resolves.toBe(true);

    expect(scheduler).toHaveBeenCalledWith({
      teamName: 'alpha',
      memberName: 'lead',
      originalMessageId: 'msg-1',
      taskRefs: message.taskRefs,
      reason: 'lead_member_work_sync_report_required',
    });
  });

  it('logs scheduler failures and returns false', async () => {
    const ports = createPorts();
    const message = { messageId: 'msg-1' } as InboxMessage & { messageId: string };

    await expect(
      scheduleLeadProofMissingWorkSyncRecovery(
        { teamName: 'alpha', leadName: 'lead', message },
        vi.fn().mockRejectedValue(new Error('nope')),
        ports
      )
    ).resolves.toBe(false);

    expect(ports.logger.warn).toHaveBeenCalledWith(
      '[alpha] Failed to schedule lead proof-missing work sync recovery for lead: nope'
    );
  });
});
