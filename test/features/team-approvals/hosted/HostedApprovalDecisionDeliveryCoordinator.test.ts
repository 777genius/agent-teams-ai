import {
  HostedApprovalDecisionDeliveryCoordinator,
  type HostedApprovalDecisionExternalLifecycleDeliveryPort,
  type HostedTeamApprovalDeliveryOutboxPort,
} from '@features/team-approvals/main/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTeamApprovalDeliveryRecord } from '@features/internal-storage/contracts';

const NOW = Date.parse('2026-08-06T11:00:00.000Z');
const partition = Object.freeze({
  teamId: `team_${'a'.repeat(32)}`,
  runId: `run_${'e'.repeat(32)}`,
});
const request = Object.freeze({
  workspaceId: `workspace_${'a'.repeat(32)}`,
  teamId: partition.teamId,
  authorityGeneration: 'generation_mount-1',
  restoreGeneration: 1,
  ownerId: 'bridge-owner',
  leaseToken: 'bridge-lease',
  leaseDurationMs: 60_000,
  limit: 1,
  deadlineAtMs: NOW + 120_000,
});
const CLAIM_TOKEN = 'approval-claim_test-attempt-1';

function deliveryRecord(
  overrides: Partial<HostedTeamApprovalDeliveryRecord> = {}
): HostedTeamApprovalDeliveryRecord {
  return Object.freeze({
    deliveryId: 'approval_delivery_runtime-permission-1',
    workspaceId: request.workspaceId,
    authorityGeneration: request.authorityGeneration,
    restoreGeneration: request.restoreGeneration,
    principal: Object.freeze({ kind: 'operator' as const, actorId: 'actor_approval-decider-1' }),
    partition,
    requestId: 'permission-request-1',
    approvalId: `approval_${'b'.repeat(32)}`,
    approvalGeneration: `generation_runtime-permission-${'c'.repeat(64)}`,
    decision: 'allow',
    payloadHash: 'd'.repeat(64),
    deliveryRef: 'delivery_ref_runtime-permission-1',
    deliveryGeneration: 1,
    ownerId: request.ownerId,
    leaseToken: CLAIM_TOKEN,
    claimedAtMs: NOW,
    leaseExpiresAtMs: NOW + 60_000,
    createdAtMs: NOW - 1_000,
    ...overrides,
  });
}

function outbox(
  claimDeliveries: HostedTeamApprovalDeliveryOutboxPort['claimDeliveries'],
  acknowledgeDelivery: HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery'],
  markDeliveryOperatorRequired: HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired'] = vi.fn(
    async () => undefined
  )
): HostedTeamApprovalDeliveryOutboxPort {
  return {
    claimDeliveries,
    acknowledgeDelivery,
    markDeliveryOperatorRequired,
    readDeliveryReconciliation: vi.fn(async () => ({ kind: 'not_found' as const })),
    settleDeliveryReconciliation: vi.fn(async () => undefined),
  };
}

