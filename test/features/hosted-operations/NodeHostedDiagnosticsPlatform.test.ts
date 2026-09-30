import { createNodeHostedDiagnosticsPlatform } from '@features/hosted-operations/main/infrastructure/NodeHostedDiagnosticsPlatform';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('NodeHostedDiagnosticsPlatform', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('provides bounded random bytes and valid server clocks', () => {
    const platform = createNodeHostedDiagnosticsPlatform();

    expect(platform.randomBytes(16)).toBeInstanceOf(Uint8Array);
    expect(platform.randomBytes(16)).toHaveLength(16);
    expect(platform.nowEpochMs()).toSatisfy(
      (value: number) => Number.isSafeInteger(value) && value >= 0
    );
    expect(platform.nowMonotonicMs()).toSatisfy(
      (value: number) => Number.isSafeInteger(value) && value >= 0
    );
    expect(() => platform.randomBytes(0)).toThrow('hosted-diagnostics-random-size-invalid');
  });

  it('fires a scheduled timer once and cancellation is idempotent', async () => {
    vi.useFakeTimers();
    const platform = createNodeHostedDiagnosticsPlatform();
    const fired = vi.fn();
    const cancelled = vi.fn();
    const cancelFired = platform.schedule(50, fired);
    const cancelOutstanding = platform.schedule(50, cancelled);

    cancelOutstanding();
    cancelOutstanding();
    await vi.advanceTimersByTimeAsync(49);
    expect(fired).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(fired).toHaveBeenCalledOnce();
    expect(cancelled).not.toHaveBeenCalled();
    cancelFired();
    expect(() => platform.schedule(-1, fired)).toThrow('hosted-diagnostics-timer-invalid');
  });
});
