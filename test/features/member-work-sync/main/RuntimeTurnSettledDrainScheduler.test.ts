import { RuntimeTurnSettledDrainScheduler } from '@features/member-work-sync/main/infrastructure/RuntimeTurnSettledDrainScheduler';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

describe('RuntimeTurnSettledDrainScheduler', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('does not overlap active drains', async () => {
    let release!: () => void;
    const firstDrain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const drain = vi.fn(async () => {
      await firstDrain;
      return { claimed: 1, enqueued: 1, unresolved: 0, ignored: 0, invalid: 0, failed: 0 };
    });
    const scheduler = new RuntimeTurnSettledDrainScheduler({ drain });

    const first = scheduler.drainNow();
    await vi.advanceTimersByTimeAsync(0);

    await expect(scheduler.drainNow()).resolves.toBeNull();
    expect(drain).toHaveBeenCalledTimes(1);

    release();
    await first;
  });

  it('does not overlap later drains while a timed-out drain is still settling', async () => {
    let releaseFirst!: () => void;
    let drainCalls = 0;
    const warn = vi.fn();
    const drain = vi.fn(async () => {
      drainCalls += 1;
      if (drainCalls === 1) {
        await new Promise<void>((resolve) => {
          releaseFirst = resolve;
        });
      }
      return { claimed: 0, enqueued: 0, unresolved: 0, ignored: 0, invalid: 0, failed: 0 };
    });
    const scheduler = new RuntimeTurnSettledDrainScheduler({
      drain,
      drainTimeoutMs: 20,
      logger: {
        debug: vi.fn(),
        warn,
        error: vi.fn(),
      },
    });

    const first = scheduler.drainNow();
    await vi.advanceTimersByTimeAsync(0);

    expect(drain).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(20);
    await expect(first).resolves.toBeNull();

    expect(warn).toHaveBeenCalledWith(
      'runtime turn settled scheduled drain failed',
      expect.objectContaining({
        error: 'Error: runtime turn settled drain timed out after 20ms',
      })
    );

    await expect(scheduler.drainNow()).resolves.toBeNull();
    expect(drain).toHaveBeenCalledTimes(1);

    releaseFirst();
    await vi.advanceTimersByTimeAsync(0);

    await expect(scheduler.drainNow()).resolves.toMatchObject({
      claimed: 0,
      enqueued: 0,
    });
    expect(drain).toHaveBeenCalledTimes(2);
  });

  it('idempotently waits for the actual timed-out drain during disposal', async () => {
    let release!: () => void;
    const activeDrain = new Promise<void>((resolve) => {
      release = resolve;
    });
    const scheduler = new RuntimeTurnSettledDrainScheduler({
      drain: async () => {
        await activeDrain;
        return { claimed: 0, enqueued: 0, unresolved: 0, ignored: 0, invalid: 0, failed: 0 };
      },
      drainTimeoutMs: 20,
    });

    const drain = scheduler.drainNow();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(20);
    await expect(drain).resolves.toBeNull();

    let disposed = false;
    const firstDispose = scheduler.dispose();
    const secondDispose = scheduler.dispose();
    void firstDispose.then(() => {
      disposed = true;
    });
    await vi.advanceTimersByTimeAsync(0);

    expect(secondDispose).toBe(firstDispose);
    expect(disposed).toBe(false);

    release();
    await firstDispose;
    expect(disposed).toBe(true);
    expect(scheduler.dispose()).toBe(firstDispose);
  });
});
