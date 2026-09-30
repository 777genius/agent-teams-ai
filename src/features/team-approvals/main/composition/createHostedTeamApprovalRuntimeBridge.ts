import { RuntimeIngressPermissionOutbox } from '@features/team-runtime-control';

import { HostedRuntimePermissionRequestProjector } from '../adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector';
import { HostedApprovalDecisionDeliveryCoordinator } from '../adapters/output/runtime-ingress/HostedApprovalDecisionDeliveryCoordinator';
import { HostedApprovalDecisionReconciliationCoordinator } from '../adapters/output/runtime-ingress/HostedApprovalDecisionReconciliationCoordinator';

import type {
  HostedRuntimePermissionProjectionRequest,
  HostedRuntimePermissionProjectionResult,
} from '../adapters/input/runtime-ingress/HostedRuntimePermissionRequestProjector';
import type {
  HostedApprovalDecisionDeliveryRequest,
  HostedApprovalDecisionDeliveryResult,
} from '../adapters/output/runtime-ingress/HostedApprovalDecisionDeliveryCoordinator';
import type {
  HostedApprovalDecisionReconciliationRequest,
  HostedApprovalDecisionReconciliationResult,
} from '../adapters/output/runtime-ingress/HostedApprovalDecisionReconciliationCoordinator';
import type {
  HostedTeamApprovalDeliveryOutboxPort,
  HostedTeamApprovalPendingIngressPort,
} from '../ports/HostedTeamApprovalAuthorityStoragePort';
import type {
  HostedApprovalDecisionExternalLifecycleDeliveryPort,
  HostedApprovalDecisionReconciliationPort,
  HostedRuntimePermissionIngressAuthorityPort,
  HostedRuntimePermissionIngressEffectPort,
  HostedTeamApprovalRuntimeBridgeClockPort,
} from '../ports/HostedTeamApprovalRuntimeBridgePorts';

export interface HostedTeamApprovalRuntimeBridgeDependencies {
  readonly ingressEffectOutbox: HostedRuntimePermissionIngressEffectPort;
  readonly pendingIngress: HostedTeamApprovalPendingIngressPort;
  readonly ingressAuthority: HostedRuntimePermissionIngressAuthorityPort;
  readonly deliveryOutbox: HostedTeamApprovalDeliveryOutboxPort;
  readonly externalDecisionDelivery: HostedApprovalDecisionExternalLifecycleDeliveryPort;
  readonly externalDecisionReconciliation: HostedApprovalDecisionReconciliationPort;
  readonly clock?: HostedTeamApprovalRuntimeBridgeClockPort;
}

export interface HostedTeamApprovalRuntimeBridge {
  readonly projectRuntimePermissionRequests: (
    request: HostedRuntimePermissionProjectionRequest
  ) => Promise<HostedRuntimePermissionProjectionResult>;
  readonly deliverApprovalDecisions: (
    request: HostedApprovalDecisionDeliveryRequest
  ) => Promise<HostedApprovalDecisionDeliveryResult>;
  readonly reconcileApprovalDecision: (
    request: HostedApprovalDecisionReconciliationRequest
  ) => Promise<HostedApprovalDecisionReconciliationResult>;
}

/**
 * Wires durable ingress and decision outboxes without mounting an HTTP route,
 * renderer surface, or process lifecycle owner.
 */
export function createHostedTeamApprovalRuntimeBridge(
  dependencies: HostedTeamApprovalRuntimeBridgeDependencies
): HostedTeamApprovalRuntimeBridge {
  const clock = dependencies.clock ?? Object.freeze({ now: Date.now });
  const projector = new HostedRuntimePermissionRequestProjector(
    new RuntimeIngressPermissionOutbox(dependencies.ingressEffectOutbox),
    dependencies.pendingIngress,
    dependencies.ingressAuthority,
    clock
  );
  const delivery = new HostedApprovalDecisionDeliveryCoordinator(
    dependencies.deliveryOutbox,
    dependencies.externalDecisionDelivery,
    clock
  );
  const reconciliation = new HostedApprovalDecisionReconciliationCoordinator(
    dependencies.deliveryOutbox,
    dependencies.externalDecisionReconciliation,
    clock
  );
  return Object.freeze({
    projectRuntimePermissionRequests: projector.project.bind(projector),
    deliverApprovalDecisions: delivery.deliver.bind(delivery),
    reconcileApprovalDecision: reconciliation.reconcile.bind(reconciliation),
  });
}
