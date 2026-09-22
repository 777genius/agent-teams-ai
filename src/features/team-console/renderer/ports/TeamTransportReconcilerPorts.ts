import type {
  CoordinationEventScope,
  CoordinationResourceRevision,
  CoordinationSnapshotEnvelope,
  HostedCoordinationEventEnvelope,
  HostedCoordinationEventStreamMessage,
  ReplayCursor,
} from '@features/coordination-events/contracts';

export interface TeamTransportReconciliationTarget {
  readonly scope: CoordinationEventScope;
  /**
   * Renderer-owned generation captured when this scope was selected. A reset
   * that reuses the same scope ID must use a new generation.
   */
  readonly scopeGeneration: number;
}

export interface TeamTransportBootstrapSnapshot<TSnapshot> {
  readonly scope: CoordinationEventScope;
  readonly scopeGeneration: number;
  readonly envelope: CoordinationSnapshotEnvelope<TSnapshot>;
}

export interface TeamTransportBootstrapRequest extends TeamTransportReconciliationTarget {
  readonly signal: AbortSignal;
}

export interface TeamTransportBootstrapPort<TSnapshot> {
  loadSnapshot(
    request: TeamTransportBootstrapRequest
  ): Promise<TeamTransportBootstrapSnapshot<TSnapshot>>;
}

export type TeamTransportEventListener = (
  message: HostedCoordinationEventStreamMessage
) => Promise<void>;

export interface TeamTransportStreamRequest extends TeamTransportReconciliationTarget {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  /** Opaque lower replay barrier returned by the committed snapshot. */
  readonly after: ReplayCursor;
  readonly signal: AbortSignal;
  readonly onMessage: TeamTransportEventListener;
}

export interface TeamTransportStreamSubscription {
  close(): void;
}

/**
 * Implemented by the browser transport boundary. The reconciler deliberately
 * does not construct a concrete connection, issue requests, or own retries.
 */
export interface TeamTransportEventStreamPort {
  subscribe(
    request: TeamTransportStreamRequest
  ): TeamTransportStreamSubscription | Promise<TeamTransportStreamSubscription>;
}

export type TeamTransportEventApplication = 'applied' | 'refresh_required';

/**
 * Cycle-scoped CAS boundary for entity-specific projection state. Async event
 * preparation must perform its final synchronous mutation through this token.
 */
export interface TeamTransportProjectionToken {
  readonly cycle: number;
  commitIfCurrent(commit: () => void): boolean;
}

export interface TeamTransportSnapshotCommit<TSnapshot> extends TeamTransportReconciliationTarget {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventCursor: ReplayCursor;
  readonly revisionVector: readonly CoordinationResourceRevision[];
  readonly snapshot: TSnapshot;
}

export interface TeamTransportEventApplicationInput extends TeamTransportReconciliationTarget {
  readonly event: HostedCoordinationEventEnvelope;
  readonly projectionToken: TeamTransportProjectionToken;
}

/** Entity-specific state mutation remains outside the transport reconciler. */
export interface TeamTransportProjectionPort<TSnapshot> {
  replaceSnapshot(commit: TeamTransportSnapshotCommit<TSnapshot>): void | Promise<void>;
  applyEvent(
    input: TeamTransportEventApplicationInput
  ): TeamTransportEventApplication | Promise<TeamTransportEventApplication>;
}

export type TeamTransportReconcilerFailureReason =
  | 'bootstrap_failed'
  | 'invalid_snapshot'
  | 'scope_mismatch'
  | 'generation_mismatch'
  | 'deployment_mismatch'
  | 'epoch_mismatch'
  | 'cursor_gap'
  | 'revision_gap'
  | 'pending_queue_overflow'
  | 'invalid_message'
  | 'resync_required'
  | 'projection_failed'
  | 'stream_failed';

export interface TeamTransportReconcilerFailure {
  readonly reason: TeamTransportReconcilerFailureReason;
  readonly cause?: unknown;
}

export interface TeamTransportReconcilerObserverPort {
  onFailure?(failure: TeamTransportReconcilerFailure): void;
}

export interface TeamTransportReconcilerPorts<TSnapshot> {
  readonly bootstrap: TeamTransportBootstrapPort<TSnapshot>;
  readonly stream: TeamTransportEventStreamPort;
  readonly projection: TeamTransportProjectionPort<TSnapshot>;
  readonly observer?: TeamTransportReconcilerObserverPort;
}
