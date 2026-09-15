import { MemberWorkSyncNudgeDispatchScheduler } from '@features/member-work-sync/main/infrastructure/MemberWorkSyncNudgeDispatchScheduler';
import { expect, it, vi } from 'vitest';

const summary = { claimed: 0, delivered: 0, superseded: 0, retryable: 0, terminal: 0 };

it('bounds discovery to two physical reads and ignores the late older response', async () => {
  vi.useFakeTimers();
  let releaseOld!: (teams: string[]) => void;
  let releaseNew!: (teams: string[]) => void;
  const old = new Promise<string[]>((resolve) => {
    releaseOld = resolve;
  });
  const newer = new Promise<string[]>((resolve) => {
    releaseNew = resolve;
  });
  const list = vi
    .fn()
    .mockReturnValueOnce(old)
    .mockReturnValueOnce(newer)
    .mockResolvedValue(['current']);
  const dispatch = vi.fn(async () => summary);
  const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
    listLifecycleActiveTeamNames: list,
    dispatchDue: dispatch,
    dispatchTimeoutMs: 20,
  });
  try {
    const first = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(20);
    await first;
    const second = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(20);
    await second;
    for (let tick = 0; tick < 100; tick++) await scheduler.runOnce();
    expect(list).toHaveBeenCalledTimes(2);
    expect(dispatch).not.toHaveBeenCalled();
    expect(scheduler.getHealth()).toMatchObject({
      pendingDiscovery: 2,
      discoveryCapacityExhausted: true,
      lastDiscoveryAt: null,
    });
    releaseNew(['new-but-timed-out']);
    await vi.advanceTimersByTimeAsync(0);
    await scheduler.runOnce();
    expect(dispatch).toHaveBeenCalledTimes(1);
    expect(dispatch).toHaveBeenCalledWith(['current'], expect.any(AbortSignal));
    const observed = scheduler.getHealth().lastDiscoveryAt;
    releaseOld(['obsolete']);
    await vi.advanceTimersByTimeAsync(100);
    expect(scheduler.getHealth().lastDiscoveryAt).toBe(observed);
    expect(dispatch).toHaveBeenCalledTimes(1);
  } finally {
    releaseOld([]);
    releaseNew([]);
    await scheduler.dispose();
    vi.useRealTimers();
  }
});

it('does not keep disposal waiting on a timed-out discovery read', async () => {
  vi.useFakeTimers();
  let reject!: (error: Error) => void;
  const pending = new Promise<string[]>((_resolve, fail) => {
    reject = fail;
  });
  const scheduler = new MemberWorkSyncNudgeDispatchScheduler({
    listLifecycleActiveTeamNames: () => pending,
    dispatchDue: async () => summary,
    dispatchTimeoutMs: 20,
  });
  try {
    const run = scheduler.runOnce();
    await vi.advanceTimersByTimeAsync(20);
    await run;
    await scheduler.dispose();
    expect(scheduler.getHealth().pendingDiscovery).toBe(1);
    reject(new Error('late failure'));
    await vi.advanceTimersByTimeAsync(0);
    expect(scheduler.getHealth().pendingDiscovery).toBe(0);
  } finally {
    reject(new Error('cleanup'));
    await scheduler.dispose();
    vi.useRealTimers();
  }
});
