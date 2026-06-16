import { CompositeMemberWorkSyncBusySignal } from '@features/member-work-sync/main/infrastructure/CompositeMemberWorkSyncBusySignal';
import { describe, expect, it, vi } from 'vitest';

describe('CompositeMemberWorkSyncBusySignal', () => {
  it('does not block nudges forever when one busy signal fails', async () => {
    const logger = { debug: vi.fn(), error: vi.fn(), warn: vi.fn() };
    const signal = new CompositeMemberWorkSyncBusySignal(
      [
        {
          isBusy: vi.fn(async () => {
            throw new Error('delivery status unavailable');
          }),
        },
        {
          isBusy: vi.fn(async () => ({ busy: false })),
        },
      ],
      logger
    );

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:00.000Z',
        workSyncIntent: 'agenda_sync',
        taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
      })
    ).resolves.toEqual({ busy: false });
    expect(logger.warn).toHaveBeenCalledWith(
      'member work sync busy signal failed',
      expect.objectContaining({
        teamName: 'team-a',
        memberName: 'bob',
        error: 'Error: delivery status unavailable',
      })
    );
  });

  it('still stops at the first positive busy signal', async () => {
    const secondSignal = vi.fn(async () => ({ busy: false }));
    const signal = new CompositeMemberWorkSyncBusySignal([
      {
        isBusy: vi.fn(async () => ({
          busy: true,
          reason: 'active_tool_activity',
          retryAfterIso: '2026-04-29T00:01:00.000Z',
        })),
      },
      { isBusy: secondSignal },
    ]);

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:00.000Z',
        workSyncIntent: 'agenda_sync',
        taskRefs: [{ teamName: 'team-a', taskId: 'task-1', displayId: '11111111' }],
      })
    ).resolves.toEqual({
      busy: true,
      reason: 'active_tool_activity',
      retryAfterIso: '2026-04-29T00:01:00.000Z',
    });
    expect(secondSignal).not.toHaveBeenCalled();
  });
});
