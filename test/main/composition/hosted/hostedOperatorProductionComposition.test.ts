import {
  type HostedAuthenticatedPrincipal,
  parseHostedSessionId,
  parseUserId,
} from '@features/hosted-access';
import { HOSTED_READINESS_ROUTE } from '@features/hosted-readiness/contracts';
import { createRuntimeInstanceContext } from '@features/runtime-instance-context';
import { HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS } from '@features/team-approvals/main/hosted';
import { createHostedRouteAdmissionBinding } from '@main/composition/hosted/application';
import { createHostedOperatorProductionComposition } from '@main/composition/hosted/hostedOperatorProductionComposition';
import {
  parseBootId,
  parseDeploymentId,
  parseRunId,
  parseTeamId,
  parseWorkspaceId,
} from '@shared/contracts/hosted';
import Fastify from 'fastify';
import { describe, expect, it, vi } from 'vitest';

import type { HostedTeamApprovalAuthorityStorageGateway } from '@features/internal-storage/contracts';

const DEPLOYMENT_ID = parseDeploymentId('deployment_operator-production');
const WORKSPACE_ID = parseWorkspaceId(`workspace_${'a'.repeat(32)}`);
const runtimeInstance = createRuntimeInstanceContext({
  deploymentId: DEPLOYMENT_ID,
  bootId: parseBootId('boot_operator-production'),
  claudeRoot: { kind: 'claude', reference: 'isolated:claude' },
  appDataRoot: { kind: 'app-data', reference: 'isolated:app-data' },
  workspaceRoots: [],
  tempRoot: { kind: 'temp', reference: 'isolated:temp' },
  logsRoot: { kind: 'logs', reference: 'isolated:logs' },
});
const routeAdmissionBinding = createHostedRouteAdmissionBinding({
  routes: HOSTED_TEAM_APPROVAL_ROUTE_DESCRIPTORS,
  readiness: {
    readiness: async () => ({
      revision: 1,
      dimensions: Object.freeze({}) as never,
    }),
  },
});

function authenticatedPrincipal(): HostedAuthenticatedPrincipal {
  const sessionId = parseHostedSessionId('hss_operator-production');
  return Object.freeze({
    principal: Object.freeze({
      userId: parseUserId('user_operator-production'),
      displayName: 'Operator',
      role: 'member',
      permissions: Object.freeze(['hosted.query', 'hosted.command'] as const),
      authenticationMethod: 'oidc',
      sessionId,
    }),
    authenticatedSessionId: sessionId,
  });
}

function dependencies(
  audit: HostedTeamApprovalAuthorityStorageGateway['hostedTeamApprovalAuditTimeouts'],
  timers: {
    setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
    clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
    nowMs?: () => number;
  } = {}
): Omit<
  import('@main/composition/hosted/hostedOperatorProductionComposition').CreateHostedOperatorProductionCompositionDependencies,
  'approvalStorage' | 'authentication'
