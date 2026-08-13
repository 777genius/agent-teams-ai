import {
  createHostedTeamApprovalRuntimeBridge,
  type HostedApprovalDecisionExternalLifecycleDeliveryPort,
  type HostedApprovalDecisionReconciliationPort,
  type HostedRuntimePermissionIngressAuthorityPort,
  type HostedTeamApprovalDeliveryOutboxPort,
  type HostedTeamApprovalPendingIngressPort,
} from '@features/team-approvals/main/hosted';
import {
  parseLaneId,
  type RuntimePermissionApprovalIngressAuthority,
} from '@features/team-runtime-control/contracts';
import {
  parseDeploymentId,
  parseMemberId,
  parseRunId,
  parseTeamId,
} from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDeliveryRecord,
  HostedTeamApprovalPendingStorageRecord,
} from '@features/internal-storage/contracts';
import type {
  RuntimeIngressPermissionOutboxPort,
  RuntimeIngressPermissionOutboxRecord,
} from '@features/team-runtime-control/core/application/runtime-ingress';

const NOW = Date.parse('2026-08-06T12:00:00.000Z');
const authority: RuntimePermissionApprovalIngressAuthority = Object.freeze({
  deploymentId: parseDeploymentId('deployment_runtime-permission-bridge'),
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

function ingressRecord(): RuntimeIngressPermissionOutboxRecord {
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
    observedAtIso: '2026-08-06T11:59:00.000Z',
    acceptedAtIso: '2026-08-06T11:59:01.000Z',
    lease: Object.freeze({
      generation: 1,
      ownerId: 'bridge-owner',
      leaseToken: 'bridge-lease',
      claimedAtIso: '2026-08-06T12:00:00.000Z',
      leaseExpiresAtIso: '2026-08-06T12:01:00.000Z',
    }),
    acknowledgedAtIso: null,
  });
}

function deliveryRecord(): HostedTeamApprovalDeliveryRecord {
  return Object.freeze({
    deliveryId: 'approval_delivery_runtime-permission-1',
    workspaceId: `workspace_${'a'.repeat(32)}`,
    authorityGeneration: 'generation_mount-1',
    restoreGeneration: 1,
    principal: Object.freeze({ kind: 'operator' as const, actorId: 'actor_approval-decider-1' }),
    partition: { teamId: authority.teamId, runId: authority.runId },
    requestId: 'permission-request-1',
    approvalId: `approval_${'d'.repeat(32)}`,
    approvalGeneration: `generation_runtime-permission-${'e'.repeat(64)}`,
    decision: 'deny',
    payloadHash: 'f'.repeat(64),
    deliveryRef: 'delivery_ref_runtime-permission-1',
    deliveryGeneration: 1,
    ownerId: 'bridge-owner',
    leaseToken: 'bridge-lease',
    claimedAtMs: NOW,
    leaseExpiresAtMs: NOW + 60_000,
    createdAtMs: NOW - 1_000,
  });
}

describe('createHostedTeamApprovalRuntimeBridge', () => {
  it('exposes only bounded durable outbox handlers through the existing lifecycle compatibility seam', async () => {
    const record = ingressRecord();
    const claimPermissionApprovalIngressEffects = vi.fn<
      RuntimeIngressPermissionOutboxPort['claimPermissionApprovalIngressEffects']
    >(async () => [record]);
    const acknowledgePermissionApprovalIngressEffect = vi.fn<
      RuntimeIngressPermissionOutboxPort['acknowledgePermissionApprovalIngressEffect']
    >(async () => Object.freeze({ status: 'acknowledged' as const }));
    const observedPending: HostedTeamApprovalPendingStorageRecord[] = [];
    const observePending = vi.fn<HostedTeamApprovalPendingIngressPort['observePending']>(
      async (pending) => {
        observedPending.push(pending);
        return Object.freeze({
          runId: pending.runId,
          requestId: pending.requestId,
          approvalId: pending.approvalId,
          approvalGeneration: pending.approvalGeneration,
          category: pending.category,
          summary: pending.summary,
          requestedAtMs: pending.requestedAtMs,
          expiresAtMs: pending.expiresAtMs,
          previewRef: pending.preview?.previewRef ?? null,
        });
      }
    );
    const resolvePersistedIngressAuthority = vi.fn<
      HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']
    >(async () => Object.freeze({ status: 'resolved' as const, scope }));
    const delivery = deliveryRecord();
    const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
      async (request) => [{ ...delivery, leaseToken: request.leaseToken }]
    );
    const acknowledgeDelivery = vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>(
      async () => undefined
    );
    const markDeliveryOperatorRequired =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired']>();
    const readDeliveryReconciliation = vi.fn<
      HostedTeamApprovalDeliveryOutboxPort['readDeliveryReconciliation']
    >(async () => ({ kind: 'not_found' as const }));
    const settleDeliveryReconciliation =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['settleDeliveryReconciliation']>();
    const deliverRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >(async () => Object.freeze({ status: 'delivered' as const }));
    const reconcileRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionReconciliationPort['reconcileRuntimePermissionDecision']
    >(async () => Object.freeze({ status: 'operator_required' as const }));
    const bridge = createHostedTeamApprovalRuntimeBridge({
      ingressEffectOutbox: {
        claimPermissionApprovalIngressEffects,
        acknowledgePermissionApprovalIngressEffect,
      },
      pendingIngress: { observePending },
      ingressAuthority: { resolvePersistedIngressAuthority },
      deliveryOutbox: {
        claimDeliveries,
        acknowledgeDelivery,
        markDeliveryOperatorRequired,
        readDeliveryReconciliation,
        settleDeliveryReconciliation,
      },
      externalDecisionDelivery: { deliverRuntimePermissionDecision },
      externalDecisionReconciliation: { reconcileRuntimePermissionDecision },
      clock: { now: () => NOW },
    });

    expect(Object.isFrozen(bridge)).toBe(true);
    expect(Object.keys(bridge).sort()).toEqual([
      'deliverApprovalDecisions',
      'projectRuntimePermissionRequests',
      'reconcileApprovalDecision',
    ]);
    await expect(
      bridge.projectRuntimePermissionRequests({
        ownerId: 'bridge-owner',
        leaseToken: 'bridge-lease',
        leaseDurationMs: 60_000,
        limit: 1,
        deadlineAtMs: NOW + 120_000,
      })
    ).resolves.toEqual({ claimed: 1, projected: 1, acknowledged: 1, retained: 0 });
    await expect(
      bridge.deliverApprovalDecisions({
        workspaceId: delivery.workspaceId,
        teamId: delivery.partition.teamId,
        authorityGeneration: delivery.authorityGeneration,
        restoreGeneration: delivery.restoreGeneration,
        ownerId: 'bridge-owner',
        leaseToken: 'bridge-lease',
        leaseDurationMs: 60_000,
        limit: 1,
        deadlineAtMs: NOW + 120_000,
      })
    ).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      acknowledged: 1,
      retained: 0,
      operatorRequired: 0,
    });

    expect(observedPending).toHaveLength(1);
    expect(observedPending[0]).toMatchObject({ scope, deliveryRef: record.deliveryRef });
    expect(deliverRuntimePermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDeliveryId: delivery.deliveryId,
        decision: 'deny',
        partition: delivery.partition,
        requestId: delivery.requestId,
      })
    );
  });
});
