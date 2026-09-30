import {
  type RuntimeDeliveryDebugDetails,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
} from '@features/team-message-delivery';
import { GetRuntimeDeliveryStatusUseCase } from '@features/team-message-delivery/core/application/use-cases/GetRuntimeDeliveryStatusUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeDeliveryStatusReaderPort } from '@features/team-message-delivery/core/application/use-cases/GetRuntimeDeliveryStatusUseCase';
import type { OpenCodeRuntimeDeliveryStatus } from '@shared/types';

const legacyStatus: OpenCodeRuntimeDeliveryStatus = {
  providerId: 'opencode',
  attempted: true,
  delivered: true,
  accepted: true,
  messageId: 'message-1',
  diagnostics: ['confirmed'],
};

describe('generic runtime delivery contracts', () => {
  it('preserves the legacy channel value behind a provider-neutral export', () => {
    expect(TEAM_GET_RUNTIME_DELIVERY_STATUS).toBe('team:getOpenCodeRuntimeDeliveryStatus');
  });

  it('forwards the neutral query and preserves the returned object', async () => {
    const getRuntimeDeliveryStatus = vi.fn<
      RuntimeDeliveryStatusReaderPort['getRuntimeDeliveryStatus']
    >(() => Promise.resolve(legacyStatus));
    const useCase = new GetRuntimeDeliveryStatusUseCase({ getRuntimeDeliveryStatus });

    await expect(useCase.execute(' Team ', ' message-1 ')).resolves.toBe(legacyStatus);
    expect(getRuntimeDeliveryStatus).toHaveBeenCalledWith(' Team ', ' message-1 ');
  });

  it('publishes neutral renderer debug details from the stable feature root', () => {
    const details: RuntimeDeliveryDebugDetails = {
      messageId: 'message-1',
      providerId: 'opencode',
      delivered: true,
      responsePending: false,
      responseState: 'responded_visible_message',
      ledgerStatus: 'responded',
      acceptanceUnknown: false,
      reason: null,
      diagnostics: [],
    };

    expect(details.providerId).toBe(legacyStatus.providerId);
  });
});
