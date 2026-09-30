import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedApprovalDecisionReconciliationPort,
  HostedRuntimePermissionIngressAuthorityPort,
  HostedRuntimePermissionIngressEffectPort,
} from '../../../ports/HostedTeamApprovalRuntimeBridgePorts';
import type { TeamId } from '@shared/contracts/hosted';

export interface HostedApprovalRuntimeOrchestratorRoute {
  readonly teamId: TeamId;
  readonly authority: HostedRuntimePermissionIngressEffectPort &
    HostedRuntimePermissionIngressAuthorityPort &
    HostedApprovalDecisionExternalLifecycleDeliveryPort &
    HostedApprovalDecisionReconciliationPort;
}

/**
 * Routes every approval effect from the immutable record team, never from UI
 * selection or a process-global current team. Claims are spread fairly across
 * the signed route catalog and acknowledgements remain bound to the route that
 * returned the exact outbox record.
 */
export class HostedApprovalRuntimeOrchestratorRouter
  implements
    HostedRuntimePermissionIngressEffectPort,
    HostedRuntimePermissionIngressAuthorityPort,
    HostedApprovalDecisionExternalLifecycleDeliveryPort,
    HostedApprovalDecisionReconciliationPort
{
  private readonly routes: readonly HostedApprovalRuntimeOrchestratorRoute[];
  private readonly byTeam = new Map<string, HostedApprovalRuntimeOrchestratorRoute>();
  private readonly claimedOutboxRoutes = new Map<string, string>();
  private claimCursor = 0;
  private closed = false;

  constructor(routes: readonly HostedApprovalRuntimeOrchestratorRoute[]) {
    if (routes.length === 0 || routes.length > 256) {
      throw new TypeError('hosted-approval-runtime-route-catalog-invalid');
    }
    for (const route of routes) {
      if (this.byTeam.has(route.teamId)) {
        throw new TypeError('hosted-approval-runtime-route-team-duplicate');
      }
      this.byTeam.set(route.teamId, route);
    }
    this.routes = Object.freeze([...routes]);
  }

  async claimPermissionApprovalIngressEffects(
    request: Parameters<
      HostedRuntimePermissionIngressEffectPort['claimPermissionApprovalIngressEffects']
    >[0]
  ): ReturnType<HostedRuntimePermissionIngressEffectPort['claimPermissionApprovalIngressEffects']> {
    this.assertOpen();
    const routeCount = Math.min(this.routes.length, request.limit);
    const selected = Array.from(
      { length: routeCount },
      (_, index) => this.routes[(this.claimCursor + index) % this.routes.length]
    );
    this.claimCursor = (this.claimCursor + routeCount) % this.routes.length;
    let remaining = request.limit;
    const allocations = selected.map((_, index) => {
      const allocation = Math.ceil(remaining / (selected.length - index));
      remaining -= allocation;
      return allocation;
    });
    const batches = await Promise.all(
      selected.map((route, index) =>
        route.authority.claimPermissionApprovalIngressEffects({
          ...request,
          limit: allocations[index],
        })
      )
    );
    const records = batches.flatMap((batch, index) => {
      const route = selected[index];
      return batch.filter((record) => {
        if (record.authority.teamId !== route.teamId) return false;
        this.claimedOutboxRoutes.set(record.outboxId, route.teamId);
        return true;
      });
    });
    return Object.freeze(records.slice(0, request.limit));
  }

  acknowledgePermissionApprovalIngressEffect(
    request: Parameters<
      HostedRuntimePermissionIngressEffectPort['acknowledgePermissionApprovalIngressEffect']
    >[0]
  ): ReturnType<
    HostedRuntimePermissionIngressEffectPort['acknowledgePermissionApprovalIngressEffect']
  > {
    this.assertOpen();
    const teamId = this.claimedOutboxRoutes.get(request.outboxId);
    if (teamId === undefined) return Promise.resolve(Object.freeze({ status: 'unavailable' }));
    const route = this.byTeam.get(teamId);
    if (route === undefined) return Promise.resolve(Object.freeze({ status: 'unavailable' }));
    return route.authority.acknowledgePermissionApprovalIngressEffect(request).finally(() => {
      this.claimedOutboxRoutes.delete(request.outboxId);
    });
  }

  resolvePersistedIngressAuthority(
    authority: Parameters<
      HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']
    >[0]
  ): ReturnType<HostedRuntimePermissionIngressAuthorityPort['resolvePersistedIngressAuthority']> {
    this.assertOpen();
    const route = this.byTeam.get(authority.teamId);
    if (route === undefined) return Promise.resolve(Object.freeze({ status: 'unavailable' }));
    return route.authority.resolvePersistedIngressAuthority(authority);
  }

  deliverRuntimePermissionDecision(
    request: Parameters<
      HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
    >[0]
  ): ReturnType<
    HostedApprovalDecisionExternalLifecycleDeliveryPort['deliverRuntimePermissionDecision']
  > {
    this.assertOpen();
    const route = this.byTeam.get(request.partition.teamId);
    if (route === undefined) {
      return Promise.resolve(
        Object.freeze({
          status: 'operator_required',
          reconciliationRef: request.reconciliationRef,
        })
      );
    }
    return route.authority.deliverRuntimePermissionDecision(request);
  }

  reconcileRuntimePermissionDecision(
    request: Parameters<
      HostedApprovalDecisionReconciliationPort['reconcileRuntimePermissionDecision']
    >[0]
  ): ReturnType<HostedApprovalDecisionReconciliationPort['reconcileRuntimePermissionDecision']> {
    this.assertOpen();
    const route = this.byTeam.get(request.partition.teamId);
    if (route === undefined) return Promise.resolve(Object.freeze({ status: 'unavailable' }));
    return route.authority.reconcileRuntimePermissionDecision(request);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.claimedOutboxRoutes.clear();
    for (const route of this.routes) {
      const closable = route.authority as { close?: () => void };
      closable.close?.();
    }
  }

  private assertOpen(): void {
    if (this.closed) throw new Error('hosted-approval-runtime-route-catalog-closed');
  }
}
