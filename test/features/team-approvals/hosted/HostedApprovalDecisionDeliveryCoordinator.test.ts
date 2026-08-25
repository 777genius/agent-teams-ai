import {
  HostedApprovalDecisionDeliveryCoordinator,
  type HostedApprovalDecisionExternalLifecycleDeliveryPort,
  type HostedTeamApprovalDeliveryOutboxPort,
} from '@features/team-approvals/main/hosted';
import { describe, expect, it, vi } from 'vitest';

import type {
  HostedTeamApprovalAuthorityScope,
  HostedTeamApprovalDeliveryRecord,
} from '@features/internal-storage/contracts';

const NOW = Date.parse('2026-08-06T11:00:00.000Z');
const scope: HostedTeamApprovalAuthorityScope = Object.freeze({
  principalId: 'operator_runtime-permission',
  workspaceId: 'workspace_runtime-permission',
  teamId: `team_${'a'.repeat(32)}`,
  authorityGeneration: 'authority_runtime-permission-1',
  restoreGeneration: 1,
});
const request = Object.freeze({
  scope,
  ownerId: 'bridge-owner',
  leaseToken: 'bridge-lease',
  leaseDurationMs: 60_000,
  limit: 1,
  deadlineAtMs: NOW + 120_000,
});

function deliveryRecord(
  overrides: Partial<HostedTeamApprovalDeliveryRecord> = {}
): HostedTeamApprovalDeliveryRecord {
  return Object.freeze({
    deliveryId: 'approval_delivery_runtime-permission-1',
    scope,
    approvalId: `approval_${'b'.repeat(32)}`,
    approvalGeneration: `generation_runtime-permission-${'c'.repeat(64)}`,
    decision: 'allow',
    payloadHash: 'd'.repeat(64),
    deliveryRef: 'delivery_ref_runtime-permission-1',
    deliveryGeneration: 1,
    ownerId: request.ownerId,
    leaseToken: request.leaseToken,
    claimedAtMs: NOW,
    leaseExpiresAtMs: NOW + 60_000,
    createdAtMs: NOW - 1_000,
    ...overrides,
  });
}

describe('HostedApprovalDecisionDeliveryCoordinator', () => {
  it('recovers after provider delivery with a stable idempotency key and acknowledges only after replay proof', async () => {
    const record = deliveryRecord();
    const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
      async () => [record]
    );
    let acknowledgeAttempt = 0;
    const acknowledgeDelivery = vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>(
      async () => {
        acknowledgeAttempt += 1;
        if (acknowledgeAttempt === 1) throw new Error('crash-after-provider-delivery');
      }
    );
    let deliveryAttempt = 0;
    const deliverRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >(async () => {
      deliveryAttempt += 1;
      return Object.freeze({
        status: deliveryAttempt === 1 ? ('delivered' as const) : ('idempotent_replay' as const),
      });
    });
    const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
      { claimDeliveries, acknowledgeDelivery },
      { deliverRuntimePermissionDecision },
      { now: () => NOW }
    );

    await expect(coordinator.deliver(request)).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      acknowledged: 0,
      retained: 1,
    });
    await expect(coordinator.deliver(request)).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      acknowledged: 1,
      retained: 0,
    });

    expect(deliverRuntimePermissionDecision).toHaveBeenCalledTimes(2);
    expect(deliverRuntimePermissionDecision).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({ providerDeliveryId: record.deliveryId, decision: 'allow', scope })
    );
    expect(deliverRuntimePermissionDecision).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({ providerDeliveryId: record.deliveryId, decision: 'allow', scope })
    );
    expect(acknowledgeDelivery).toHaveBeenCalledTimes(2);
  });

  it('retains provider-rejected deliveries without acknowledgement', async () => {
    const rejectedStatuses = [
      'stale_generation',
      'expired',
      'wrong_lane',
      'self_approval',
      'unavailable',
    ] as const;

    for (const status of rejectedStatuses) {
      const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
        async () => [deliveryRecord()]
      );
      const acknowledgeDelivery =
        vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>();
      const deliverRuntimePermissionDecision = vi.fn<
        HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
      >(async () => Object.freeze({ status }));
      const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
        { claimDeliveries, acknowledgeDelivery },
        { deliverRuntimePermissionDecision },
        { now: () => NOW }
      );

      await expect(coordinator.deliver(request)).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        acknowledged: 0,
        retained: 1,
      });
      expect(acknowledgeDelivery).not.toHaveBeenCalled();
    }
  });

  it('has zero external effects for an unknown scope or expired lease', async () => {
    const wrongScope = Object.freeze({ ...scope, restoreGeneration: 2 });
    for (const record of [
      deliveryRecord({ scope: wrongScope }),
      deliveryRecord({ leaseExpiresAtMs: NOW }),
    ]) {
      const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
        async () => [record]
      );
      const acknowledgeDelivery =
        vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>();
      const deliverRuntimePermissionDecision =
        vi.fn<
          HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
        >();
      const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
        { claimDeliveries, acknowledgeDelivery },
        { deliverRuntimePermissionDecision },
        { now: () => NOW }
      );

      await expect(coordinator.deliver(request)).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        acknowledged: 0,
        retained: 1,
      });
      expect(deliverRuntimePermissionDecision).not.toHaveBeenCalled();
      expect(acknowledgeDelivery).not.toHaveBeenCalled();
    }
  });
});
