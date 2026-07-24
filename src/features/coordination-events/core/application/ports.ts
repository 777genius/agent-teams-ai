import type {
  CoordinationEventActor,
  CoordinationEventDraft,
  CoordinationEventEnvelope,
  CoordinationEventPublishDraft,
  CoordinationEventRecoveryPoint,
  CoordinationEventScopeKind,
  CoordinationJsonValue,
  CoordinationResourceRevision,
  EventJournalWatermark,
} from '../../contracts';

/**
 * This value must be created from authenticated server/runtime state, never
 * deserialized from the event submission body. Keeping it separate from the
 * publish draft prevents a caller from supplying actor, run, or member
 * attribution that is later persisted as trusted fact.
 */
export interface TrustedCoordinationEventContext {
  readonly actor: CoordinationEventActor;
  readonly runId?: string;
}

export interface PublishCoordinationEventCommand<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly trustedContext: TrustedCoordinationEventContext;
  readonly draft: CoordinationEventPublishDraft<TPayload>;
}

export interface CoordinationSnapshotRequest {
  readonly scopeKind: CoordinationEventScopeKind;
  readonly scopeId: string;
}

export interface SameTransactionCoordinationSnapshotRead<TSnapshot> {
  readonly snapshot: TSnapshot;
  readonly revisionVector: readonly CoordinationResourceRevision[];
  /**
   * Projection, revision vector, and watermark must be read from the same
   * storage transaction. The application layer deliberately cannot synthesize
   * this guarantee from separate reads.
   */
  readonly watermark: EventJournalWatermark;
}

export interface SameTransactionCoordinationSnapshotSource<TSnapshot> {
  readSnapshotWithEventBarrier(
    request: CoordinationSnapshotRequest
  ): Promise<SameTransactionCoordinationSnapshotRead<TSnapshot>>;
}

export interface ExternalCoordinationSnapshotRead<TSnapshot> {
  readonly snapshot: TSnapshot;
  readonly revisionVector: readonly CoordinationResourceRevision[];
  /** Stable, opaque feature-owned generation evidence from before and after the scan. */
  readonly sourceGenerationBefore: string;
  readonly sourceGenerationAfter: string;
}

export interface ExternalCoordinationSnapshotReadContext {
  /**
   * The source must stop an in-flight scan promptly when this signal aborts.
   * Core independently enforces the absolute deadline, discards any late
   * result, and releases its lease even if the source ignores cancellation.
   * Adapters therefore remain responsible for stopping underlying scan work
   * when aborted rather than relying on promise settlement for safety.
   */
  readonly signal: AbortSignal;
  /** Unix epoch milliseconds for the lease-bound external observation deadline. */
  readonly deadlineAtMs: number;
}

export interface ExternalCoordinationSnapshotSource<TSnapshot> {
  readStableSnapshot(
    request: CoordinationSnapshotRequest,
    context: ExternalCoordinationSnapshotReadContext
  ): Promise<ExternalCoordinationSnapshotRead<TSnapshot>>;
}

export interface SnapshotRetentionLease {
  readonly leaseId: string;
  readonly watermark: EventJournalWatermark;
  /**
   * Coordinator-owned Unix epoch millisecond deadline. It must be no later
   * than the TTL supplied at acquisition.
   */
  readonly deadlineAtMs: number;
}

export interface SnapshotRetentionLeaseStatus {
  readonly active: boolean;
  readonly watermark: EventJournalWatermark;
}

export interface SnapshotRetentionLeaseReleaseContext {
  /**
   * Cooperative cancellation for release I/O. Core stops awaiting release at
   * `deadlineAtMs`, but abort is not permission to retain the lease: adapters
   * must make release idempotent and complete an already-started release safely
   * even when its caller has stopped waiting.
   */
  readonly signal: AbortSignal;
  /** Unix epoch milliseconds for the capture's end-to-end deadline. */
  readonly deadlineAtMs: number;
}

/**
 * Capture and lease registration must be one coordinator operation so
 * retention cannot advance between observing C0 and pinning it.
 */
