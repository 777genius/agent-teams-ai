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

  it('short-circuits after the first positive busy signal', async () => {
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

  it('returns a pending tool approval immediately when it is ordered first', async () => {
    const expensiveDeliverySignal = vi.fn(async () => ({ busy: false }));
    const signal = new CompositeMemberWorkSyncBusySignal([
      {
        isBusy: vi.fn(async () => ({
          busy: true,
          reason: 'pending_tool_approval',
          retryAfterIso: '2026-04-29T00:02:00.000Z',
        })),
      },
      { isBusy: expensiveDeliverySignal },
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
      reason: 'pending_tool_approval',
      retryAfterIso: '2026-04-29T00:02:00.000Z',
    });
    expect(expensiveDeliverySignal).not.toHaveBeenCalled();
  });

  it('composes priority signals before primary and extra signals', async () => {
    const primarySignal = { isBusy: vi.fn(async () => ({ busy: true })) };
    const extraSignal = { isBusy: vi.fn(async () => ({ busy: false })) };
    const prioritySignal = {
      isBusy: vi.fn(async () => ({ busy: true, reason: 'pending_tool_approval' })),
    };
    const signal = CompositeMemberWorkSyncBusySignal.compose(primarySignal, {
      priorityBusySignals: [prioritySignal],
      extraBusySignals: [extraSignal],
    });

    await expect(
      signal.isBusy({
        teamName: 'team-a',
        memberName: 'bob',
        nowIso: '2026-04-29T00:00:00.000Z',
      })
    ).resolves.toMatchObject({ busy: true, reason: 'pending_tool_approval' });
    expect(primarySignal.isBusy).not.toHaveBeenCalled();
    expect(extraSignal.isBusy).not.toHaveBeenCalled();
  });
});
