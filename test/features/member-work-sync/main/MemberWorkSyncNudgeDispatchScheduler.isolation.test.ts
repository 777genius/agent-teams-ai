import { MemberWorkSyncNudgeDispatchScheduler } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { describe, expect, it, vi } from 'vitest';

describe('scheduled dispatch isolation (recovery plan Q01/Q02)', () => {
  it('keeps servicing healthy teams without restarting a timed-out physical dispatch', async () => {
    vi.useFakeTimers();
    let releaseStalled!: () => void;
    const stalled = new Promise<void>((resolve) => {
      releaseStalled = resolve;
    });
    const attempts: string[] = [];
    const completed: string[] = [];
    const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
      listLifecycleActiveTeamNames: async () => ['stalled-team', 'healthy-team'],
      dispatchTimeoutMs: 20,
      dispatchDue: async (teams, signal) => {
        for (const team of teams) {
          attempts.push(team);
          if (team === 'stalled-team') await stalled;
          if (!signal?.aborted) completed.push(team);
        }
        return { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
      },
    });

    try {
      const first = scheduler.runOnce();
      await vi.advanceTimersByTimeAsync(20);
      await first;

      expect(completed).toContain('healthy-team');
      const firstHealthyCount = completed.length;
      for (let tick = 0; tick < 100; tick += 1) {
        const run = scheduler.runOnce();
        await vi.advanceTimersByTimeAsync(20);
        await run;
      }

      expect(attempts.filter((team) => team === 'stalled-team')).toHaveLength(1);
      expect(completed.length).toBeGreaterThan(firstHealthyCount);
      expect(completed).not.toContain('stalled-team');
    } finally {
      releaseStalled();
      await vi.advanceTimersByTimeAsync(0);
      await scheduler.dispose();
      vi.useRealTimers();
    }
  });
  it.each([false, true])(
    'retains a dispatch after early logical completion (reject=%s)',
    async (reject) => {
      let release!: () => void;
      const physical = new Promise<void>((resolve) => {
        release = resolve;
      });
      const summary = { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };
      const calls: string[] = [];
      const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
        listLifecycleActiveTeamNames: async () => ['a', 'b'],
        dispatchDue: ([team]) => {
          calls.push(team);
          return {
            result:
              team === 'a' && reject
                ? Promise.reject(new Error('logical failure'))
                : Promise.resolve(summary),
            settled: team === 'a' ? physical : Promise.resolve(),
          };
        },
      });
      try {
        for (let tick = 0; tick < 100; tick++) await scheduler.runOnce();
        expect(calls.filter((team) => team === 'a')).toHaveLength(1);
        expect(calls.filter((team) => team === 'b')).toHaveLength(100);
        let drained = false;
        const dispose = scheduler.dispose().then(() => {
          drained = true;
        });
        await Promise.resolve();
        expect(drained).toBe(false);
        release();
        await dispose;
        expect(drained).toBe(true);
      } finally {
        release();
        await scheduler.dispose();
      }
    }
  );
});
