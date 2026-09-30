/**
 * Team-console renderer ownership stops at transport reconciliation. Hosted message presentation
 * and HTTP transport are exposed exclusively by `@features/team-message-delivery/renderer`.
 */
export type {
  TeamTransportBootstrapPort,
  TeamTransportBootstrapRequest,
  TeamTransportBootstrapSnapshot,
  TeamTransportEventApplication,
  TeamTransportEventApplicationInput,
  TeamTransportEventListener,
  TeamTransportEventStreamPort,
  TeamTransportProjectionPort,
  TeamTransportReconcilerFailure,
  TeamTransportReconcilerFailureReason,
  TeamTransportReconcilerObserverPort,
  TeamTransportReconcilerPorts,
  TeamTransportReconciliationTarget,
  TeamTransportSnapshotCommit,
  TeamTransportStreamRequest,
  TeamTransportStreamSubscription,
} from './ports/TeamTransportReconcilerPorts';
export type {
  TeamTransportReconcilerOptions,
  TeamTransportReconcilerStatus,
} from './reconciliation/TeamTransportReconciler';
export { TeamTransportReconciler } from './reconciliation/TeamTransportReconciler';
