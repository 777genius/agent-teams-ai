export const COORDINATION_EVENT_SCHEMA_VERSION = 1 as const;
export const COORDINATION_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const REPLAY_CURSOR_SCHEMA_VERSION = 1 as const;
export const EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION = 1 as const;
export const COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION = 1 as const;

export const COORDINATION_EVENT_SCOPE_KINDS = Object.freeze([
  'instance',
  'catalog',
  'workspace',
  'team',
  'run',
  'session',
] as const);

export type CoordinationEventScopeKind = (typeof COORDINATION_EVENT_SCOPE_KINDS)[number];

export const COORDINATION_EVENT_ACTOR_KINDS = Object.freeze([
  'operator',
  'verified_runtime',
  'external_file',
  'recovery',
] as const);

export type CoordinationEventActorKind = (typeof COORDINATION_EVENT_ACTOR_KINDS)[number];

export const SNAPSHOT_EVENT_HANDOFF_MODES = Object.freeze([
  'same_transaction',
  'lower_barrier',
] as const);

export type SnapshotEventHandoffMode = (typeof SNAPSHOT_EVENT_HANDOFF_MODES)[number];

/**
 * Cursors are intentionally opaque outside the coordination-events feature.
 * Callers may persist or echo the value, but must not construct or increment it.
 */
declare const replayCursorBrand: unique symbol;
export type ReplayCursor = string & { readonly [replayCursorBrand]: true };

export type CoordinationJsonValue =
  | null
  | boolean
  | number
  | string
  | readonly CoordinationJsonValue[]
  | { readonly [key: string]: CoordinationJsonValue };

export interface ReplayCursorPosition {
  readonly cursorVersion: typeof REPLAY_CURSOR_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  /** The last event already represented or processed by the cursor holder. */
  readonly eventSequence: number;
}

/**
 * `retentionFloorSequence` is the oldest cursor position the journal can still
 * replay after. Rows with a sequence greater than that position remain
 * available. It is therefore a cursor floor, not the first retained row.
 */
export interface EventJournalWatermark {
  readonly schemaVersion: typeof EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly retentionFloorSequence: number;
  readonly highWatermarkSequence: number;
}

export interface CoordinationEventScope {
  readonly kind: CoordinationEventScopeKind;
  readonly scopeId: string;
}

export type CoordinationEventActor =
  | {
      readonly kind: 'operator';
      readonly actorRef: string;
    }
  | {
      readonly kind: 'verified_runtime';
      readonly actorRef: string;
      readonly runId: string;
      readonly memberId?: string;
    }
  | {
      readonly kind: 'external_file';
      readonly actorRef?: string;
      readonly fileWriterEpoch: number;
      readonly observationSequence: number;
    }
  | {
      readonly kind: 'recovery';
      readonly actorRef: string;
    };

/**
 * Revisions are resource-scoped. Journal event sequence is deliberately not a
 * data revision because runtime observations may produce events without
 * mutating a durable projection.
 */
export interface CoordinationResourceRevision {
  readonly resourceKey: string;
  readonly generation: number;
  readonly revision: number;
}

export interface CoordinationEventDraft<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly schemaVersion: typeof COORDINATION_EVENT_SCHEMA_VERSION;
  readonly eventId: string;
  readonly scope: CoordinationEventScope;
  readonly workspaceId?: string;
  readonly teamId?: string;
  readonly runId?: string;
  readonly actor: CoordinationEventActor;
  readonly eventType: string;
  readonly resourceRevision?: CoordinationResourceRevision;
  readonly emittedAt: string;
  readonly payload: TPayload;
}

/**
 * Untrusted event input deliberately excludes server-owned attribution. The
 * application layer binds `actor` and `runId` from a trusted request context
 * immediately before the durable append.
 */
export type CoordinationEventPublishDraft<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> = Omit<CoordinationEventDraft<TPayload>, 'actor' | 'runId'>;

export interface CoordinationEventEnvelope<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> extends CoordinationEventDraft<TPayload> {
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly eventSequence: number;
  /** The SSE id and durable replay position assigned by the journal. */
  readonly eventCursor: ReplayCursor;
}

export interface CoordinationSnapshotMetadata {
  readonly schemaVersion: typeof COORDINATION_SNAPSHOT_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly handoffMode: SnapshotEventHandoffMode;
  /**
   * A same-transaction cursor or a retained lower barrier captured before an
   * external projection read. This must never be described as the latest
   * cursor represented by the payload.
   */
  readonly replayCursor: ReplayCursor;
  readonly revisionVector: readonly CoordinationResourceRevision[];
}

export interface CoordinationSnapshotEnvelope<TSnapshot = unknown> {
  readonly metadata: CoordinationSnapshotMetadata;
  readonly snapshot: TSnapshot;
}

export interface CoordinationReplayBatch<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly schemaVersion: typeof COORDINATION_EVENT_SCHEMA_VERSION;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly fromCursor: ReplayCursor;
  readonly nextCursor: ReplayCursor;
  readonly events: readonly CoordinationEventEnvelope<TPayload>[];
  readonly watermark: EventJournalWatermark;
  readonly hasMore: boolean;
}

/**
 * A portable barrier contributed by the event journal to a coordinated
 * recovery point. The owning backup feature decides how it is staged and
 * published; this feature owns only the journal consistency contract.
 */
export interface CoordinationEventRecoveryPoint {
  readonly schemaVersion: typeof COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION;
  readonly participantId: string;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly retentionFloorSequence: number;
  readonly highWatermarkSequence: number;
  readonly replayCursor: ReplayCursor;
}
