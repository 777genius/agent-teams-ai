import { describe, expect, it, vi } from 'vitest';

import { createTeamProvisioningRunFinalizationArbiter } from '../TeamProvisioningProcessCloseBarrier';

describe('team provisioning run finalization arbiter', () => {
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
