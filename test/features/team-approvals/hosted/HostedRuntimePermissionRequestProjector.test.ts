import {
  type HostedRuntimePermissionIngressAuthorityPort,
  HostedRuntimePermissionRequestProjector,
  type HostedTeamApprovalPendingIngressPort,
} from '@features/team-approvals/main/hosted';
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

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalPendingReadRecord,
  HostedTeamApprovalPendingStorageRecord,
} from '@features/internal-storage/contracts';

const NOW = Date.parse('2026-08-06T10:01:00.000Z');
const authority: RuntimePermissionApprovalIngressAuthority = Object.freeze({
  deploymentId: parseDeploymentId('deployment_runtime-permission-projector'),
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
const scope: HostedTeamApprovalAuthorityScope = Object.freeze({
  principalId: 'operator_runtime-permission',
  workspaceId: 'workspace_runtime-permission',
  teamId: authority.teamId,
  authorityGeneration: 'authority_runtime-permission-1',
  restoreGeneration: 1,
});

function createRecord(
  lease: RuntimeIngressPermissionOutboxRecord['lease'] = null
): RuntimeIngressPermissionOutboxRecord {
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
    lease,
    acknowledgedAtIso: null,
  });
}

function toPendingRead(
  record: HostedTeamApprovalPendingStorageRecord
): HostedTeamApprovalPendingReadRecord {
  return Object.freeze({
    approvalId: record.approvalId,
    approvalGeneration: record.approvalGeneration,
    category: record.category,
    summary: record.summary,
    requestedAtMs: record.requestedAtMs,
    expiresAtMs: record.expiresAtMs,
    previewRef: record.preview?.previewRef ?? null,
  });
}

function leasedRecord(
  request: Parameters<
    RuntimeIngressPermissionOutboxPort['claimPermissionApprovalIngressEffects']
  >[0],
  expiresAtIso = new Date(NOW + request.leaseDurationMs).toISOString()
): RuntimeIngressPermissionOutboxRecord {
  return createRecord(
    Object.freeze({
      generation: 1,
      ownerId: request.ownerId,
      leaseToken: request.leaseToken,
      claimedAtIso: new Date(NOW).toISOString(),
      leaseExpiresAtIso: expiresAtIso,
    })
  );
}

const projectionRequest = Object.freeze({
  ownerId: 'bridge-owner',
  leaseToken: 'bridge-lease',
  leaseDurationMs: 60_000,
  limit: 1,
  deadlineAtMs: NOW + 120_000,
});

