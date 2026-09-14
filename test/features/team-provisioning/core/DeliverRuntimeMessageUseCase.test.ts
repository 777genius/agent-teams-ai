import {
  type DeliverRuntimeMessageCommand,
  DeliverRuntimeMessageUseCase,
} from '@features/team-provisioning/core/application/commands/DeliverRuntimeMessageUseCase';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeMessageDeliveryAck } from '@features/team-provisioning/contracts/runtime-delivery';
import type { RuntimeMessageDeliveryPort } from '@features/team-provisioning/core/application/ports/RuntimeDeliveryPort';

const OBSERVED_AT = '2026-07-26T10:00:00.000Z';

function acknowledgement(state: 'delivered' | 'duplicate'): RuntimeMessageDeliveryAck {
  return {
    ok: true,
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    state,
    idempotencyKey: 'message-key-1',
    diagnostics: state === 'duplicate' ? ['duplicate'] : [],
    observedAt: OBSERVED_AT,
  };
}

describe('DeliverRuntimeMessageUseCase', () => {
  it('forwards the raw ingress value unchanged and returns the exact legacy acknowledgement', async () => {
    const raw = {
      teamName: ' Team ',
      runId: 'run-1',
      text: 'Delivered text',
    };
    const ack = acknowledgement('delivered');
    const deliverRuntimeMessage = vi.fn<RuntimeMessageDeliveryPort['deliverRuntimeMessage']>(() =>
      Promise.resolve(ack)
    );
    const useCase = new DeliverRuntimeMessageUseCase({ deliverRuntimeMessage });

    await expect(useCase.execute({ input: raw })).resolves.toBe(ack);
    expect(deliverRuntimeMessage).toHaveBeenCalledWith(raw);
  });

  it('does not add command-level idempotency or coalesce concurrent deliveries', async () => {
    const command: DeliverRuntimeMessageCommand = { input: { idempotencyKey: 'same-key' } };
    const firstAck = acknowledgement('delivered');
    const secondAck = acknowledgement('duplicate');
    const deliverRuntimeMessage = vi
      .fn<RuntimeMessageDeliveryPort['deliverRuntimeMessage']>()
      .mockResolvedValueOnce(firstAck)
      .mockResolvedValueOnce(secondAck);
    const useCase = new DeliverRuntimeMessageUseCase({ deliverRuntimeMessage });

    await expect(
      Promise.all([useCase.execute(command), useCase.execute(command)])
    ).resolves.toEqual([firstAck, secondAck]);
    expect(deliverRuntimeMessage).toHaveBeenCalledTimes(2);
  });

  it('preserves downstream rejection and cancellation errors by identity', async () => {
    const rejection = new Error('OpenCode runtime delivery rejected: stale_run');
    const cancellation = Object.assign(new Error('cancelled'), { name: 'AbortError' });
    const deliverRuntimeMessage = vi
      .fn<RuntimeMessageDeliveryPort['deliverRuntimeMessage']>()
      .mockRejectedValueOnce(rejection)
      .mockRejectedValueOnce(cancellation);
    const useCase = new DeliverRuntimeMessageUseCase({ deliverRuntimeMessage });

    await expect(useCase.execute({ input: {} })).rejects.toBe(rejection);
    await expect(useCase.execute({ input: {} })).rejects.toBe(cancellation);
  });
});
