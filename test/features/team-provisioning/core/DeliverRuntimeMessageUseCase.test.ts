import {
  type DeliverRuntimeMessageCommand,
  DeliverRuntimeMessageUseCase,
} from '@features/team-provisioning/core/application/commands/DeliverRuntimeMessageUseCase';
import {
  type GetRuntimeDeliveryStatusQuery,
  GetRuntimeDeliveryStatusUseCase,
} from '@features/team-provisioning/core/application/queries/GetRuntimeDeliveryStatusUseCase';
import { describe, expect, it, vi } from 'vitest';

import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
} from '@features/team-provisioning/contracts/runtime-delivery';
import type {
  RuntimeDeliveryStatusPort,
  RuntimeMessageDeliveryPort,
} from '@features/team-provisioning/core/application/ports/RuntimeDeliveryPort';

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

function status(): RuntimeDeliveryStatus {
  return {
    providerId: 'opencode',
    attempted: true,
    delivered: true,
    messageId: 'message-1',
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

    await expect(useCase.execute({ raw })).resolves.toBe(ack);
    expect(deliverRuntimeMessage).toHaveBeenCalledWith(raw);
  });

  it('does not add command-level idempotency or coalesce concurrent deliveries', async () => {
    const command: DeliverRuntimeMessageCommand = { raw: { idempotencyKey: 'same-key' } };
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

    await expect(useCase.execute({ raw: {} })).rejects.toBe(rejection);
    await expect(useCase.execute({ raw: {} })).rejects.toBe(cancellation);
  });
});

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
