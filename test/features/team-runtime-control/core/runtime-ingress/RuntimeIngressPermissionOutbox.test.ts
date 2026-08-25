import {
  parseLaneId,
  type RuntimePermissionApprovalIngressAuthority,
} from '@features/team-runtime-control/contracts';
import {
  RuntimeIngressPermissionOutbox,
  type RuntimeIngressPermissionOutboxPort,
  type RuntimeIngressPermissionOutboxRecord,
} from '@features/team-runtime-control/core/application/runtime-ingress';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

const authority: RuntimePermissionApprovalIngressAuthority = Object.freeze({
  deploymentId: parseDeploymentId('deployment_runtime-permission-outbox'),
  teamId: parseTeamId(`team_${'a'.repeat(32)}`),
  runId: parseRunId(`run_${'b'.repeat(32)}`),
  planGeneration: 3,
  laneId: parseLaneId('lane:opencode:runtime-permission'),
  providerId: 'opencode',
  credentialGeneration: 2,
  credentialId: 'credential:runtime-permission:1',
  sessionId: 'session:runtime-permission:1',
  runtimeInstanceId: 'runtime-instance:runtime-permission:1',
  deliveryOwnerId: parseMemberId(`member_${'c'.repeat(32)}`),
});

function record(): RuntimeIngressPermissionOutboxRecord {
  const digest = 'd'.repeat(64);
  return Object.freeze({
    outboxVersion: 1,
    outboxId: `runtime_permission:effect:${digest}`,
    commandId: 'command:runtime-permission:1',
    effectRef: `effect:${digest}`,
    deliveryRef: 'delivery_ref_runtime-permission-1',
    authority,
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      deliveryRef: 'delivery_ref_runtime-permission-1',
      category: 'command',
      summary: 'Allow the bounded command',
      expiresAtMs: null,
      preview: null,
    }),
    observedAtIso: '2026-08-06T10:00:00.000Z',
    acceptedAtIso: '2026-08-06T10:00:01.000Z',
    lease: null,
    acknowledgedAtIso: null,
  });
}

describe('RuntimeIngressPermissionOutbox', () => {
  it('fails closed on a malformed claimed batch and delegates acknowledgement', async () => {
    const valid = record();
    const claimPermissionApprovalIngressEffects = vi.fn(async () => [
      valid,
      { ...valid, deliveryRef: 'delivery_ref_mismatch-1' } as RuntimeIngressPermissionOutboxRecord,
    ]);
    const acknowledgePermissionApprovalIngressEffect = vi.fn(async () => ({
      status: 'acknowledged' as const,
    }));
    const port: RuntimeIngressPermissionOutboxPort = {
      claimPermissionApprovalIngressEffects,
      acknowledgePermissionApprovalIngressEffect,
    };
    const outbox = new RuntimeIngressPermissionOutbox(port);

    await expect(outbox.claim({
      ownerId: 'bridge-owner',
      leaseToken: 'bridge-lease',
      leaseDurationMs: 60_000,
      limit: 1,
    })).rejects.toThrow('runtime-ingress-permission-outbox-claim-unavailable');
    const acknowledged = await outbox.acknowledge({
      outboxId: valid.outboxId,
      generation: 1,
      ownerId: 'bridge-owner',
      leaseToken: 'bridge-lease',
    });

    expect(acknowledged).toEqual({ status: 'acknowledged' });
    expect(acknowledgePermissionApprovalIngressEffect).toHaveBeenCalledTimes(1);
  });

  it('rejects malformed claim and acknowledgement requests before they reach durable storage', async () => {
    const claimPermissionApprovalIngressEffects = vi.fn(async () => [record()]);
    const acknowledgePermissionApprovalIngressEffect = vi.fn(async () => ({
      status: 'acknowledged' as const,
    }));
    const outbox = new RuntimeIngressPermissionOutbox({
      claimPermissionApprovalIngressEffects,
      acknowledgePermissionApprovalIngressEffect,
    });

    await expect(
      outbox.claim({
        ownerId: 'bridge-owner',
        leaseToken: 'bridge-lease',
        leaseDurationMs: 5 * 60 * 1_000 + 1,
        limit: 1,
      })
    ).rejects.toThrow('runtime-ingress-permission-outbox-claim-invalid');
    await expect(
      outbox.acknowledge({
        outboxId: 'runtime_permission:effect:not-a-digest',
        generation: 1,
        ownerId: 'bridge-owner',
        leaseToken: 'invalid lease token',
      })
    ).resolves.toEqual({ status: 'conflict' });

    expect(claimPermissionApprovalIngressEffects).not.toHaveBeenCalled();
    expect(acknowledgePermissionApprovalIngressEffect).not.toHaveBeenCalled();
  });
});
