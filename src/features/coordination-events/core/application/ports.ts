import type {
  CoordinationEventActor,
  CoordinationEventDraft,
  CoordinationEventEnvelope,
  CoordinationEventPublishDraft,
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
   * result, and falls back to a fresh snapshot when the returned cursor is no
   * longer retained. Adapters remain responsible for stopping underlying scan
   * work when aborted rather than relying on promise settlement for safety.
   */
  readonly signal: AbortSignal;
  /** Unix epoch milliseconds for the bounded external observation deadline. */
  readonly deadlineAtMs: number;
}

export interface ExternalCoordinationSnapshotSource<TSnapshot> {
  readStableSnapshot(
    request: CoordinationSnapshotRequest,
    context: ExternalCoordinationSnapshotReadContext
  ): Promise<ExternalCoordinationSnapshotRead<TSnapshot>>;
}

export interface CoordinationEventDeadlineScheduler {
  /** Schedules one deadline and returns an idempotent cancellation callback. */
  scheduleDeadline(delayMs: number, onDeadline: () => void): () => void;
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