describe('HostedApprovalDecisionDeliveryCoordinator', () => {
  it('fences before provider delivery and settles delivered through the exact reconciliation binding', async () => {
    const record = deliveryRecord();
    const acknowledgeDelivery =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>();
    const markDeliveryOperatorRequired =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired']>();
    let quarantined = false;
    markDeliveryOperatorRequired.mockImplementation(async () => {
      quarantined = true;
    });
    const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
      async () => (quarantined ? [] : [record])
    );
    const settleDeliveryReconciliation =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['settleDeliveryReconciliation']>();
    const deliverRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >(async () => Object.freeze({ status: 'delivered' as const }));
    const deliveryOutbox = outbox(
      claimDeliveries,
      acknowledgeDelivery,
      markDeliveryOperatorRequired
    );
    deliveryOutbox.settleDeliveryReconciliation = settleDeliveryReconciliation;
    const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
      deliveryOutbox,
      { deliverRuntimePermissionDecision },
      { now: () => NOW },
      () => CLAIM_TOKEN
    );

    await expect(coordinator.deliver(request)).resolves.toEqual({
      claimed: 1,
      delivered: 1,
      acknowledged: 1,
      retained: 0,
      operatorRequired: 0,
    });
    expect(deliverRuntimePermissionDecision).toHaveBeenCalledOnce();
    expect(deliverRuntimePermissionDecision).toHaveBeenCalledWith(
      expect.objectContaining({
        providerDeliveryId: record.deliveryId,
        decision: 'allow',
        partition,
      })
    );
    expect(markDeliveryOperatorRequired.mock.invocationCallOrder[0]).toBeLessThan(
      deliverRuntimePermissionDecision.mock.invocationCallOrder[0]!
    );
    expect(settleDeliveryReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: record.deliveryId,
        deliveryGeneration: record.deliveryGeneration + 1,
        outcome: 'delivered',
      })
    );
    expect(acknowledgeDelivery).not.toHaveBeenCalled();
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
        outbox(claimDeliveries, acknowledgeDelivery),
        { deliverRuntimePermissionDecision },
        { now: () => NOW },
        () => CLAIM_TOKEN
      );

      await expect(coordinator.deliver(request)).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        acknowledged: 0,
        retained: 1,
        operatorRequired: 1,
      });
      expect(acknowledgeDelivery).not.toHaveBeenCalled();
    }
  });

  it('keeps terminal ambiguous delivery unacknowledged and exposes reconciliation demand', async () => {
    const record = deliveryRecord();
    const acknowledgeDelivery =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['acknowledgeDelivery']>();
    const markDeliveryOperatorRequired =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired']>();
    const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
      outbox(async () => [record], acknowledgeDelivery, markDeliveryOperatorRequired),
      {
        deliverRuntimePermissionDecision: async (request) => ({
          status: 'operator_required',
          reconciliationRef: request.reconciliationRef,
        }),
      },
      { now: () => NOW },
      () => CLAIM_TOKEN
    );

    await expect(coordinator.deliver(request)).resolves.toEqual({
      claimed: 1,
      delivered: 0,
      acknowledged: 0,
      retained: 1,
      operatorRequired: 1,
    });
    expect(acknowledgeDelivery).not.toHaveBeenCalled();
    expect(markDeliveryOperatorRequired).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryId: record.deliveryId,
        deliveryGeneration: record.deliveryGeneration,
        boundaryLeaseDurationMs: 120_000,
      })
    );
  });

  it('keeps a delayed operator response quarantined after the original lease expires', async () => {
    let now = NOW;
    const record = deliveryRecord({ leaseExpiresAtMs: NOW + 1_000 });
    const markDeliveryOperatorRequired =
      vi.fn<HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired']>();
    let quarantined = false;
    markDeliveryOperatorRequired.mockImplementation(async () => {
      quarantined = true;
    });
    const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
      async () => (quarantined ? [] : [record])
    );
    const deliverRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >(async (input) => {
      now = NOW + 5_000;
      return { status: 'operator_required', reconciliationRef: input.reconciliationRef };
    });
    const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
      outbox(claimDeliveries, vi.fn(), markDeliveryOperatorRequired),
      { deliverRuntimePermissionDecision },
      { now: () => now },
      () => CLAIM_TOKEN
    );

    await expect(coordinator.deliver(request)).resolves.toMatchObject({ operatorRequired: 1 });
    await expect(coordinator.deliver(request)).resolves.toMatchObject({ claimed: 0 });
    expect(markDeliveryOperatorRequired.mock.invocationCallOrder[0]).toBeLessThan(
      deliverRuntimePermissionDecision.mock.invocationCallOrder[0]!
    );
    expect(deliverRuntimePermissionDecision).toHaveBeenCalledOnce();
  });

  it('keeps crash-after-boundary recovery quarantined with zero second provider call', async () => {
    const record = deliveryRecord();
    let quarantined = false;
    const claimDeliveries = vi.fn<HostedTeamApprovalDeliveryOutboxPort['claimDeliveries']>(
      async () => (quarantined ? [] : [record])
    );
    const markDeliveryOperatorRequired = vi.fn<
      HostedTeamApprovalDeliveryOutboxPort['markDeliveryOperatorRequired']
    >(async () => {
      quarantined = true;
    });
    const deliverRuntimePermissionDecision = vi.fn<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >(async () => {
      throw new Error('crash-after-boundary');
    });
    const coordinator = new HostedApprovalDecisionDeliveryCoordinator(
      outbox(claimDeliveries, vi.fn(), markDeliveryOperatorRequired),
      { deliverRuntimePermissionDecision },
      { now: () => NOW },
      () => CLAIM_TOKEN
    );

    await expect(coordinator.deliver(request)).resolves.toMatchObject({ operatorRequired: 1 });
    await expect(coordinator.deliver(request)).resolves.toMatchObject({ claimed: 0 });
    expect(deliverRuntimePermissionDecision).toHaveBeenCalledOnce();
  });

  it('has zero external effects for a mismatched owner or expired lease', async () => {
    for (const record of [
      deliveryRecord({ ownerId: 'another-owner' }),
      deliveryRecord({ leaseExpiresAtMs: NOW }),
      deliveryRecord({
        partition: { ...partition, teamId: `team_${'f'.repeat(32)}` },
      }),
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
        outbox(claimDeliveries, acknowledgeDelivery),
        { deliverRuntimePermissionDecision },
        { now: () => NOW },
        () => CLAIM_TOKEN
      );

      await expect(coordinator.deliver(request)).resolves.toEqual({
        claimed: 1,
        delivered: 0,
        acknowledged: 0,
        retained: 1,
        operatorRequired: 0,
      });
      expect(deliverRuntimePermissionDecision).not.toHaveBeenCalled();
      expect(acknowledgeDelivery).not.toHaveBeenCalled();
    }
  });
});
