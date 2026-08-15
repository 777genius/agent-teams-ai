import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningRunFinalizationArbiter } from '../TeamProvisioningProcessCloseBarrier';

describe('team provisioning run finalization arbiter', () => {
  it('independently retries a one-shot close rejection without another process signal', async () => {
    vi.useFakeTimers();
    try {
      const finalizer = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('one-shot close rejection'))
        .mockResolvedValueOnce(undefined);
      const onRejected = vi.fn();
      const arbiter = createTeamProvisioningRunFinalizationArbiter({ retryDelaysMs: [10] });

      arbiter.observe(finalizer, onRejected);
      await vi.advanceTimersByTimeAsync(0);
      expect(finalizer).toHaveBeenCalledOnce();
      expect(onRejected).toHaveBeenCalledOnce();

      await vi.advanceTimersByTimeAsync(10);

      expect(finalizer).toHaveBeenCalledTimes(2);
      expect(onRejected).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rearms an exhausted rejected owner until cleanup eventually succeeds', async () => {
    vi.useFakeTimers();
    try {
      const finalizer = vi
        .fn<() => Promise<void>>()
        .mockRejectedValueOnce(new Error('initial rejection'))
        .mockRejectedValueOnce(new Error('automatic rejection'))
        .mockRejectedValueOnce(new Error('rearmed rejection'))
        .mockResolvedValueOnce(undefined);
      const arbiter = createTeamProvisioningRunFinalizationArbiter({ retryDelaysMs: [10] });

      await expect(arbiter.run(finalizer)).rejects.toThrow('initial rejection');
      await vi.advanceTimersByTimeAsync(10);
      expect(finalizer).toHaveBeenCalledTimes(2);

      await vi.advanceTimersByTimeAsync(10);
      expect(finalizer).toHaveBeenCalledTimes(3);

      await vi.advanceTimersByTimeAsync(10);
      expect(finalizer).toHaveBeenCalledTimes(4);

      await arbiter.run(vi.fn(async () => undefined));
      expect(finalizer).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it('retains a rejected finalizer for a later close or error retry and only completes on success', async () => {
    const retainedFinalizer = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('revocation unavailable'))
      .mockResolvedValueOnce(undefined);
    const laterSignalFinalizer = vi.fn(async () => undefined);
    const afterCompletionFinalizer = vi.fn(async () => undefined);
    const arbiter = createTeamProvisioningRunFinalizationArbiter();

    await expect(arbiter.run(retainedFinalizer)).rejects.toThrow('revocation unavailable');
    await arbiter.run(laterSignalFinalizer);
    await arbiter.run(afterCompletionFinalizer);

    expect(retainedFinalizer).toHaveBeenCalledTimes(2);
    expect(laterSignalFinalizer).not.toHaveBeenCalled();
    expect(afterCompletionFinalizer).not.toHaveBeenCalled();
  });
});
