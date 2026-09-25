import {
  HostedApprovalDecisionReconciliationCoordinator,
  type HostedApprovalDecisionReconciliationPort,
  type HostedTeamApprovalDeliveryOutboxPort,
} from '@features/team-approvals/main/hosted';
import { describe, expect, it, vi } from 'vitest';

const NOW = Date.parse('2026-08-13T08:00:00.000Z');
const request = Object.freeze({
  workspaceId: `workspace_${'a'.repeat(32)}`,
  authorityGeneration: 'generation_mount-7',
  restoreGeneration: 2,
  partition: Object.freeze({
    teamId: `team_${'b'.repeat(32)}`,
    runId: `run_${'c'.repeat(32)}`,
  }),
  providerDeliveryId: 'approval_delivery_reconcile-1',
  approvalGeneration: 'generation_approval-reconcile-1',
  deliveryGeneration: 4,
  reconciliationRef: 'approval-reconciliation_delivery-1',
  ownerId: 'reconciliation-owner-1',
  leaseToken: 'reconciliation-lease-1',
  deadlineAtMs: NOW + 10_000,
});

function harness(admission: 'claimed' | 'unavailable' | 'stale_binding' | 'not_found') {
  const readDeliveryReconciliation = vi.fn<
    HostedTeamApprovalDeliveryOutboxPort['readDeliveryReconciliation']
  >(async () =>
    admission === 'claimed'
      ? { kind: 'claimed', deliveryGeneration: request.deliveryGeneration + 1 }
      : { kind: admission }
  );
  const settleDeliveryReconciliation = vi.fn<
    HostedTeamApprovalDeliveryOutboxPort['settleDeliveryReconciliation']
  >(async () => undefined);
  const reconcileRuntimePermissionDecision = vi.fn<
    HostedApprovalDecisionReconciliationPort['reconcileRuntimePermissionDecision']
  >(async () => ({ status: 'not_delivered' as const }));
  const coordinator = new HostedApprovalDecisionReconciliationCoordinator(
    {
      claimDeliveries: vi.fn(),
      acknowledgeDelivery: vi.fn(),
      markDeliveryOperatorRequired: vi.fn(),
      readDeliveryReconciliation,
      settleDeliveryReconciliation,
    },
    { reconcileRuntimePermissionDecision },
    { now: () => NOW }
  );
  return {
    coordinator,
    readDeliveryReconciliation,
    settleDeliveryReconciliation,
    reconcileRuntimePermissionDecision,
  };
}

describe('HostedApprovalDecisionReconciliationCoordinator', () => {
  it.each(['stale_binding', 'not_found'] as const)(
    'has zero owner effects for %s durable binding',
    async (admission) => {
      const state = harness(admission);
      await expect(state.coordinator.reconcile(request)).resolves.toEqual({ status: admission });
      expect(state.reconcileRuntimePermissionDecision).not.toHaveBeenCalled();
      expect(state.settleDeliveryReconciliation).not.toHaveBeenCalled();
    }
  );

  it('has zero owner effects while the provider-boundary lease is still open', async () => {
    const state = harness('unavailable');
    await expect(state.coordinator.reconcile(request)).resolves.toEqual({ status: 'unavailable' });
    expect(state.reconcileRuntimePermissionDecision).not.toHaveBeenCalled();
    expect(state.settleDeliveryReconciliation).not.toHaveBeenCalled();
  });

  it('reopens delivery only after exact binding proves not_delivered', async () => {
    const state = harness('claimed');
    await expect(state.coordinator.reconcile(request)).resolves.toEqual({
      status: 'retry_authorized',
    });
    expect(state.reconcileRuntimePermissionDecision).toHaveBeenCalledWith({
      reconciliationRef: request.reconciliationRef,
      providerDeliveryId: request.providerDeliveryId,
      partition: request.partition,
    });
    expect(state.readDeliveryReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({ leaseDurationMs: 120_000 })
    );
    expect(state.settleDeliveryReconciliation).toHaveBeenCalledWith(
      expect.objectContaining({
        deliveryGeneration: request.deliveryGeneration + 1,
        outcome: 'not_delivered',
      })
    );
  });

  it.each(['operator_required', 'unavailable'] as const)(
    'returns the durable claim receipt for %s continuation',
    async (status) => {
      const state = harness('claimed');
      state.reconcileRuntimePermissionDecision.mockResolvedValueOnce({ status });
      await expect(state.coordinator.reconcile(request)).resolves.toEqual({
        status,
        claim: {
          deliveryGeneration: request.deliveryGeneration + 1,
          operationId: request.leaseToken,
        },
      });
      expect(state.settleDeliveryReconciliation).not.toHaveBeenCalled();
    }
  );

  it('allows only one concurrent provider reconciliation outcome to settle', async () => {
    let claimed = false;
    const readDeliveryReconciliation = vi.fn<
      HostedTeamApprovalDeliveryOutboxPort['readDeliveryReconciliation']
    >(async () => {
      if (claimed) return { kind: 'unavailable' };
      claimed = true;
      return { kind: 'claimed', deliveryGeneration: request.deliveryGeneration + 1 };
    });
    const settleDeliveryReconciliation = vi.fn<
      HostedTeamApprovalDeliveryOutboxPort['settleDeliveryReconciliation']
    >(async () => undefined);
    const reconcileRuntimePermissionDecision = vi
      .fn<HostedApprovalDecisionReconciliationPort['reconcileRuntimePermissionDecision']>()
      .mockResolvedValueOnce({ status: 'not_delivered' })
      .mockResolvedValueOnce({ status: 'delivered' });
    const coordinator = new HostedApprovalDecisionReconciliationCoordinator(
      {
        claimDeliveries: vi.fn(),
        acknowledgeDelivery: vi.fn(),
        markDeliveryOperatorRequired: vi.fn(),
        readDeliveryReconciliation,
        settleDeliveryReconciliation,
      },
      { reconcileRuntimePermissionDecision },
      { now: () => NOW }
    );

    await expect(
      Promise.all([
        coordinator.reconcile(request),
        coordinator.reconcile({ ...request, ownerId: 'reconciliation-owner-2' }),
      ])
    ).resolves.toEqual([{ status: 'retry_authorized' }, { status: 'unavailable' }]);
    expect(reconcileRuntimePermissionDecision).toHaveBeenCalledOnce();
    expect(settleDeliveryReconciliation).toHaveBeenCalledOnce();
  });
});
