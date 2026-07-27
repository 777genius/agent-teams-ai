import { LegacyRuntimeDeliveryAdapter } from '@features/team-provisioning/main/adapters/output/LegacyRuntimeDeliveryAdapter';
import { createTeamProvisioningRuntimeDeliveryFeature } from '@features/team-provisioning/main/composition/createTeamProvisioningRuntimeDeliveryFeature';
import { describe, expect, expectTypeOf, it, vi } from 'vitest';

import type {
  RuntimeDeliveryStatus,
  RuntimeMessageDeliveryAck,
} from '@features/team-provisioning/contracts/runtime-delivery';
import type { LegacyRuntimeDeliveryAdapterDeps } from '@features/team-provisioning/main/adapters/output/LegacyRuntimeDeliveryAdapter';
import type {
  OpenCodeRuntimeControlAck,
  OpenCodeRuntimeControlApi,
} from '@main/services/team/runtime-control';

const OBSERVED_AT = '2026-07-26T10:00:00.000Z';

function acknowledgement(state: 'delivered' | 'duplicate'): RuntimeMessageDeliveryAck {
  return {
    ok: true,
    providerId: 'opencode',
    teamName: 'Team',
    runId: 'run-1',
    state,
    idempotencyKey: 'message-key-1',
    location: {
      kind: 'user_sent_messages',
      teamName: 'Team',
      messageId: 'runtime-delivery-message-1',
    },
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
    diagnostics: ['delivery confirmed'],
  };
}

describe('LegacyRuntimeDeliveryAdapter', () => {
  it('keeps its delivery acknowledgement contract equal to the legacy runtime-control API', () => {
    expectTypeOf<RuntimeMessageDeliveryAck>().toEqualTypeOf<OpenCodeRuntimeControlAck>();
    expectTypeOf<LegacyRuntimeDeliveryAdapterDeps['deliverOpenCodeRuntimeMessage']>().toEqualTypeOf<
      OpenCodeRuntimeControlApi['deliverOpenCodeRuntimeMessage']
    >();
  });

  it('adapts delivery and status through only the two explicit legacy operations', async () => {
    const raw = { idempotencyKey: 'message-key-1' };
    const ack = acknowledgement('delivered');
    const snapshot = status();
    const deps: LegacyRuntimeDeliveryAdapterDeps = {
      deliverOpenCodeRuntimeMessage: vi.fn(() => Promise.resolve(ack)),
      getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(snapshot)),
    };
    const adapter = new LegacyRuntimeDeliveryAdapter(deps);

    await expect(adapter.deliverRuntimeMessage(raw)).resolves.toBe(ack);
    await expect(adapter.getRuntimeDeliveryStatus(' Team ', ' message-1 ')).resolves.toBe(snapshot);
    expect(deps.deliverOpenCodeRuntimeMessage).toHaveBeenCalledWith(raw);
    expect(deps.getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith(' Team ', ' message-1 ');
  });

  it('does not translate legacy delivery or status errors', async () => {
    const deliveryError = new Error('OpenCode runtime delivery rejected: stale_runtime_identity');
    const statusError = new Error('status store unavailable');
    const adapter = new LegacyRuntimeDeliveryAdapter({
      deliverOpenCodeRuntimeMessage: vi.fn(() => Promise.reject(deliveryError)),
      getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.reject(statusError)),
    });

    await expect(adapter.deliverRuntimeMessage({})).rejects.toBe(deliveryError);
    await expect(adapter.getRuntimeDeliveryStatus('Team', 'message-1')).rejects.toBe(statusError);
  });
});

describe('Team Provisioning runtime delivery feature', () => {
  it('composes the command and query behind the stable legacy-shaped API', async () => {
    const raw = { teamName: 'Team', idempotencyKey: 'message-key-1' };
    const ack = acknowledgement('delivered');
    const snapshot = status();
    const deps: LegacyRuntimeDeliveryAdapterDeps = {
      deliverOpenCodeRuntimeMessage: vi.fn(() => Promise.resolve(ack)),
      getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(snapshot)),
    };
    const feature = createTeamProvisioningRuntimeDeliveryFeature(deps);

    await expect(feature.deliverOpenCodeRuntimeMessage(raw)).resolves.toBe(ack);
    await expect(feature.getOpenCodeRuntimeDeliveryStatus('Team', 'message-1')).resolves.toBe(
      snapshot
    );
    expect(deps.deliverOpenCodeRuntimeMessage).toHaveBeenCalledWith(raw);
    expect(deps.getOpenCodeRuntimeDeliveryStatus).toHaveBeenCalledWith('Team', 'message-1');
  });

  it('leaves duplicate detection to the legacy delivery boundary', async () => {
    const raw = { idempotencyKey: 'same-key' };
    const delivered = acknowledgement('delivered');
    const duplicate = acknowledgement('duplicate');
    const deliverOpenCodeRuntimeMessage = vi
      .fn<LegacyRuntimeDeliveryAdapterDeps['deliverOpenCodeRuntimeMessage']>()
      .mockResolvedValueOnce(delivered)
      .mockResolvedValueOnce(duplicate);
    const feature = createTeamProvisioningRuntimeDeliveryFeature({
      deliverOpenCodeRuntimeMessage,
      getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)),
    });

    await expect(
      Promise.all([
        feature.deliverOpenCodeRuntimeMessage(raw),
        feature.deliverOpenCodeRuntimeMessage(raw),
      ])
    ).resolves.toEqual([delivered, duplicate]);
    expect(deliverOpenCodeRuntimeMessage).toHaveBeenCalledTimes(2);
    expect(deliverOpenCodeRuntimeMessage).toHaveBeenNthCalledWith(1, raw);
    expect(deliverOpenCodeRuntimeMessage).toHaveBeenNthCalledWith(2, raw);
  });

  it('preserves null status and legacy rejections at the composed boundary', async () => {
    const rejection = new Error('OpenCode runtime delivery rejected: stale_run');
    const feature = createTeamProvisioningRuntimeDeliveryFeature({
      deliverOpenCodeRuntimeMessage: vi.fn(() => Promise.reject(rejection)),
      getOpenCodeRuntimeDeliveryStatus: vi.fn(() => Promise.resolve(null)),
    });

    await expect(feature.deliverOpenCodeRuntimeMessage({})).rejects.toBe(rejection);
    await expect(
      feature.getOpenCodeRuntimeDeliveryStatus('Team', 'missing-message')
    ).resolves.toBeNull();
  });
});
