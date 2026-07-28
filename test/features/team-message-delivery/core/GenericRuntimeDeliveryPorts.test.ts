import {
  type RuntimeDeliveryStatus,
  TEAM_GET_RUNTIME_DELIVERY_STATUS,
} from '@features/team-message-delivery';
import {
  TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS,
  toOpenCodeRuntimeDeliveryStatus,
  toRuntimeDeliveryStatus,
} from '@features/team-message-delivery/contracts/compatibility/open-code-delivery';
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
    expect(TEAM_GET_OPENCODE_RUNTIME_DELIVERY_STATUS).toBe(TEAM_GET_RUNTIME_DELIVERY_STATUS);
  });

  it('maps the legacy status without cloning or changing transport fields', () => {
    const generic = toRuntimeDeliveryStatus(legacyStatus);

    expect(generic).toBe(legacyStatus);
    expect(toOpenCodeRuntimeDeliveryStatus(generic)).toBe(legacyStatus);
  });

  it('rejects an incompatible provider at the explicit compatibility boundary', () => {
    const status: RuntimeDeliveryStatus = {
      providerId: 'codex',
      attempted: true,
      delivered: false,
      messageId: 'message-2',
    };

    expect(() => toOpenCodeRuntimeDeliveryStatus(status)).toThrow(
      'Expected OpenCode runtime delivery status, received codex'
    );
  });

  it('forwards the neutral query and preserves the returned object', async () => {
    const getRuntimeDeliveryStatus = vi.fn<
      RuntimeDeliveryStatusReaderPort['getRuntimeDeliveryStatus']
    >(() => Promise.resolve(legacyStatus));
    const useCase = new GetRuntimeDeliveryStatusUseCase({ getRuntimeDeliveryStatus });

    await expect(useCase.execute(' Team ', ' message-1 ')).resolves.toBe(legacyStatus);
    expect(getRuntimeDeliveryStatus).toHaveBeenCalledWith(' Team ', ' message-1 ');
  });
});
