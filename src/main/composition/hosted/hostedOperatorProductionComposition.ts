// eslint-disable-next-line no-restricted-imports -- Hosted query context exposes a bounded server-only facet.
import { createAuthenticatedHostedQueryContextFactory } from '@features/hosted-query-context/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted facets.
import {
  createHostedReadinessFeature,
  createHostedReadinessRouteContribution,
} from '@features/hosted-readiness/main/hosted';
// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted facets.
import {
  createDurableHostedTeamApprovalAuthority,
  createHostedTeamApprovalRuntimeBridge,
  createHostedTeamApprovalsFeature,
  createHostedTeamApprovalsRouteContribution,
} from '@features/team-approvals/main/hosted';
import {
  parseTeamId,
  type QueryContext,
  type TeamId,
  type WorkspaceId,
} from '@shared/contracts/hosted';

import { createHostedOperatorSurfacesComposition } from './hostedOperatorSurfacesComposition';

import type { HostedRouteAdmissionBinding } from './application';
import type { HostedAuthenticatedPrincipal } from '@features/hosted-access';
import type {
  HostedTeamApprovalAuthorityStorageGateway,
  TeamIdentityReadGateway,
} from '@features/internal-storage/contracts';
import type { RuntimeInstanceContext } from '@features/runtime-instance-context/contracts';
// eslint-disable-next-line no-restricted-imports -- Production composition consumes bounded hosted facet types.
import type {
  HostedApprovalDecisionReconciliationRequest,
  HostedApprovalDecisionReconciliationResult,
  HostedTeamApprovalRuntimeBridgeDependencies,
} from '@features/team-approvals/main/hosted';
import type { FastifyInstance, FastifyRequest } from 'fastify';

const DEFAULT_RECOVERY_TIMEOUT_MS = 5_000;
const DEFAULT_DELIVERY_LEASE_MS = 1_000;
const DEFAULT_DELIVERY_BATCH_SIZE = 100;
const DEFAULT_PUMP_INTERVAL_MS = 1_000;
const DEFAULT_PUMP_RETRY_MS = 250;

export interface HostedOperatorProductionComposition {
  isReady(): boolean;
  reconcileApprovalDecision(
    request: HostedApprovalDecisionReconciliationRequest
  ): Promise<HostedApprovalDecisionReconciliationResult>;
  register(app: FastifyInstance): void;
  close(): void;
}

export interface HostedOperatorApprovalRuntimeDependencies extends Omit<
  HostedTeamApprovalRuntimeBridgeDependencies,
  'pendingIngress' | 'deliveryOutbox' | 'clock'
> {
  /** Exact signed route inventory; delivery is drained fairly across every admitted team. */
  readonly teamIds: readonly TeamId[];
  readonly ownerId: string;
  readonly leaseToken: string;
  readonly leaseDurationMs?: number;
  readonly batchSize?: number;
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
  readonly approvalRuntime: HostedOperatorApprovalRuntimeDependencies;
  readonly routeAdmissionBinding: HostedRouteAdmissionBinding;
  readonly recoveryTimeoutMs?: number;
  readonly nowMs?: () => number;
  readonly setTimer?: (callback: () => void, timeoutMs: number) => ReturnType<typeof setTimeout>;
  readonly clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
  readonly pumpIntervalMs?: number;
  readonly pumpRetryMs?: number;
}

