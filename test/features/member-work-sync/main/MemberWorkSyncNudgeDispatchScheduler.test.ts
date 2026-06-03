import { MemberWorkSyncNudgeDispatchScheduler } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { describe, expect, it, vi } from 'vitest';

describe('MemberWorkSyncNudgeDispatchScheduler', () => {
  it('dispatches due nudges for unique active teams without overlapping runs', async () => {
    let release!: () => void;
    const firstDispatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const dispatchDue = vi.fn(async () => {
      await firstDispatch;
      return { claimed: 1, delivered: 1, superseded: 0, retryable: 0, terminal: 0 };
    });
    const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
      listLifecycleActiveTeamNames: async () => ['team-a', 'team-a', ' ', 'team-b'],
      dispatchDue,
    });

    const first = scheduler.runOnce();
    const second = scheduler.runOnce();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
    expect(dispatchDue).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([first, second]);

    expect(dispatchDue).toHaveBeenCalledWith(['team-a', 'team-b']);
  });

  it('skips dispatch when there are no active teams', async () => {
    const dispatchDue = vi.fn();
    const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
      listLifecycleActiveTeamNames: async () => [],
      dispatchDue,
    });

    await scheduler.runOnce();

    expect(dispatchDue).not.toHaveBeenCalled();
  });

  it('logs and survives list failures without throwing', async () => {
    const warn = vi.fn();
    const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
      listLifecycleActiveTeamNames: async () => {
        throw new Error('list failed');
      },
      dispatchDue: vi.fn(),
      logger: {
        debug: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    await expect(scheduler.runOnce()).resolves.toBeUndefined();

    expect(warn).toHaveBeenCalledWith(
      'member work sync scheduled nudge dispatch failed',
      expect.objectContaining({ error: 'Error: list failed' })
    );
  });

  it('times out a hung dispatch so later scheduled runs can continue', async () => {
    vi.useFakeTimers();
    try {
      let dispatchCalls = 0;
      const warn = vi.fn();
      const dispatchDue = vi.fn(async () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          await new Promise<void>(() => undefined);
        }
        return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
      });
      const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: async () => ['team-a'],
        dispatchDue,
        dispatchTimeoutMs: 20,
        logger: {
          debug: vi.fn(),
          warn,
          error: vi.fn(),
        },
      });

      const first = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(0);

      expect(dispatchDue).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(20);
      await first;

      expect(warn).toHaveBeenCalledWith(
        'member work sync scheduled nudge dispatch failed',
        expect.objectContaining({
          error: 'Error: member work sync scheduled nudge dispatch timed out after 20ms',
        })
      );

      await scheduler.runOnce();

      expect(dispatchDue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('times out hung active team listing so later scheduled runs can continue', async () => {
    vi.useFakeTimers();
    try {
      let listCalls = 0;
      const warn = vi.fn();
      const dispatchDue = vi.fn(async () => ({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      }));
      const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: async () => {
          listCalls += 1;
          if (listCalls === 1) {
            await new Promise<string[]>(() => undefined);
          }
          return ['team-a'];
        },
        dispatchDue,
        dispatchTimeoutMs: 20,
        logger: {
          debug: vi.fn(),
          warn,
          error: vi.fn(),
        },
      });

      const first = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(20);
      await first;

      expect(warn).toHaveBeenCalledWith(
        'member work sync scheduled nudge dispatch failed',
        expect.objectContaining({
          error: 'Error: member work sync scheduled nudge team listing timed out after 20ms',
        })
      );
      expect(dispatchDue).not.toHaveBeenCalled();

      await scheduler.runOnce();

      expect(dispatchDue).toHaveBeenCalledWith(['team-a']);
    } finally {
      vi.useRealTimers();
    }
  });
});
