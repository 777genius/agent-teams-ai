import { describe, expect, it, vi } from 'vitest';

import {
  hasAcceptedMemberWorkSyncReport,
  scheduleLeadProofMissingWorkSyncRecovery,
} from '../TeamProvisioningLeadWorkSyncRecovery';

describe('lead work-sync recovery adapters', () => {
  it('treats only explicit accepted report checker true as accepted', async () => {
    await expect(
      hasAcceptedMemberWorkSyncReport({
        teamName: 'team-a',
        memberName: 'team-lead',
        checker: async () => true,
        onError: vi.fn(),
      })
    ).resolves.toBe(true);

    await expect(
      hasAcceptedMemberWorkSyncReport({
        teamName: 'team-a',
        memberName: 'team-lead',
        checker: async () => false,
        onError: vi.fn(),
      })
    ).resolves.toBe(false);
  });

  it('returns false and reports checker errors without throwing', async () => {
    const onError = vi.fn();

    await expect(
      hasAcceptedMemberWorkSyncReport({
        teamName: 'team-a',
        memberName: 'team-lead',
        checker: async () => {
          throw new Error('checker failed');
        },
        onError,
      })
    ).resolves.toBe(false);

    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('schedules lead proof-missing recovery and accepts coalesced recent requests', async () => {
    const scheduler = vi
      .fn()
      .mockResolvedValueOnce({ scheduled: true })
      .mockResolvedValueOnce({ scheduled: false, reason: 'coalesced_recent' });
    const message = {
      from: 'system',
      to: 'team-lead',
      text: 'Work sync required.',
      timestamp: '2026-01-01T00:00:00.000Z',
      read: false,
      messageId: 'msg-1',
      taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '#1' }],
    };

    await expect(
      scheduleLeadProofMissingWorkSyncRecovery({
        teamName: 'team-a',
        leadName: 'team-lead',
        message,
        scheduler,
        onError: vi.fn(),
      })
    ).resolves.toBe(true);
    await expect(
      scheduleLeadProofMissingWorkSyncRecovery({
        teamName: 'team-a',
        leadName: 'team-lead',
        message,
        scheduler,
        onError: vi.fn(),
      })
    ).resolves.toBe(true);

    expect(scheduler).toHaveBeenCalledWith({
      teamName: 'team-a',
      memberName: 'team-lead',
      originalMessageId: 'msg-1',
      taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '#1' }],
      reason: 'lead_member_work_sync_report_required',
    });
  });
});
