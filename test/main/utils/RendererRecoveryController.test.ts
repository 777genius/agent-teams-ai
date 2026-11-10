import { RendererRecoveryController } from '@main/utils/RendererRecoveryController';
import { vi } from 'vitest';

describe('RendererRecoveryController', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  function harness() {
    let available = true;
    const reloads: number[] = [];
    const failures: unknown[] = [];
    let limits = 0;
    const controller = new RendererRecoveryController({
      canRecover: () => available,
      reload: () => reloads.push(Date.now()),
      onScheduled: () => undefined,
      onLimitReached: () => limits++,
      onReloadError: (error) => failures.push(error),
    });
    return {
      controller,
      reloads,
      failures,
      limits: () => limits,
      makeUnavailable: () => {
        available = false;
      },
    };
  }

  // Regresses if a briefly successful load replenishes the crash retry budget.
  it('stops after two automatic reloads despite successful loads between crashes', () => {
    const { controller, reloads, limits } = harness();
    controller.processGone();
    vi.advanceTimersByTime(999);
    expect(reloads).toHaveLength(0);
    vi.advanceTimersByTime(1);
    expect(reloads).toHaveLength(1);
    controller.loadStarted();
    controller.loadFinished();
    controller.processGone();
    vi.advanceTimersByTime(2000);
    expect(reloads).toHaveLength(2);
    controller.loadFinished();
    controller.processGone();
    vi.advanceTimersByTime(120_000);
    expect(reloads).toHaveLength(2);
    expect(limits()).toBe(1);
  });

  it('replenishes retries only after a continuously stable minute', () => {
    const { controller, reloads } = harness();
    controller.processGone();
    vi.advanceTimersByTime(1000);
    controller.loadFinished();
    vi.advanceTimersByTime(59_999);
    expect(controller.recoveryAttempts).toBe(1);
    vi.advanceTimersByTime(1);
    expect(controller.recoveryAttempts).toBe(0);
    controller.processGone();
    vi.advanceTimersByTime(1000);
    expect(reloads).toHaveLength(2);
  });

  it('does not count time spent navigating as stable renderer time', () => {
    const { controller } = harness();
    controller.processGone();
    vi.advanceTimersByTime(1000);
    controller.loadFinished();
    vi.advanceTimersByTime(30_000);
    controller.loadStarted();
    vi.advanceTimersByTime(60_000);
    expect(controller.recoveryAttempts).toBe(1);
    controller.loadFinished();
    vi.advanceTimersByTime(60_000);
    expect(controller.recoveryAttempts).toBe(0);
  });

  it('coalesces repeated crash notifications while a reload is pending', () => {
    const { controller, reloads } = harness();
    controller.processGone();
    controller.processGone();
    vi.advanceTimersByTime(5000);
    expect(reloads).toHaveLength(1);
    expect(controller.recoveryAttempts).toBe(1);
  });

  it('cancels pending reload and stability callbacks when disposed', () => {
    const crashed = harness();
    crashed.controller.processGone();
    crashed.controller.dispose();
    crashed.controller.loadFinished();
    crashed.controller.processGone();
    const loaded = harness();
    loaded.controller.processGone();
    vi.advanceTimersByTime(1000);
    loaded.controller.loadFinished();
    loaded.controller.dispose();
    expect(vi.getTimerCount()).toBe(0);
    vi.advanceTimersByTime(120_000);
    expect(crashed.reloads).toHaveLength(0);
    expect(loaded.controller.recoveryAttempts).toBe(1);
  });

  it('ignores callbacks after shutdown or window replacement and gives new windows a fresh budget', () => {
    const oldWindow = harness();
    oldWindow.controller.processGone();
    oldWindow.makeUnavailable();
    vi.advanceTimersByTime(1000);
    expect(oldWindow.reloads).toHaveLength(0);
    oldWindow.controller.processGone();
    const newWindow = harness();
    newWindow.controller.processGone();
    vi.advanceTimersByTime(1000);
    expect(newWindow.reloads).toHaveLength(1);
    expect(newWindow.controller.recoveryAttempts).toBe(1);
  });

  it('reports synchronous reload failures without escaping the timer callback', () => {
    const error = new Error('reload failed');
    const failures: unknown[] = [];
    const controller = new RendererRecoveryController({
      canRecover: () => true,
      reload: () => {
        throw error;
      },
      onScheduled: () => undefined,
      onLimitReached: () => undefined,
      onReloadError: (failure) => failures.push(failure),
    });
    controller.processGone();
    expect(() => vi.advanceTimersByTime(1000)).not.toThrow();
    expect(failures).toEqual([error]);
  });
});
