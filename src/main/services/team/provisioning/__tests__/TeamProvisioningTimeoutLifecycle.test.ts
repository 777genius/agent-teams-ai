import { EventEmitter } from 'events';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  recordProvisioningFirstTurnStart,
  scheduleProvisioningRunTimeout,
} from '../TeamProvisioningTimeoutLifecycle';

import type { ChildProcess } from 'child_process';

function makeRun() {
  return {
    child: new EventEmitter() as ChildProcess,
    timeoutHandle: null as NodeJS.Timeout | null,
    provisioningComplete: false,
    processKilled: false,
    processClosed: false,
    cancelRequested: false,
    finalizingByTimeout: false,
    requiresFirstRealTurnSuccess: true,
    progress: { state: 'finalizing' as const },
  };
}

afterEach(() => vi.useRealTimers());

describe('provisioning process-attempt deadlines', () => {
  it('also bounds the first turn when a large roster had a longer bootstrap budget', async () => {
    vi.useFakeTimers();
    const run = makeRun();
    const expire = vi.fn();
    scheduleProvisioningRunTimeout(run, 930_000, expire);
    await vi.advanceTimersByTimeAsync(100_000);
    recordProvisioningFirstTurnStart(run);
    await vi.advanceTimersByTimeAsync(299_999);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
  });
  it('retains a live first turn at 300s and lets success 15s later clear its timer', async () => {
    vi.useFakeTimers();
    const run = makeRun();
    const cleanup = vi.fn();
    const stdoutListener = vi.fn();
    run.child.on('data', stdoutListener);
    scheduleProvisioningRunTimeout(run, 300_000, cleanup);
    await vi.advanceTimersByTimeAsync(145_000);
    recordProvisioningFirstTurnStart(run);
    await vi.advanceTimersByTimeAsync(155_000);
    expect(cleanup).not.toHaveBeenCalled();
    expect(run.provisioningComplete).toBe(false);
    expect(run.child.listenerCount('data')).toBe(1);
    await vi.advanceTimersByTimeAsync(15_000);
    // The successful-result path remains the only readiness transition.
    run.provisioningComplete = true;
    clearTimeout(run.timeoutHandle!);
    run.timeoutHandle = null;
    await vi.advanceTimersByTimeAsync(300_000);
    expect(cleanup).not.toHaveBeenCalled();
  });

  it('expires at the first fixed deadline even if completed events repeat', async () => {
    vi.useFakeTimers();
    const run = makeRun();
    const expire = vi.fn();
    scheduleProvisioningRunTimeout(run, 300_000, expire);
    await vi.advanceTimersByTimeAsync(145_000);
    recordProvisioningFirstTurnStart(run);
    await vi.advanceTimersByTimeAsync(100_000);
    recordProvisioningFirstTurnStart(run);
    await vi.advanceTimersByTimeAsync(199_999);
    expect(expire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(expire).toHaveBeenCalledOnce();
  });

  it.each(['cancelRequested', 'processClosed', 'provisioningComplete'] as const)(
    'ignores the timer after %s',
    async (flag) => {
      vi.useFakeTimers();
      const run = makeRun();
      const expire = vi.fn();
      scheduleProvisioningRunTimeout(run, 300_000, expire);
      run[flag] = true;
      recordProvisioningFirstTurnStart(run);
      await vi.advanceTimersByTimeAsync(600_000);
      expect(expire).not.toHaveBeenCalled();
    }
  );

  it('resets the phase for a replacement child and ignores its predecessor timer', async () => {
    vi.useFakeTimers();
    const run = makeRun();
    const oldExpire = vi.fn();
    const nextExpire = vi.fn();
    scheduleProvisioningRunTimeout(run, 300_000, oldExpire);
    await vi.advanceTimersByTimeAsync(100_000);
    recordProvisioningFirstTurnStart(run);
    run.child = new EventEmitter() as ChildProcess;
    scheduleProvisioningRunTimeout(run, 300_000, nextExpire);
    await vi.advanceTimersByTimeAsync(200_000);
    expect(oldExpire).not.toHaveBeenCalled();
    expect(nextExpire).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(100_000);
    expect(nextExpire).toHaveBeenCalledOnce();
  });
});