export interface SnapshotRetentionLeaseCoordinator {
  acquireSnapshotLease(input: {
    readonly request: CoordinationSnapshotRequest;
    readonly ttlMs: number;
    /** Core-enforced absolute acquisition deadline. */
    readonly deadlineAtMs: number;
    /** Cooperative cancellation; core also enforces the deadline independently. */
    readonly signal: AbortSignal;
  }): Promise<SnapshotRetentionLease>;
  /**
   * Atomically reports current ownership and, when active, keeps the retained
   * floor pinned until `run` settles. Expiry and pruning must not overtake an
   * active callback. Inactive status is delivered only so core can return its
   * typed retry outcome before any snapshot delivery. This is the final
   * delivery boundary, not a point-in-time status inspection.
   */
  runWithSnapshotLease<TResult>(input: {
    readonly leaseId: string;
    readonly run: (status: SnapshotRetentionLeaseStatus) => Promise<TResult>;
  }): Promise<TResult>;
  /**
   * Starts idempotent lease invalidation. Implementations must settle promptly,
   * observe the cooperative deadline, and must not require the caller to await
   * a late completion. Core always attempts this operation but will stop waiting
   * at the capture's end-to-end deadline.
   */
  releaseSnapshotLease(
    leaseId: string,
    context: SnapshotRetentionLeaseReleaseContext
  ): Promise<void>;
}

export interface CoordinationJournalReplayRead<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly events: readonly CoordinationEventEnvelope<TPayload>[];
  /**
   * Watermark observed by the durable query. Returning it closes retention
   * races and lets core reject an overtaken cursor.
   */
  readonly watermark: EventJournalWatermark;
}

export interface CommittedCoordinationEventAppend<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly event: CoordinationEventEnvelope<TPayload>;
  readonly watermark: EventJournalWatermark;
}

export interface CoordinationEventJournal {
  getWatermark(): Promise<EventJournalWatermark>;
  readCommittedEvents<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(input: {
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<CoordinationJournalReplayRead<TPayload>>;
  /**
   * Implementations assign epoch/sequence/cursor and durably commit the one
   * outbox-journal row before resolving. Prepared rows must never be returned.
   */
  appendCommittedEvent<TPayload extends CoordinationJsonValue>(
    draft: CoordinationEventDraft<TPayload>
  ): Promise<CommittedCoordinationEventAppend<TPayload>>;
}

/**
 * A wake-up is only a coalescing latency hint. Durable journal replay remains
 * authoritative when this port fails or the process crashes before it runs.
 */
export interface CoordinationEventWakeup {
  notifyCommittedEvent(event: CoordinationEventEnvelope): Promise<void>;
}

export interface CoordinationEventRecoveryPointPreparation {
  readonly schemaVersion: 1;
  readonly participantId: string;
  readonly recoveryRunId: string;
  readonly deploymentId: string;
}

export interface CoordinationEventRecoveryPointStage {
  readonly schemaVersion: 1;
  readonly participantId: string;
  readonly recoveryRunId: string;
  readonly stagedArtifactRef: string;
  readonly contentDigest: string;
  readonly recoveryPoint: CoordinationEventRecoveryPoint;
}

export interface VerifiedCoordinationEventRecoveryPoint extends CoordinationEventRecoveryPointStage {
  readonly verified: true;
}

/**
 * Event-journal contribution to the backup feature's recovery-point workflow.
 * The backup coordinator must call these in prepare -> flush -> stage -> verify
 * order and publish its root marker only after all participants verify.
 */
export interface CoordinationEventRecoveryPointParticipant {
  readonly participantId: string;
  prepare(input: {
    readonly recoveryRunId: string;
    readonly deploymentId: string;
  }): Promise<CoordinationEventRecoveryPointPreparation>;
  flush(
    preparation: CoordinationEventRecoveryPointPreparation
  ): Promise<CoordinationEventRecoveryPoint>;
  stage(input: {
    readonly preparation: CoordinationEventRecoveryPointPreparation;
    readonly recoveryPoint: CoordinationEventRecoveryPoint;
  }): Promise<CoordinationEventRecoveryPointStage>;
  verify(
    stage: CoordinationEventRecoveryPointStage
  ): Promise<VerifiedCoordinationEventRecoveryPoint>;
}