> & {
  authentication: {
    authenticatedPrincipalFor: ReturnType<
      typeof vi.fn<(request: object) => HostedAuthenticatedPrincipal | null>
    >;
  };
  approvalStorage: HostedTeamApprovalAuthorityStorageGateway;
} {
  return {
    authentication: {
      authenticatedPrincipalFor: vi.fn<
        (request: object) => HostedAuthenticatedPrincipal | null
      >(() => null),
    },
    runtimeInstance,
    expectedDeploymentId: DEPLOYMENT_ID,
    workspaceId: WORKSPACE_ID,
    mountGeneration: 3,
    restoreGeneration: 1,
    teamIdentities: { getTeamIdentity: vi.fn(), listTeamIdentities: vi.fn() },
    approvalStorage: {
      hostedTeamApprovalObserve: vi.fn(),
      hostedTeamApprovalReadPending: vi.fn(),
      hostedTeamApprovalReadPreview: vi.fn(),
      hostedTeamApprovalDecide: vi.fn(),
      hostedTeamApprovalAuditTimeouts: audit,
      hostedTeamApprovalClaimDeliveries: vi.fn(async () => Object.freeze([])),
      hostedTeamApprovalAcknowledgeDelivery: vi.fn(),
    } satisfies HostedTeamApprovalAuthorityStorageGateway,
    approvalRuntime: {
      ownerId: 'approval-owner-restart',
      leaseToken: 'approval-owner-restart-lease',
      ingressEffectOutbox: {
        claimPermissionApprovalIngressEffects: vi.fn(async () => Object.freeze([])),
        acknowledgePermissionApprovalIngressEffect: vi.fn(async () => ({
          status: 'acknowledged' as const,
        })),
      },
      ingressAuthority: {
        resolvePersistedIngressAuthority: vi.fn(async () => ({ status: 'unavailable' as const })),
      },
      externalDecisionDelivery: {
        deliverRuntimePermissionDecision: vi.fn(async () => ({ status: 'delivered' as const })),
      },
    },
    routeAdmissionBinding,
    recoveryTimeoutMs: 50,
    nowMs: () => 1_000,
    ...timers,
  };
}