/** Owns authenticated approval HTTP, durable recovery, delivery drain, and timeout scheduling. */
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
  const approvalRuntime = dependencies.approvalRuntime;
  const approvalTeamIds = Object.freeze(approvalRuntime.teamIds.map(parseTeamId));
  if (
    approvalTeamIds.length === 0 ||
    approvalTeamIds.length > 256 ||
    new Set(approvalTeamIds).size !== approvalTeamIds.length
  ) {
    throw new TypeError('hosted-operator-production-team-routes-invalid');
  }
  const admittedTeamIds = new Set<TeamId>(approvalTeamIds);
  const leaseDurationMs = approvalRuntime.leaseDurationMs ?? DEFAULT_DELIVERY_LEASE_MS;
  const batchSize = approvalRuntime.batchSize ?? DEFAULT_DELIVERY_BATCH_SIZE;
  const pumpIntervalMs = dependencies.pumpIntervalMs ?? DEFAULT_PUMP_INTERVAL_MS;
  const pumpRetryMs = dependencies.pumpRetryMs ?? DEFAULT_PUMP_RETRY_MS;
  if (
    !Number.isSafeInteger(recoveryTimeoutMs) ||
    recoveryTimeoutMs < 1 ||
    !Number.isSafeInteger(leaseDurationMs) ||
    leaseDurationMs < 1 ||
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > 100 ||
    !Number.isSafeInteger(pumpIntervalMs) ||
    pumpIntervalMs < 1 ||
    !Number.isSafeInteger(pumpRetryMs) ||
    pumpRetryMs < 1
  ) {
    throw new TypeError('hosted-operator-production-recovery-configuration-invalid');
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
  let wakePump = (): void => {};
  let triggerRecovery = (): void => {};
  const durable = createDurableHostedTeamApprovalAuthority({
    storage: dependencies.approvalStorage,
    scopeResolver: {
      async resolveScope(teamId, context) {
        if (!admittedTeamIds.has(teamId)) return null;
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
    onDecisionCommitted: () => wakePump(),
  });
  const runtimeBridge = createHostedTeamApprovalRuntimeBridge({
    ingressEffectOutbox: approvalRuntime.ingressEffectOutbox,
    ingressAuthority: approvalRuntime.ingressAuthority,
    externalDecisionDelivery: approvalRuntime.externalDecisionDelivery,
    externalDecisionReconciliation: approvalRuntime.externalDecisionReconciliation,
    pendingIngress: durable.ingress,
    deliveryOutbox: durable.deliveryOutbox,
    clock: { now: nowMs },
  });
  const approvals = createHostedTeamApprovalsFeature(durable.outputAdapters);

  let closed = false;
  let registered = false;
  let recovered = false;
  let recoveryGeneration = 1;
  let pumpRunning = false;
  let pumpRequested = false;
  let deliveryCursor = 0;
  const timers = new Set<ReturnType<typeof setTimeout>>();

  const schedule = (callback: () => void, delayMs: number): void => {
    const timer = setTimer(() => {
      timers.delete(timer);
      callback();
    }, delayMs);
    timers.add(timer);
  };

  const drainDecisions = async (deadlineAtMs: number): Promise<boolean> => {
    while (!closed && nowMs() < deadlineAtMs) {
      const orderedTeams = Array.from(
        { length: approvalTeamIds.length },
        (_, index) => approvalTeamIds[(deliveryCursor + index) % approvalTeamIds.length]
      );
      deliveryCursor = (deliveryCursor + 1) % approvalTeamIds.length;
      const perTeamLimit = Math.max(1, Math.floor(batchSize / approvalTeamIds.length));
      let claimed = 0;
      for (const teamId of orderedTeams) {
        if (closed || nowMs() >= deadlineAtMs) return false;
        const result = await runtimeBridge.deliverApprovalDecisions({
          workspaceId: dependencies.workspaceId,
          teamId,
          authorityGeneration: `generation_mount-${dependencies.mountGeneration}`,
          restoreGeneration: dependencies.restoreGeneration,
          ownerId: approvalRuntime.ownerId,
          leaseToken: approvalRuntime.leaseToken,
          leaseDurationMs,
          limit: perTeamLimit,
          deadlineAtMs,
        });
        claimed += result.claimed;
        if (result.acknowledged + result.operatorRequired !== result.claimed) return false;
      }
      if (claimed === 0) return true;
    }
    return false;
  };

  const projectPermissionRequests = async (deadlineAtMs: number): Promise<boolean> => {
    while (!closed && nowMs() < deadlineAtMs) {
      const result = await runtimeBridge.projectRuntimePermissionRequests({
        ownerId: approvalRuntime.ownerId,
        leaseToken: approvalRuntime.leaseToken,
        leaseDurationMs,
        limit: batchSize,
        deadlineAtMs,
      });
      if (result.claimed === 0) return true;
      if (result.acknowledged === 0) return false;
    }
    return false;
  };

  const schedulePump = (delayMs: number, generation: number): void => {
    schedule(() => {
      if (closed || generation !== recoveryGeneration || !recovered) return;
      void runPump(generation);
    }, delayMs);
  };

  const runPump = async (generation: number): Promise<void> => {
    if (pumpRunning) {
      pumpRequested = true;
      return;
    }
    pumpRunning = true;
    let succeeded = false;
    try {
      const deadlineAtMs = nowMs() + recoveryTimeoutMs;
      succeeded =
        (await projectPermissionRequests(deadlineAtMs)) && (await drainDecisions(deadlineAtMs));
    } catch {
      succeeded = false;
    } finally {
      pumpRunning = false;
    }
    if (closed || generation !== recoveryGeneration || !recovered) return;
    if (!succeeded) {
      recovered = false;
      recoveryGeneration += 1;
      schedule(triggerRecovery, pumpRetryMs);
      return;
    }
    const immediate = pumpRequested;
    pumpRequested = false;
    schedulePump(immediate ? 0 : succeeded ? pumpIntervalMs : pumpRetryMs, generation);
  };

  wakePump = (): void => {
    if (closed || !recovered) return;
    if (pumpRunning) pumpRequested = true;
    else schedulePump(0, recoveryGeneration);
  };

  const scheduleAudit = (nextAuditTimeMs: number, generation: number): void => {
    const delay = Math.max(0, nextAuditTimeMs - nowMs());
    schedule(() => {
      if (closed || generation !== recoveryGeneration) return;
      const deadlineAtMs = nowMs() + recoveryTimeoutMs;
      void dependencies.approvalStorage
        .hostedTeamApprovalAuditTimeouts({ nextAuditTimeMs, deadlineAtMs })
        .then(async (result) => {
          if (closed || generation !== recoveryGeneration) return;
          if (
            !(await projectPermissionRequests(deadlineAtMs)) ||
            !(await drainDecisions(deadlineAtMs))
          ) {
            recovered = false;
            recoveryGeneration += 1;
            schedule(triggerRecovery, pumpRetryMs);
            return;
          }
          if (result.nextAuditTimeMs !== null) scheduleAudit(result.nextAuditTimeMs, generation);
        })
        .catch(() => {
          if (closed || generation !== recoveryGeneration) return;
          recovered = false;
          recoveryGeneration += 1;
          schedule(triggerRecovery, pumpRetryMs);
        });
    }, delay);
  };

  const beginRecovery = (): void => {
    if (closed) return;
    const recoveryStartedAt = nowMs();
    const recoveryDeadline = recoveryStartedAt + recoveryTimeoutMs;
    if (
      !Number.isSafeInteger(recoveryStartedAt) ||
      recoveryStartedAt < 0 ||
      !Number.isSafeInteger(recoveryDeadline)
    ) {
      throw new TypeError('hosted-operator-production-clock-invalid');
    }
    const generation = recoveryGeneration;
    schedule(() => {
      if (closed || generation !== recoveryGeneration || recovered) return;
      recoveryGeneration += 1;
      schedule(beginRecovery, pumpRetryMs);
    }, recoveryTimeoutMs);
    void (async () => {
      const audit = await dependencies.approvalStorage.hostedTeamApprovalAuditTimeouts({
        nextAuditTimeMs: recoveryStartedAt,
        deadlineAtMs: recoveryDeadline,
      });
      if (!(await projectPermissionRequests(recoveryDeadline)))
        throw new Error('projection-incomplete');
      if (!(await drainDecisions(recoveryDeadline))) throw new Error('delivery-incomplete');
      if (closed || generation !== recoveryGeneration) return;
      recovered = true;
      schedulePump(pumpIntervalMs, generation);
      if (audit.nextAuditTimeMs !== null) scheduleAudit(audit.nextAuditTimeMs, generation);
    })().catch(() => {
      if (closed || generation !== recoveryGeneration) return;
      recovered = false;
      recoveryGeneration += 1;
      schedule(beginRecovery, pumpRetryMs);
    });
  };
  triggerRecovery = beginRecovery;
  beginRecovery();

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
            [
              'live',
              'serve',
              'auth',
              'read',
              'mutation',
              'runtime-control',
              'machine-ingress',
              'recovery-point',
            ].map((dimension) => Object.freeze({ dimension, status, reasons }))
          ),
          terminal: Object.freeze({
            dimension: 'terminal' as const,
            status: 'not_offered' as const,
            reasons: Object.freeze([]),
          }),
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

  const authenticatedContext = (request: FastifyRequest, signal: AbortSignal): QueryContext => {
    const result = queryContexts.create(request, signal);
    if (result.kind !== 'success') {
      throw new Error(`hosted-operator-production-query-context-${result.code}`);
    }
    return result.context;
  };
  const approvalContext = (
    _descriptor: unknown,
    request: object,
    signal: AbortSignal
  ): QueryContext => {
    if (closed || !recovered) throw new Error('hosted-operator-production-recovery-incomplete');
    return authenticatedContext(request as FastifyRequest, signal);
  };
  const surfaces = createHostedOperatorSurfacesComposition({
    routeAdmission: dependencies.routeAdmissionBinding.routeAdmission,
    readiness: {
      contribution: createHostedReadinessRouteContribution(readiness),
      createContext: authenticatedContext,
    },
    approvals: {
      contribution: createHostedTeamApprovalsRouteContribution(approvals),
      createContext: approvalContext,
    },
  });

  return Object.freeze({
    isReady: () => !closed && recovered,
    reconcileApprovalDecision(
      request: HostedApprovalDecisionReconciliationRequest
    ): Promise<HostedApprovalDecisionReconciliationResult> {
      if (closed || !recovered) return Promise.resolve(Object.freeze({ status: 'unavailable' }));
      return runtimeBridge.reconcileApprovalDecision(request);
    },
    register(app: FastifyInstance): void {
      if (closed || registered) throw new Error('hosted-operator-production-unavailable');
      registered = true;
      surfaces.register(app);
    },
    close(): void {
      if (closed) return;
      closed = true;
      recovered = false;
      recoveryGeneration += 1;
      for (const timer of timers) clearTimer(timer);
      timers.clear();
    },
  });
}
