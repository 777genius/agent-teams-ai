import { afterEach, describe, expect, it, vi } from 'vitest';

import { SchedulerStopBarrier } from '@main/services/schedule/SchedulerStopBarrier';

describe('SchedulerStopBarrier', () => {
  afterEach(() => vi.useRealTimers());

  it('does not complete shutdown while any owned finalization is pending', async () => {
    const barrier = new SchedulerStopBarrier();
    const finishFirst = barrier.beginFinalization();
    const finishSecond = barrier.beginFinalization();
    let drained = false;
    const stopping = barrier.drainFinalizations().then(() => { drained = true; });

    finishFirst();
    await Promise.resolve();
    expect(drained).toBe(false);
    finishSecond();
    await stopping;
    expect(drained).toBe(true);
  });

  it('wakes a cancelled retry delay instead of leaving a pending Promise', async () => {
    vi.useFakeTimers();
    const barrier = new SchedulerStopBarrier();
    const retry = barrier.waitForRetry('schedule-1', 90_000);
    const finished = vi.fn();
    void retry.then(finished);

    barrier.cancelRetries();
    await retry;
    expect(finished).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('fails closed after a bounded wait when a write never settles', async () => {
    vi.useFakeTimers();
    const barrier = new SchedulerStopBarrier();
    const finish = barrier.beginFinalization();
    const waiting = expect(barrier.drainFinalizations()).rejects.toThrow(
      /timed out waiting for durable run finalization/
    );
    try {
      await vi.advanceTimersByTimeAsync(15_000);
      await waiting;
    } finally {
      finish();
    }
  });
});
