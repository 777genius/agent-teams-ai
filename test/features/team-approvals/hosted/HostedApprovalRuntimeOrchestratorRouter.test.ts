import { hostedApprovalRuntimeProductCandidateRequest } from '@features/team-approvals/main/adapters/output/runtime-ingress/hostedApprovalRuntimeOrchestratorWire';
import {
  type HostedApprovalRuntimeOrchestratorRoute,
  HostedApprovalRuntimeOrchestratorRouter,
  parseHostedApprovalRuntimeResponsePayload,
  parseHostedApprovalRuntimeWireAuthority,
} from '@features/team-approvals/main/hosted';
import { parseRuntimePermissionApprovalIngressAuthority } from '@features/team-runtime-control/contracts';
import { parseTeamId } from '@shared/contracts/hosted';
import { describe, expect, it, vi } from 'vitest';

import type { RuntimeIngressPermissionOutboxRecord } from '@features/team-runtime-control';

function route(hex: string): HostedApprovalRuntimeOrchestratorRoute & {
  readonly authority: HostedApprovalRuntimeOrchestratorRoute['authority'] & {
    claimPermissionApprovalIngressEffects: ReturnType<typeof vi.fn>;
    acknowledgePermissionApprovalIngressEffect: ReturnType<typeof vi.fn>;
    resolvePersistedIngressAuthority: ReturnType<typeof vi.fn>;
    deliverRuntimePermissionDecision: ReturnType<typeof vi.fn>;
    reconcileRuntimePermissionDecision: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
} {
  const teamId = parseTeamId(`team_${hex.repeat(32)}`);
  const authority = {
    claimPermissionApprovalIngressEffects: vi.fn(async () => []),
    acknowledgePermissionApprovalIngressEffect: vi.fn(async () => ({ status: 'acknowledged' })),
    resolvePersistedIngressAuthority: vi.fn(async (candidate) => ({
      status: 'resolved',
      scope: {
        principalId: 'actor_router-test',
        workspaceId: 'workspace_router-test',
        teamId: candidate.teamId,
        authorityGeneration: 'generation_router-test',
        restoreGeneration: 1,
      },
    })),
    deliverRuntimePermissionDecision: vi.fn(async (request) => ({
      status: 'delivered',
      reconciliationRef: request.reconciliationRef,
    })),
    reconcileRuntimePermissionDecision: vi.fn(async () => ({ status: 'delivered' })),
    close: vi.fn(),
  } as HostedApprovalRuntimeOrchestratorRoute['authority'] & {
    claimPermissionApprovalIngressEffects: ReturnType<typeof vi.fn>;
    acknowledgePermissionApprovalIngressEffect: ReturnType<typeof vi.fn>;
    resolvePersistedIngressAuthority: ReturnType<typeof vi.fn>;
    deliverRuntimePermissionDecision: ReturnType<typeof vi.fn>;
    reconcileRuntimePermissionDecision: ReturnType<typeof vi.fn>;
    close: ReturnType<typeof vi.fn>;
  };
  return { teamId, authority };
}

function ingressRecord(
  route: HostedApprovalRuntimeOrchestratorRoute,
  suffix: string
): RuntimeIngressPermissionOutboxRecord {
  return {
    outboxVersion: 1,
    outboxId: `runtime_permission:effect:${suffix.repeat(64)}`,
    commandId: `command_${suffix}`,
    effectRef: `effect_${suffix}`,
    deliveryRef: `delivery_ref_${suffix}`,
    authority: parseRuntimePermissionApprovalIngressAuthority({
      deploymentId: 'deployment_router-test',
      teamId: route.teamId,
      runId: `run_${suffix.repeat(32)}`,
      planGeneration: 1,
      laneId: 'primary',
      providerId: 'opencode',
      credentialGeneration: 1,
      credentialId: `credential-${suffix}`,
      sessionId: `session-${suffix}`,
      runtimeInstanceId: `runtime-${suffix}`,
      deliveryOwnerId: `member_${suffix.repeat(32)}`,
    }),
    payloadJson: '{}',
    observedAtIso: '2026-08-14T00:00:00.000Z',
    acceptedAtIso: '2026-08-14T00:00:00.000Z',
    lease: null,
    acknowledgedAtIso: null,
  };
}

describe('HostedApprovalRuntimeOrchestratorRouter', () => {
  it('admits distinct private bindings for equal effects and rejects duplicate outbox ids', () => {
    const wireAuthority = parseHostedApprovalRuntimeWireAuthority(
      hostedApprovalRuntimeProductCandidateRequest().authority
    );
    const claim = {
      ownerId: 'owner_router-test',
      leaseToken: 'lease_router-test',
      leaseDurationMs: 60_000,
      limit: 2,
    } as const;
    const makeRecord = (binding: string): RuntimeIngressPermissionOutboxRecord => {
      const deliveryRef = `delivery_ref_opencode-${binding}`;
      return {
        outboxVersion: 2,
        outboxId: `runtime_permission:effect:${binding}`,
        commandId: 'command_router-private',
        effectRef: `effect:${'d'.repeat(64)}`,
        deliveryRef,
        authority: parseRuntimePermissionApprovalIngressAuthority({
          deploymentId: wireAuthority.deploymentId,
          teamId: `team_${'a'.repeat(32)}`,
          runId: `run_${'b'.repeat(32)}`,
          planGeneration: 1,
          laneId: 'secondary:opencode:worker',
          providerId: 'opencode',
          credentialGeneration: 1,
          credentialId: 'credential-router-private',
          sessionId: 'session-router-private',
          runtimeInstanceId: 'runtime-router-private',
          deliveryOwnerId: `member_${'c'.repeat(32)}`,
        }),
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          deliveryRef,
          category: 'command',
          summary: 'Private binding request',
          expiresAtMs: null,
          preview: null,
        }),
        observedAtIso: '2026-08-14T00:00:00.000Z',
        acceptedAtIso: '2026-08-14T00:00:00.000Z',
        lease: {
          generation: 1,
          ownerId: claim.ownerId,
          leaseToken: claim.leaseToken,
          claimedAtIso: '2026-08-14T00:00:00.000Z',
          leaseExpiresAtIso: '2026-08-14T00:01:00.000Z',
        },
        acknowledgedAtIso: null,
      };
    };
    const first = makeRecord('1'.repeat(64));
    const second = makeRecord('2'.repeat(64));

    expect(
      parseHostedApprovalRuntimeResponsePayload(
        'approval_ingress_claim',
        [first, second],
        claim,
        wireAuthority
      )
    ).toEqual([first, second]);
    expect(() =>
      parseHostedApprovalRuntimeResponsePayload(
        'approval_ingress_claim',
        [first, first],
        claim,
        wireAuthority
      )
    ).toThrow();
  });

  it('claims fairly and acknowledges through the exact team route that returned the record', async () => {
    const first = route('1');
    const second = route('2');
    const firstRecord = ingressRecord(first, '1');
    const secondRecord = ingressRecord(second, '2');
    first.authority.claimPermissionApprovalIngressEffects.mockResolvedValue([firstRecord]);
    second.authority.claimPermissionApprovalIngressEffects.mockResolvedValue([secondRecord]);
    const router = new HostedApprovalRuntimeOrchestratorRouter([first, second]);

    await expect(
      router.claimPermissionApprovalIngressEffects({
        ownerId: 'owner_router-test',
        leaseToken: 'lease_router-test',
        leaseDurationMs: 1_000,
        limit: 2,
      })
    ).resolves.toEqual([firstRecord, secondRecord]);
    expect(first.authority.claimPermissionApprovalIngressEffects).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );
    expect(second.authority.claimPermissionApprovalIngressEffects).toHaveBeenCalledWith(
      expect.objectContaining({ limit: 1 })
    );

    await router.acknowledgePermissionApprovalIngressEffect({
      outboxId: secondRecord.outboxId,
      generation: 1,
      ownerId: 'owner_router-test',
      leaseToken: 'lease_router-test',
    });
    expect(second.authority.acknowledgePermissionApprovalIngressEffect).toHaveBeenCalledOnce();
    expect(first.authority.acknowledgePermissionApprovalIngressEffect).not.toHaveBeenCalled();
  });

  it('routes authority, delivery, and reconciliation only from immutable record team ids', async () => {
    const first = route('1');
    const second = route('2');
    const router = new HostedApprovalRuntimeOrchestratorRouter([first, second]);
    const authority = ingressRecord(second, '2').authority;

    await router.resolvePersistedIngressAuthority(authority);
    await router.deliverRuntimePermissionDecision({
      providerDeliveryId: 'delivery-2',
      reconciliationRef: 'approval-reconciliation_router-2',
      principal: { kind: 'operator', actorId: 'actor_router-test' },
      deliveryRef: 'delivery_ref_2',
      approvalId: `approval_${'2'.repeat(32)}`,
      approvalGeneration: `generation_runtime-permission-${'2'.repeat(64)}`,
      decision: 'allow',
      partition: { teamId: second.teamId, runId: `run_${'2'.repeat(32)}` },
      requestId: 'request-2',
    });
    await router.reconcileRuntimePermissionDecision({
      reconciliationRef: 'approval-reconciliation_router-2',
      providerDeliveryId: 'delivery-2',
      partition: { teamId: second.teamId, runId: `run_${'2'.repeat(32)}` },
    });

    expect(second.authority.resolvePersistedIngressAuthority).toHaveBeenCalledOnce();
    expect(second.authority.deliverRuntimePermissionDecision).toHaveBeenCalledOnce();
    expect(second.authority.reconcileRuntimePermissionDecision).toHaveBeenCalledOnce();
    expect(first.authority.resolvePersistedIngressAuthority).not.toHaveBeenCalled();
    expect(first.authority.deliverRuntimePermissionDecision).not.toHaveBeenCalled();
    expect(first.authority.reconcileRuntimePermissionDecision).not.toHaveBeenCalled();
  });

  it('rejects empty or duplicate catalogs and closes every admitted route once', () => {
    expect(() => new HostedApprovalRuntimeOrchestratorRouter([])).toThrow(
      'hosted-approval-runtime-route-catalog-invalid'
    );
    const first = route('1');
    expect(() => new HostedApprovalRuntimeOrchestratorRouter([first, first])).toThrow(
      'hosted-approval-runtime-route-team-duplicate'
    );
    const second = route('2');
    const router = new HostedApprovalRuntimeOrchestratorRouter([first, second]);
    router.close();
    router.close();
    expect(first.authority.close).toHaveBeenCalledOnce();
    expect(second.authority.close).toHaveBeenCalledOnce();
  });
});