describe('HostedRuntimePermissionRequestProjector', () => {
  it('recovers before and after projection without losing or duplicating the stable pending approval', async () => {
    const claimPermissionApprovalIngressEffects = vi.fn<
      RuntimeIngressPermissionOutboxPort['claimPermissionApprovalIngressEffects']
    >(async (request) => [leasedRecord(request)]);
    let acknowledgementAttempt = 0;
    const acknowledgePermissionApprovalIngressEffect = vi.fn<
      RuntimeIngressPermissionOutboxPort['acknowledgePermissionApprovalIngressEffect']
    >(async () => {
      acknowledgementAttempt += 1;
      if (acknowledgementAttempt === 1) throw new Error('crash-after-pending-persist');
      return Object.freeze({ status: 'acknowledged' as const });
    });
    const pendingByIdentity = new Map<string, HostedTeamApprovalPendingStorageRecord>();
    let observeAttempt = 0;
    const observePending = vi.fn<HostedTeamApprovalPendingIngressPort['observePending']>(
      async (record) => {
        observeAttempt += 1;
        if (observeAttempt === 1) throw new Error('crash-before-pending-persist');
        const identity = `${record.approvalId}:${record.approvalGeneration}`;
        const existing = pendingByIdentity.get(identity);
        if (existing) expect(record).toEqual(existing);
        else pendingByIdentity.set(identity, record);
        return toPendingRead(existing ?? record);
      }
    );
    const resolvePersistedIngressAuthority = vi.fn<
      HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']
    >(async (persistedAuthority) => {
      expect(persistedAuthority).toEqual(authority);
      return Object.freeze({ status: 'resolved' as const, scope });
    });
    let now = NOW;
    const projector = new HostedRuntimePermissionRequestProjector(
      new RuntimeIngressPermissionOutbox({
        claimPermissionApprovalIngressEffects,
        acknowledgePermissionApprovalIngressEffect,
      }),
      { observePending },
      { resolvePersistedIngressAuthority },
      { now: () => now }
    );

    await expect(projector.project(projectionRequest)).resolves.toEqual({
      claimed: 1,
      projected: 0,
      acknowledged: 0,
      retained: 1,
    });
    await expect(projector.project(projectionRequest)).resolves.toEqual({
      claimed: 1,
      projected: 1,
      acknowledged: 0,
      retained: 1,
    });
    now += 1_000;
    await expect(projector.project(projectionRequest)).resolves.toEqual({
      claimed: 1,
      projected: 1,
      acknowledged: 1,
      retained: 0,
    });

    expect(pendingByIdentity).toHaveLength(1);
    expect([...pendingByIdentity.values()][0]).toMatchObject({
      scope,
      deliveryRef: 'delivery_ref_runtime-permission-1',
      observedAtMs: Date.parse('2026-08-06T10:00:01.000Z'),
    });
    expect(acknowledgePermissionApprovalIngressEffect).toHaveBeenCalledTimes(2);
    expect(resolvePersistedIngressAuthority).toHaveBeenCalledTimes(3);
  });

  it('fails closed for stale, wrong-lane, and self-approval authority results', async () => {
    const authorityResults = [
      Object.freeze({ status: 'stale_generation' as const }),
      Object.freeze({ status: 'wrong_lane' as const }),
      Object.freeze({ status: 'self_approval' as const }),
      Object.freeze({
        status: 'resolved' as const,
        scope: Object.freeze({ ...scope, principalId: authority.deliveryOwnerId }),
      }),
    ] as const;

    for (const result of authorityResults) {
      const claimPermissionApprovalIngressEffects = vi.fn<
        RuntimeIngressPermissionOutboxPort['claimPermissionApprovalIngressEffects']
      >(async (request) => [leasedRecord(request)]);
      const acknowledgePermissionApprovalIngressEffect = vi.fn<
        RuntimeIngressPermissionOutboxPort['acknowledgePermissionApprovalIngressEffect']
      >(async () => Object.freeze({ status: 'acknowledged' as const }));
      const observePending = vi.fn<HostedTeamApprovalPendingIngressPort['observePending']>();
      const resolvePersistedIngressAuthority = vi.fn<
        HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']
      >(async () => result);
      const projector = new HostedRuntimePermissionRequestProjector(
        new RuntimeIngressPermissionOutbox({
          claimPermissionApprovalIngressEffects,
          acknowledgePermissionApprovalIngressEffect,
        }),
        { observePending },
        { resolvePersistedIngressAuthority },
        { now: () => NOW }
      );

      await expect(projector.project(projectionRequest)).resolves.toEqual({
        claimed: 1,
        projected: 0,
        acknowledged: 0,
        retained: 1,
      });
      expect(observePending).not.toHaveBeenCalled();
      expect(acknowledgePermissionApprovalIngressEffect).not.toHaveBeenCalled();
    }
  });

  it('has zero effects when a claimed record no longer has an open lease', async () => {
    const claimPermissionApprovalIngressEffects = vi.fn<
      RuntimeIngressPermissionOutboxPort['claimPermissionApprovalIngressEffects']
    >(async () => [
      createRecord(
        Object.freeze({
          generation: 1,
          ownerId: projectionRequest.ownerId,
          leaseToken: projectionRequest.leaseToken,
          claimedAtIso: '2026-08-06T09:59:00.000Z',
          leaseExpiresAtIso: '2026-08-06T10:00:30.000Z',
        })
      ),
    ]);
    const acknowledgePermissionApprovalIngressEffect = vi.fn<
      RuntimeIngressPermissionOutboxPort['acknowledgePermissionApprovalIngressEffect']
    >(async () => Object.freeze({ status: 'acknowledged' as const }));
    const observePending = vi.fn<HostedTeamApprovalPendingIngressPort['observePending']>();
    const resolvePersistedIngressAuthority = vi.fn<
      HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']
    >(async () => Object.freeze({ status: 'resolved' as const, scope }));
    const projector = new HostedRuntimePermissionRequestProjector(
      new RuntimeIngressPermissionOutbox({
        claimPermissionApprovalIngressEffects,
        acknowledgePermissionApprovalIngressEffect,
      }),
      { observePending },
      { resolvePersistedIngressAuthority },
      { now: () => NOW }
    );

    await expect(projector.project(projectionRequest)).resolves.toEqual({
      claimed: 1,
      projected: 0,
      acknowledged: 0,
      retained: 1,
    });
    expect(resolvePersistedIngressAuthority).not.toHaveBeenCalled();
    expect(observePending).not.toHaveBeenCalled();
    expect(acknowledgePermissionApprovalIngressEffect).not.toHaveBeenCalled();
  });
});
