// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted facets.
import {
  createDurableHostedTeamApprovalAuthority,
  createHostedTeamApprovalsFeature,
  createHostedTeamApprovalsRouteContribution,
} from '@features/team-approvals/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted facets.
import {
  createHostedReadinessFeature,
  createHostedReadinessRouteContribution,
} from '@features/hosted-readiness/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';

import { createHostedOperatorSurfacesComposition } from './hostedOperatorSurfacesComposition';

import type { HostedRouteAdmissionBinding } from './application';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type {
  HostedTeamApprovalAuthorityStorageGateway,
  TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
import type { QueryContext, WorkspaceId } from '@shared/contracts/hosted';
import type { FastifyInstance } from 'fastify';

const DEFAULT_RECOVERY_TIMEOUT_MS = 5_000;

export interface HostedOperatorProductionComposition {
  isReady(): boolean;
  register(app: FastifyInstance): void;
  close(): void;
}

export interface CreateHostedOperatorProductionCompositionDependencies {
  readonly authentication: {
    authenticatedPrincipalFor(request: object): HostedAuthenticatedPrincipal | null;
  };
  readonly runtimeInstance: RuntimeInstanceContext;
  readonly expectedDeploymentId: string;
  readonly workspaceId: WorkspaceId;
  readonly mountGeneration: number;
  readonly restoreGeneration: number;
  readonly teamIdentities: TeamIdentityReadGateway;
  readonly approvalStorage: HostedTeamApprovalAuthorityStorageGateway;
  readonly routeAdmissionBinding: HostedRouteAdmissionBinding;
  readonly recoveryTimeoutMs?: number;
  readonly nowMs?: () => number;
  readonly setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * Owns the authenticated operator HTTP composition and the approval timeout recovery gate.
 * Runtime ingress and provider delivery remain owned by the external lifecycle process.
 */
export function createHostedOperatorProductionComposition(
  dependencies: CreateHostedOperatorProductionCompositionDependencies
): HostedOperatorProductionComposition {
  if (
    dependencies.runtimeInstance.deploymentId !== dependencies.expectedDeploymentId ||
    !Number.isSafeInteger(dependencies.mountGeneration) ||
    dependencies.mountGeneration < 1 ||
    !Number.isSafeInteger(dependencies.restoreGeneration) ||
    dependencies.restoreGeneration < 0
  ) {
    throw new TypeError('hosted-operator-production-binding-invalid');
  }
  const recoveryTimeoutMs = dependencies.recoveryTimeoutMs ?? DEFAULT_RECOVERY_TIMEOUT_MS;
  if (!Number.isSafeInteger(recoveryTimeoutMs) || recoveryTimeoutMs < 1) {
    throw new TypeError('hosted-operator-production-recovery-timeout-invalid');
  }
  const nowMs = dependencies.nowMs ?? Date.now;
  const setTimer = dependencies.setTimer ?? globalThis.setTimeout;
  const clearTimer = dependencies.clearTimer ?? globalThis.clearTimeout;
  const queryContexts = createAuthenticatedHostedQueryContextFactory({
    authentication: Object.freeze({
      authenticatedPrincipalFor: (request: object) =>
        dependencies.authentication.authenticatedPrincipalFor(request),
    }),
    runtimeInstance: dependencies.runtimeInstance,
  });
  const durable = createDurableHostedTeamApprovalAuthority({
    storage: dependencies.approvalStorage,
    scopeResolver: {
      async resolveScope(teamId, context) {
        const identity = await dependencies.teamIdentities.getTeamIdentity(teamId);
        if (
          identity?.state !== 'active' ||
          identity.workspaceBinding?.workspaceId !== dependencies.workspaceId ||
          identity.workspaceBinding.generation !== dependencies.mountGeneration
        ) {
          return null;
        }
        return Object.freeze({
          principalId: context.actorId,
          workspaceId: dependencies.workspaceId,
          teamId,
          authorityGeneration: `generation_mount-${dependencies.mountGeneration}`,
          restoreGeneration: dependencies.restoreGeneration,
        });
      },
    },
  });
  const approvals = createHostedTeamApprovalsFeature(durable.outputAdapters);
  let closed = false;
  let registered = false;
  let recovered = false;
  let recoveryGeneration = 1;
  const recoveryStartedAt = nowMs();
  if (!Number.isSafeInteger(recoveryStartedAt) || recoveryStartedAt < 0) {
    throw new TypeError('hosted-operator-production-clock-invalid');
  }
  const recoveryDeadline = recoveryStartedAt + recoveryTimeoutMs;
  if (!Number.isSafeInteger(recoveryDeadline)) {
    throw new TypeError('hosted-operator-production-recovery-deadline-invalid');
  }
  const generation = recoveryGeneration;
  const recoveryTimer = setTimer(() => {
    if (closed || generation !== recoveryGeneration || recovered) return;
    closed = true;
    recoveryGeneration += 1;
  }, recoveryTimeoutMs);
  void dependencies.approvalStorage
    .hostedTeamApprovalAuditTimeouts({
      nextAuditTimeMs: recoveryStartedAt,
      deadlineAtMs: recoveryDeadline,
    })
    .then(() => {
      if (closed || generation !== recoveryGeneration) return;
      recovered = true;
      clearTimer(recoveryTimer);
    })
    .catch(() => {
      if (closed || generation !== recoveryGeneration) return;
      closed = true;
      recoveryGeneration += 1;
      clearTimer(recoveryTimer);
    });

  const readiness = createHostedReadinessFeature({
    source: {
      readProjection(request) {
        const ready = !closed && recovered;
        const status = ready ? ('ready' as const) : ('not_ready' as const);
        const reasons = Object.freeze(ready ? [] : ['recovery_required' as const]);
        return Object.freeze({
          schemaVersion: 1 as const,
          kind: 'success' as const,
          deploymentId: request.deploymentId,
          bootId: request.bootId,
          revision: ready ? 2 : 1,
          requiredReadiness: Object.freeze(['serve', 'auth', 'read', 'mutation'] as const),
          dimensions: Object.freeze(
            ['live', 'serve', 'auth', 'read', 'mutation', 'runtime-control', 'machine-ingress', 'recovery-point'].map(
              (dimension) =>
                Object.freeze({ dimension, status, reasons })
            )
          ),
          terminal: Object.freeze({ dimension: 'terminal' as const, status: 'not_offered' as const, reasons: Object.freeze([]) }),
          facets: Object.freeze([
            Object.freeze({
              facetId: 'team-approvals',
              availability: ready ? ('available' as const) : ('temporarily_unavailable' as const),
              requiredReadiness: Object.freeze(['serve', 'auth', 'read'] as const),
              reasons,
            }),
          ]),
          actions: Object.freeze([
            Object.freeze({
              actionId: 'team-approvals.decide',
              facetId: 'team-approvals',
              implementation: 'implemented' as const,
              availability: ready ? ('available' as const) : ('temporarily_unavailable' as const),
              requiredReadiness: Object.freeze(['serve', 'auth', 'mutation'] as const),
              reasons,
            }),
          ]),
        });
      },
    },
  });
  const createContext = (_descriptor: unknown, request: object, signal: AbortSignal): QueryContext => {
    if (closed || !recovered) throw new Error('hosted-operator-production-recovery-incomplete');
    const result = queryContexts.create(request, signal);
    if (result.kind !== 'success') {
      throw new Error(`hosted-operator-production-query-context-${result.code}`);
    }
    return result.context;
  };
  const surfaces = createHostedOperatorSurfacesComposition({
    routeAdmission: dependencies.routeAdmissionBinding.routeAdmission,
    readiness: {
      contribution: createHostedReadinessRouteContribution(readiness),
      createContext,
    },
    approvals: {
      contribution: createHostedTeamApprovalsRouteContribution(approvals),
      createContext,
    },
  });

  return Object.freeze({
    isReady: () => !closed && recovered,
    register(app: FastifyInstance): void {
      if (closed || registered) throw new Error('hosted-operator-production-unavailable');
      registered = true;
      surfaces.register(app);
    },
    close(): void {
      if (closed) return;
      closed = true;
      recoveryGeneration += 1;
      clearTimer(recoveryTimer);
    },
  });
}