describe('hosted operator production composition', () => {
  it('does not become ready until the initial durable recovery completes', async () => {
    let resolveRecovery!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const composition = createHostedOperatorProductionComposition(
      dependencies(async () => {
        await recovery;
        return { resolvedCount: 0, nextAuditTimeMs: null };
      })
    );
    expect(composition.isReady()).toBe(false);
    resolveRecovery();
    await recovery;
    await vi.waitFor(() => expect(composition.isReady()).toBe(true));
    composition.close();
  });

  it('rolls a fresh composition closed on recovery timeout and ignores late completion', async () => {
    let resolveRecovery!: () => void;
    let timeout!: () => void;
    const recovery = new Promise<void>((resolve) => {
      resolveRecovery = resolve;
    });
    const composition = createHostedOperatorProductionComposition(
      dependencies(
        async () => {
          await recovery;
          return { resolvedCount: 0, nextAuditTimeMs: null };
        },
        {
          setTimer: ((callback: () => void) => {
            timeout = callback;
            return 1 as never;
          }) as never,
          clearTimer: vi.fn(),
        }
      )
    );
    timeout();
    expect(composition.isReady()).toBe(false);
    resolveRecovery();
    await recovery;
    await Promise.resolve();
    expect(composition.isReady()).toBe(false);
  });

  it('drains the owner-wide decision outbox until empty before becoming ready', async () => {
    const audit = vi.fn(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));
    const input = dependencies(audit);
    const record = Object.freeze({
      deliveryId: 'approval_delivery_restart-1',
      partition: Object.freeze({
        teamId: parseTeamId(`team_${'a'.repeat(32)}`),
        runId: parseRunId(`run_${'b'.repeat(32)}`),
      }),
      requestId: 'runtime-request-restart-1',
      approvalId: `approval_${'c'.repeat(32)}`,
      approvalGeneration: 'generation_restart-1',
      decision: 'allow' as const,
      payloadHash: 'd'.repeat(64),
      deliveryRef: 'delivery_ref_restart-1',
      deliveryGeneration: 1,
      ownerId: 'approval-owner-restart',
      leaseToken: 'approval-owner-restart-lease',
      claimedAtMs: 1_000,
      leaseExpiresAtMs: 2_000,
      createdAtMs: 900,
    });
    const claim = vi
      .fn()
      .mockResolvedValueOnce(Object.freeze([record]))
      .mockResolvedValueOnce(Object.freeze([]));
    const acknowledge = vi.fn(async () => undefined);
    input.approvalStorage = {
      ...input.approvalStorage,
      hostedTeamApprovalClaimDeliveries: claim,
      hostedTeamApprovalAcknowledgeDelivery: acknowledge,
    } as HostedTeamApprovalAuthorityStorageGateway;

    const composition = createHostedOperatorProductionComposition(input);
    await vi.waitFor(() => expect(composition.isReady()).toBe(true));
    expect(claim).toHaveBeenCalledTimes(2);
    expect(acknowledge).toHaveBeenCalledOnce();
    composition.close();
  });

  it('projects committed permission requests before draining decisions during recovery', async () => {
    const input = dependencies(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }));
    const project = vi
      .spyOn(input.approvalRuntime.ingressEffectOutbox, 'claimPermissionApprovalIngressEffects')
      .mockResolvedValueOnce(Object.freeze([]));

    const composition = createHostedOperatorProductionComposition(input);
    await vi.waitFor(() => expect(composition.isReady()).toBe(true));
    expect(project).toHaveBeenCalledOnce();
    expect(input.approvalStorage.hostedTeamApprovalClaimDeliveries).toHaveBeenCalledOnce();
    composition.close();
  });

  it('keeps readiness closed on a transient owner claim failure and retries recovery', async () => {
    const scheduled: Array<() => void> = [];
    const input = dependencies(async () => ({ resolvedCount: 0, nextAuditTimeMs: null }), {
      setTimer: ((callback: () => void) => {
        scheduled.push(callback);
        return scheduled.length as never;
      }) as never,
      clearTimer: vi.fn(),
    });
    const claim = vi
      .spyOn(input.approvalRuntime.ingressEffectOutbox, 'claimPermissionApprovalIngressEffects')
      .mockRejectedValueOnce(new Error('owner-lost'))
      .mockResolvedValue(Object.freeze([]));
    const composition = createHostedOperatorProductionComposition(input);
    await vi.waitFor(() => expect(claim).toHaveBeenCalledOnce());
    expect(composition.isReady()).toBe(false);
    const retry = scheduled.at(-1);
    expect(retry).toBeDefined();
    retry?.();
    await vi.waitFor(() => expect(composition.isReady()).toBe(true));
    composition.close();
  });

  it('schedules every follow-up audit with the durable high-water across clock rollback', async () => {
    let now = 1_000;
    const audit = vi
      .fn()
      .mockResolvedValueOnce({ resolvedCount: 0, nextAuditTimeMs: 1_100 })
      .mockResolvedValueOnce({ resolvedCount: 1, nextAuditTimeMs: null });
    const scheduled: Array<{ callback: () => void; timeoutMs: number }> = [];
    const input = dependencies(audit, {
      nowMs: () => now,
      setTimer: ((callback: () => void, timeoutMs: number) => {
        scheduled.push({ callback, timeoutMs });
        return scheduled.length as never;
      }) as never,
      clearTimer: vi.fn(),
    });
    const composition = createHostedOperatorProductionComposition(input);
    await vi.waitFor(() => expect(composition.isReady()).toBe(true));
    expect(scheduled.map(({ timeoutMs }) => timeoutMs)).toEqual([50, 1_000, 100]);

    now = 900;
    scheduled[2]!.callback();
    await vi.waitFor(() => expect(audit).toHaveBeenCalledTimes(2));
    expect(audit.mock.calls[1]?.[0]).toMatchObject({ nextAuditTimeMs: 1_100 });
    composition.close();
  });

  it('serves authenticated structured recovery readiness while recovery is incomplete', async () => {
    const input = dependencies(async () => await new Promise(() => undefined));
    input.authentication.authenticatedPrincipalFor = vi.fn<
      (request: object) => HostedAuthenticatedPrincipal | null
    >((_request: object) => authenticatedPrincipal());
    const composition = createHostedOperatorProductionComposition(input);
    const app = Fastify();
    composition.register(app);
    await app.ready();
    try {
      const response = await app.inject({ method: 'GET', url: HOSTED_READINESS_ROUTE });
      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.kind).toBe('success');
      expect(body.dimensions).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            dimension: 'recovery-point',
            status: 'not_ready',
            reasons: ['recovery_required'],
          }),
        ])
      );
    } finally {
      composition.close();
      await app.close();
    }
  });
});
