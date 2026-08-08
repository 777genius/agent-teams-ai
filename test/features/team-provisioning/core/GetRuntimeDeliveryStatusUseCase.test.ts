import {
  type GetRuntimeDeliveryStatusQuery,
  GetRuntimeDeliveryStatusUseCase,
} from '@features/team-provisioning/core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeDeliveryStatus } from '@features/team-provisioning/contracts/runtime-delivery';
import type { RuntimeDeliveryStatusPort } from '@features/team-provisioning/core/application/ports/RuntimeDeliveryPort';

function status(): RuntimeDeliveryStatus {
  return {
    providerId: 'opencode',
    attempted: true,
    delivered: true,
    messageId: 'message-1',
  };
}

describe('GetRuntimeDeliveryStatusUseCase', () => {
  it('forwards identifiers unchanged and returns the exact status snapshot', async () => {
    const snapshot = status();
    const getRuntimeDeliveryStatus = vi.fn<RuntimeDeliveryStatusPort['getRuntimeDeliveryStatus']>(
      () => Promise.resolve(snapshot)
    );
    const useCase = new GetRuntimeDeliveryStatusUseCase({ getRuntimeDeliveryStatus });
    const query: GetRuntimeDeliveryStatusQuery = {
      teamName: ' Team ',
      messageId: ' message-1 ',
    };

    await expect(useCase.execute(query)).resolves.toBe(snapshot);
    expect(getRuntimeDeliveryStatus).toHaveBeenCalledWith(' Team ', ' message-1 ');
  });

  it('preserves a missing status and downstream read errors', async () => {
    const readError = new Error('status store unavailable');
    const getRuntimeDeliveryStatus = vi
      .fn<RuntimeDeliveryStatusPort['getRuntimeDeliveryStatus']>()
      .mockResolvedValueOnce(null)
      .mockRejectedValueOnce(readError);
    const useCase = new GetRuntimeDeliveryStatusUseCase({ getRuntimeDeliveryStatus });

    await expect(useCase.execute({ teamName: 'Team', messageId: 'missing' })).resolves.toBeNull();
    await expect(useCase.execute({ teamName: 'Team', messageId: 'message-1' })).rejects.toBe(
      readError
    );
  });
});
