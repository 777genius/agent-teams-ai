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

  it('does not overlap later scheduled runs while a timed-out dispatch is still settling', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: () => void;
      let dispatchCalls = 0;
      const warn = vi.fn();
      const dispatchDue = vi.fn(async () => {
        dispatchCalls += 1;
        if (dispatchCalls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
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
      expect(dispatchDue).toHaveBeenCalledTimes(1);

      releaseFirst();
      await vi.advanceTimersByTimeAsync(0);

      await scheduler.runOnce();

      expect(dispatchDue).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not overlap later scheduled runs while timed-out active team listing is still settling', async () => {
    vi.useFakeTimers();
    try {
      let releaseFirst!: (teams: string[]) => void;
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
            return new Promise<string[]>((resolve) => {
              releaseFirst = resolve;
            });
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
      expect(dispatchDue).not.toHaveBeenCalled();

      releaseFirst(['team-a']);
      await vi.advanceTimersByTimeAsync(0);

      await scheduler.runOnce();

      expect(dispatchDue).toHaveBeenCalledWith(['team-a']);
    } finally {
      vi.useRealTimers();
    }
  });

  it('idempotently waits for a running dispatch during disposal', async () => {
    let release!: () => void;
    const activeDispatch = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
      listLifecycleActiveTeamNames: async () => ['team-a'],
      dispatchDue: async () => {
        await activeDispatch;
        return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
      },
    });

    const run = scheduler.runOnce();
    await new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });

    let disposed = false;
    const firstDispose = scheduler.dispose();
    const secondDispose = scheduler.dispose();
    void firstDispose.then(() => {
      disposed = true;
    });
    await Promise.resolve();

    expect(secondDispose).toBe(firstDispose);
    expect(disposed).toBe(false);

    release();
    await Promise.all([run, firstDispose]);
    expect(disposed).toBe(true);
    expect(scheduler.dispose()).toBe(firstDispose);
  });

  it('waits for timed-out dispatch work during disposal', async () => {
    vi.useFakeTimers();
    try {
      let release!: () => void;
      const timedOutDispatch = new Promise<void>((resolve) => {
        release = resolve;
      });
      const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: async () => ['team-a'],
        dispatchDue: async () => {
          await timedOutDispatch;
          return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
        },
        dispatchTimeoutMs: 20,
      });

      const run = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(20);
      await run;

      let disposed = false;
      const dispose = scheduler.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(false);

      release();
      await dispose;
      expect(disposed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waits for timed-out active team listing work during disposal', async () => {
    vi.useFakeTimers();
    try {
      let release!: (teamNames: string[]) => void;
      const timedOutListing = new Promise<string[]>((resolve) => {
        release = resolve;
      });
      const dispatchDue = vi.fn(async () => ({
        claimed: 0,
        delivered: 0,
        superseded: 0,
        retryable: 0,
        terminal: 0,
      }));
      const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: async () => timedOutListing,
        dispatchDue,
        dispatchTimeoutMs: 20,
      });

      const run = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(20);
      await run;

      let disposed = false;
      const dispose = scheduler.dispose().then(() => {
        disposed = true;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(disposed).toBe(false);

      release(['team-a']);
      await dispose;
      expect(disposed).toBe(true);
      expect(dispatchDue).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
