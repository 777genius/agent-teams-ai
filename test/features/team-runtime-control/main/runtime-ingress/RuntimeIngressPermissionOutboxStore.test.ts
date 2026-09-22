import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  parseLaneId,
  type RuntimePermissionApprovalIngressAuthority,
} from '@features/team-runtime-control/contracts';
import { type RuntimeIngressPermissionOutboxRecord } from '@features/team-runtime-control/core/application/runtime-ingress';
import {
  emptySnapshot,
  type RuntimeIngressSnapshot,
  validateSnapshot,
} from '@features/team-runtime-control/main/adapters/output/runtime-ingress/runtimeIngressDurableState';
import { RuntimeIngressPermissionOutboxStore } from '@features/team-runtime-control/main/adapters/output/runtime-ingress/RuntimeIngressPermissionOutboxStore';
import { createRuntimeIngressFeature } from '@features/team-runtime-control/main/composition/createRuntimeIngressFeature';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it } from 'vitest';

import {
  createRuntimeIngressAdapterHarness,
  FixtureRelaySecretSource,
  KEYRING,
  runtimeIngressBody,
  runtimeIngressHttpRequest,
} from './fixtures/runtimeIngressAdapterHarness';

const authority: RuntimePermissionApprovalIngressAuthority = Object.freeze({
  deploymentId: parseDeploymentId('deployment_runtime-permission-store'),
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

function effectRecord(): RuntimeIngressPermissionOutboxRecord {
  const digest = 'e'.repeat(64);
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

function durableHarness(record: RuntimeIngressPermissionOutboxRecord) {
  let snapshot: RuntimeIngressSnapshot = Object.freeze({
    ...emptySnapshot(),
    permissionApprovalOutbox: Object.freeze([record]),
  });
  return {
    persistence: {
      exclusive: async <T extends { readonly status: string }>(operation: () => Promise<T>) =>
        operation(),
      loadSnapshot: async () => snapshot,
      persistSnapshot: async (next: RuntimeIngressSnapshot) => {
        snapshot = Object.freeze(next);
      },
    },
    read: () => snapshot,
  };
}

class FixedClock {
  constructor(private nowMs: number) {}

  now(): number {
    return this.nowMs;
  }

  set(value: number): void {
    this.nowMs = value;
  }
}

const claimRequest = Object.freeze({
  ownerId: 'bridge-owner',
  leaseToken: 'bridge-lease-1',
  leaseDurationMs: 60_000,
  limit: 1,
});

describe('RuntimeIngressPermissionOutboxStore', () => {
  it('recovers a stable leased effect after restart and acknowledges only its current generation', async () => {
    const harness = durableHarness(effectRecord());
    const clock = new FixedClock(Date.parse('2026-08-06T10:01:00.000Z'));
    const first = new RuntimeIngressPermissionOutboxStore(harness.persistence, { clock });
    const initialClaim = await first.claimPermissionApprovalIngressEffects(claimRequest);
    const initial = initialClaim[0];
    if (!initial?.lease) throw new Error('runtime-permission-lease-not-claimed');

    clock.set(Date.parse('2026-08-06T10:01:30.000Z'));
    const restarted = new RuntimeIngressPermissionOutboxStore(harness.persistence, { clock });
    const replayClaim = await restarted.claimPermissionApprovalIngressEffects(claimRequest);
    clock.set(Date.parse('2026-08-06T10:02:01.000Z'));
    const reclaimed = await restarted.claimPermissionApprovalIngressEffects({
      ownerId: 'bridge-owner-2',
      leaseToken: 'bridge-lease-2',
      leaseDurationMs: 60_000,
      limit: 1,
    });
    const current = reclaimed[0];
    if (!current?.lease) throw new Error('runtime-permission-lease-not-reclaimed');

    clock.set(Date.parse('2026-08-06T10:02:02.000Z'));
    const stale = await restarted.acknowledgePermissionApprovalIngressEffect({
      outboxId: initial.outboxId,
      generation: initial.lease.generation,
      ownerId: 'bridge-owner',
      leaseToken: 'bridge-lease-1',
    });
    const acknowledged = await restarted.acknowledgePermissionApprovalIngressEffect({
      outboxId: current.outboxId,
      generation: current.lease.generation,
      ownerId: 'bridge-owner-2',
      leaseToken: 'bridge-lease-2',
    });
    const replayAcknowledged = await restarted.acknowledgePermissionApprovalIngressEffect({
      outboxId: current.outboxId,
      generation: current.lease.generation,
      ownerId: 'bridge-owner-2',
      leaseToken: 'bridge-lease-2',
    });

    expect(replayClaim).toHaveLength(1);
    expect(replayClaim[0]?.lease).toEqual(initial.lease);
    expect(current.outboxId).toBe(initial.outboxId);
    expect(current.lease.generation).toBe(initial.lease.generation + 1);
    expect(stale).toEqual({ status: 'conflict' });
    expect(acknowledged).toEqual({ status: 'acknowledged' });
    expect(replayAcknowledged).toEqual({ status: 'already_acknowledged' });
    expect(harness.read().permissionApprovalOutbox?.[0]?.acknowledgedAtIso).toBe(
      '2026-08-06T10:02:02.000Z'
    );
  });

  it('rejects caller-sized and clock-skewed lease state after a restart', async () => {
    const clock = new FixedClock(Date.parse('2026-08-06T10:01:00.000Z'));
    const future = effectRecord();
    const harness = durableHarness(
      Object.freeze({
        ...future,
        lease: Object.freeze({
          generation: 1,
          ownerId: 'bridge-owner',
          leaseToken: 'bridge-lease-1',
          claimedAtIso: '2026-08-06T10:02:00.000Z',
          leaseExpiresAtIso: '2026-08-06T10:03:00.000Z',
        }),
      })
    );
    const restarted = new RuntimeIngressPermissionOutboxStore(harness.persistence, { clock });

    await expect(
      restarted.claimPermissionApprovalIngressEffects({
        ...claimRequest,
        leaseDurationMs: 5 * 60 * 1_000 + 1,
      })
    ).resolves.toEqual([]);
    await expect(restarted.claimPermissionApprovalIngressEffects(claimRequest)).rejects.toThrow(
      'runtime-ingress-permission-outbox-claim-unavailable'
    );
    expect(harness.read().permissionApprovalOutbox?.[0]?.lease).toMatchObject({ generation: 1 });

    const oversizedHarness = durableHarness(
      Object.freeze({
        ...effectRecord(),
        lease: Object.freeze({
          generation: 1,
          ownerId: 'bridge-owner',
          leaseToken: 'bridge-lease-1',
          claimedAtIso: '2026-08-06T10:00:00.000Z',
          leaseExpiresAtIso: '2026-08-06T10:05:01.000Z',
        }),
      })
    );
    await expect(
      new RuntimeIngressPermissionOutboxStore(oversizedHarness.persistence, {
        clock,
      }).claimPermissionApprovalIngressEffects(claimRequest)
    ).rejects.toThrow('runtime-ingress-permission-outbox-claim-unavailable');
  });

  it('binds one delivery ref to one exact permission intent and keeps the published snapshot restart-readable', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'runtime-ingress-permission-outbox-'));
    try {
      const harness = await createRuntimeIngressAdapterHarness(directory);
      await expect(
        harness.feature.httpInput.handle(runtimeIngressHttpRequest())
      ).resolves.toMatchObject({
        statusCode: 202,
      });
      const payload = Object.freeze({
        schemaVersion: 1,
        deliveryRef: 'delivery_ref_runtime-permission-1',
        category: 'command',
        summary: 'Allow the bounded command',
        expiresAtMs: null,
        preview: null,
      });
      const firstRequest = runtimeIngressHttpRequest(
        runtimeIngressBody(payload, 'command:fixture:permission:1', 2, '2026-07-27T10:00:31.000Z'),
        { verb: 'runtime.permission-request' }
      );
      await expect(harness.feature.httpInput.handle(firstRequest)).resolves.toMatchObject({
        statusCode: 202,
      });
      await expect(harness.feature.httpInput.handle(firstRequest)).resolves.toMatchObject({
        statusCode: 200,
        body: { status: 'replayed' },
      });
      await expect(
        harness.feature.httpInput.handle(
          runtimeIngressHttpRequest(
            runtimeIngressBody(
              { ...payload, summary: 'Changed command body' },
              'command:fixture:permission:1',
              2,
              '2026-07-27T10:00:31.000Z'
            ),
            { verb: 'runtime.permission-request' }
          )
        )
      ).resolves.toMatchObject({ statusCode: 409 });
      await expect(
        harness.feature.httpInput.handle(
          runtimeIngressHttpRequest(
            runtimeIngressBody(
              payload,
              'command:fixture:permission:2',
              3,
              '2026-07-27T10:00:32.000Z'
            ),
            { verb: 'runtime.permission-request' }
          )
        )
      ).resolves.toMatchObject({ statusCode: 409 });

      const persisted = JSON.parse(
        await readFile(join(directory, 'runtime-ingress-state.json'), 'utf8')
      ) as { readonly permissionApprovalOutbox?: readonly RuntimeIngressPermissionOutboxRecord[] };
      const row = persisted.permissionApprovalOutbox?.[0];
      if (!row) throw new Error('runtime-permission-outbox-row-missing');
      expect(() => validateSnapshot(persisted)).not.toThrow();
      expect(() =>
        validateSnapshot({
          ...persisted,
          permissionApprovalOutbox: [
            {
              ...row,
              payloadJson: JSON.stringify({ ...payload, summary: 'Mismatched persisted intent' }),
            },
          ],
        })
      ).toThrow('runtime-ingress-permission-outbox-integrity');

      const restarted = createRuntimeIngressFeature({
        snapshotPath: join(directory, 'runtime-ingress-state.json'),
        keyring: KEYRING,
        antiRollbackFence: harness.antiRollbackFence,
        relaySecretSource: new FixtureRelaySecretSource(),
        relayAuthoritySource: harness.relayAuthoritySource,
        clock: harness.clock,
        nextRequestId: () => 'runtime-ingress-permission-restart',
      });
      await expect(restarted.httpInput.handle(firstRequest)).resolves.toMatchObject({
        statusCode: 200,
        body: { status: 'replayed' },
      });
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
