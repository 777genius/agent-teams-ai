import {
  COORDINATION_EVENT_ACTOR_KINDS,
  COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION,
  COORDINATION_EVENT_SCHEMA_VERSION,
  COORDINATION_EVENT_SCOPE_KINDS,
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationEventRecoveryPoint,
  type CoordinationJsonValue,
  type CoordinationReplayBatch,
  type CoordinationResourceRevision,
  type CoordinationSnapshotMetadata,
  type EventJournalWatermark,
  SNAPSHOT_EVENT_HANDOFF_MODES,
  type SnapshotEventHandoffMode,
} from '../../contracts';

import {
  assertJournalWatermark,
  decodeReplayCursor,
  encodeReplayCursor,
  materializeEventJournalWatermark,
  validateReplayCursor,
} from './replayCursor';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EVENT_TYPE_LENGTH = 256;
const MAX_REVISION_VECTOR_LENGTH = 10_000;
const MAX_DOMAIN_REPLAY_BATCH_SIZE = 10_000;
const MAX_COORDINATION_SNAPSHOT_DEPTH = 128;
const MAX_COORDINATION_SNAPSHOT_NODES = 100_000;
export const MAX_RECONCILIATION_PROCESSED_EVENT_IDS = 10_000;
export const MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES = 256 * 1_024;
export const MAX_COORDINATION_EVENT_PAYLOAD_DEPTH = 64;
export const MAX_COORDINATION_EVENT_PAYLOAD_NODES = 10_000;

export type SnapshotEventHandoffErrorCode =
  | 'unsupported_snapshot_version'
  | 'unsupported_event_version'
  | 'unsupported_recovery_point_version'
  | 'invalid_snapshot_metadata'
  | 'invalid_snapshot_data'
  | 'invalid_coordination_event'
  | 'invalid_replay_limit'
  | 'event_sequence_discontinuity'
  | 'resource_revision_discontinuity'
  | 'resource_revision_regression'
  | 'duplicate_event'
  | 'event_cursor_mismatch'
  | 'journal_watermark_mismatch'
  | 'journal_watermark_regression'
  | 'invalid_recovery_point';

export class SnapshotEventHandoffError extends Error {
  constructor(
    readonly code: SnapshotEventHandoffErrorCode,
    message: string,
    readonly details: Readonly<Record<string, unknown>> = {}
  ) {
    super(message);
    this.name = 'SnapshotEventHandoffError';
  }
}

export interface CreateSnapshotMetadataInput {
  readonly watermark: EventJournalWatermark;
  readonly handoffMode: SnapshotEventHandoffMode;
  readonly revisionVector: readonly CoordinationResourceRevision[];
}

export function createCoordinationSnapshotMetadata(
  input: CreateSnapshotMetadataInput
): CoordinationSnapshotMetadata {
  assertJournalWatermark(input.watermark);
  if (!SNAPSHOT_EVENT_HANDOFF_MODES.includes(input.handoffMode)) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Snapshot event handoff mode is invalid',
      { handoffMode: input.handoffMode }
    );
  }
  const revisionVector = materializeRevisionVector(input.revisionVector);
  assertRevisionVector(revisionVector);

  return Object.freeze({
    schemaVersion: COORDINATION_SNAPSHOT_SCHEMA_VERSION,
    deploymentId: input.watermark.deploymentId,
    eventEpoch: input.watermark.eventEpoch,
    handoffMode: input.handoffMode,
    replayCursor: encodeReplayCursor({
      deploymentId: input.watermark.deploymentId,
      eventEpoch: input.watermark.eventEpoch,
      eventSequence: input.watermark.highWatermarkSequence,
    }),
    revisionVector,
  });
}

export function assertCoordinationSnapshotMetadata(
  metadata: CoordinationSnapshotMetadata,
  expectedWatermark?: EventJournalWatermark
): void {
  const materializedMetadata = materializeCoordinationSnapshotMetadata(metadata);
  assertMaterializedCoordinationSnapshotMetadata(materializedMetadata, expectedWatermark);
}

function materializeCoordinationSnapshotMetadata(
  metadata: CoordinationSnapshotMetadata
): CoordinationSnapshotMetadata {
  if (!metadata || typeof metadata !== 'object') {
    throw new SnapshotEventHandoffError(
      'unsupported_snapshot_version',
      'Coordination snapshot metadata version is not supported',
      { schemaVersion: null }
    );
  }
  const schemaVersion = metadata.schemaVersion;
  if (schemaVersion !== COORDINATION_SNAPSHOT_SCHEMA_VERSION) {
    throw new SnapshotEventHandoffError(
      'unsupported_snapshot_version',
      'Coordination snapshot metadata version is not supported',
      { schemaVersion }
    );
  }
  const revisionVector = materializeRevisionVector(metadata.revisionVector);
  return Object.freeze({
    schemaVersion,
    deploymentId: metadata.deploymentId,
    eventEpoch: metadata.eventEpoch,
    handoffMode: metadata.handoffMode,
    replayCursor: metadata.replayCursor,
    revisionVector,
  });
}

function assertMaterializedCoordinationSnapshotMetadata(
  metadata: CoordinationSnapshotMetadata,
  expectedWatermark?: EventJournalWatermark
): void {
  assertIdentifier(metadata.deploymentId, 'deploymentId', 'invalid_snapshot_metadata');
  assertIdentifier(metadata.eventEpoch, 'eventEpoch', 'invalid_snapshot_metadata');
  if (!SNAPSHOT_EVENT_HANDOFF_MODES.includes(metadata.handoffMode)) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Coordination snapshot handoff mode is invalid',
      { handoffMode: metadata.handoffMode }
    );
  }
  assertRevisionVector(metadata.revisionVector);

  const cursor = decodeReplayCursor(metadata.replayCursor);
  if (cursor.deploymentId !== metadata.deploymentId || cursor.eventEpoch !== metadata.eventEpoch) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Coordination snapshot cursor identity does not match its metadata',
      {
        cursorDeploymentId: cursor.deploymentId,
        metadataDeploymentId: metadata.deploymentId,
        cursorEventEpoch: cursor.eventEpoch,
        metadataEventEpoch: metadata.eventEpoch,
      }
    );
  }

  if (expectedWatermark) {
    const position = validateReplayCursor(metadata.replayCursor, expectedWatermark);
    if (position.eventSequence !== expectedWatermark.highWatermarkSequence) {
      throw new SnapshotEventHandoffError(
        'journal_watermark_mismatch',
        'Coordination snapshot cursor is not the captured journal barrier',
        {
          cursorSequence: position.eventSequence,
          highWatermarkSequence: expectedWatermark.highWatermarkSequence,
        }
      );
    }
  }
}

export function assertCoordinationEventDraft(
  draft: CoordinationEventDraft
): asserts draft is CoordinationEventDraft {
  if (!draft || draft.schemaVersion !== COORDINATION_EVENT_SCHEMA_VERSION) {
    throw new SnapshotEventHandoffError(
      'unsupported_event_version',
      'Coordination event version is not supported',
      { schemaVersion: draft?.schemaVersion }
    );
  }
  assertIdentifier(draft.eventId, 'eventId', 'invalid_coordination_event');
  assertScope(draft);
  assertOptionalIdentity(draft.workspaceId, 'workspaceId');
  assertOptionalIdentity(draft.teamId, 'teamId');
  assertOptionalIdentity(draft.runId, 'runId');
  assertScopeReferences(draft);
  assertActor(draft);
  assertIdentifier(
    draft.eventType,
    'eventType',
    'invalid_coordination_event',
    MAX_EVENT_TYPE_LENGTH
  );
  if (draft.resourceRevision) {
    assertResourceRevision(draft.resourceRevision);
  }
  if (!isRfc3339(draft.emittedAt)) {
    throw invalidEvent('Coordination event emittedAt must be an RFC3339 timestamp', {
      emittedAt: draft.emittedAt,
    });
  }
  assertCoordinationJsonPayload(draft.payload);
}

export function assertCoordinationEventEnvelope(
  event: CoordinationEventEnvelope,
  expectedWatermark?: EventJournalWatermark
): asserts event is CoordinationEventEnvelope {
  assertCoordinationEventDraft(event);
  assertIdentifier(event.deploymentId, 'deploymentId', 'invalid_coordination_event');
  assertIdentifier(event.eventEpoch, 'eventEpoch', 'invalid_coordination_event');
  if (!Number.isSafeInteger(event.eventSequence) || event.eventSequence <= 0) {
    throw invalidEvent('Coordination event sequence must be a positive safe integer', {
      eventSequence: event.eventSequence,
    });
  }

  const position = decodeReplayCursor(event.eventCursor);
  if (
    position.deploymentId !== event.deploymentId ||
    position.eventEpoch !== event.eventEpoch ||
    position.eventSequence !== event.eventSequence
  ) {
    throw new SnapshotEventHandoffError(
      'event_cursor_mismatch',
      'Coordination event cursor does not identify its event sequence',
      {
        eventId: event.eventId,
        cursorPosition: position,
        eventDeploymentId: event.deploymentId,
        eventEpoch: event.eventEpoch,
        eventSequence: event.eventSequence,
      }
    );
  }

  if (expectedWatermark) {
    assertJournalWatermark(expectedWatermark);
    if (
      event.deploymentId !== expectedWatermark.deploymentId ||
      event.eventEpoch !== expectedWatermark.eventEpoch ||
      event.eventSequence > expectedWatermark.highWatermarkSequence
    ) {
      throw new SnapshotEventHandoffError(
        'journal_watermark_mismatch',
        'Coordination event is outside the supplied journal watermark',
        {
          eventId: event.eventId,
          eventSequence: event.eventSequence,
          highWatermarkSequence: expectedWatermark.highWatermarkSequence,
        }
      );
    }
  }
}

/**
 * Copies a caller-owned draft through data-property descriptors and returns a
 * fresh deeply frozen value before a durable adapter can observe it. Nested
 * scope, actor, resource revision, and payload values retain no caller-owned
 * references or accessors.
 */
export function materializeCoordinationEventDraft<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(value: unknown): CoordinationEventDraft<TPayload> {
  const record = requireEventDataObject(value, 'draft');
  const scopeRecord = requireEventDataObject(readEventDataProperty(record, 'scope'), 'scope');
  const actorRecord = requireEventDataObject(readEventDataProperty(record, 'actor'), 'actor');
  const resourceRevisionValue = readOptionalEventDataProperty(record, 'resourceRevision');
  const draft = Object.freeze({
    schemaVersion: readEventDataProperty(record, 'schemaVersion'),
    eventId: readEventDataProperty(record, 'eventId'),
    scope: Object.freeze({
      kind: readEventDataProperty(scopeRecord, 'kind'),
      scopeId: readEventDataProperty(scopeRecord, 'scopeId'),
    }),
    ...copyOptionalEventDataProperty(record, 'workspaceId'),
    ...copyOptionalEventDataProperty(record, 'teamId'),
    ...copyOptionalEventDataProperty(record, 'runId'),
    actor: materializeEventActor(actorRecord),
    eventType: readEventDataProperty(record, 'eventType'),
    ...(resourceRevisionValue === undefined
      ? {}
      : { resourceRevision: materializeResourceRevision(resourceRevisionValue) }),
    emittedAt: readEventDataProperty(record, 'emittedAt'),
    payload: materializeCoordinationJsonPayload(readEventDataProperty(record, 'payload')),
  }) as unknown as CoordinationEventDraft<TPayload>;
  assertCoordinationEventDraft(draft);
  return draft;
}

/**
 * Copies an adapter-owned event through data-property descriptors, validates
 * the bounded copy, and returns a fresh deeply frozen envelope. No accessor on
 * the source envelope or its contract-owned nested values is invoked.
 */
export function materializeCoordinationEventEnvelope<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(value: unknown, expectedWatermark?: EventJournalWatermark): CoordinationEventEnvelope<TPayload> {
  const record = requireEventDataObject(value, 'envelope');
  const scopeRecord = requireEventDataObject(readEventDataProperty(record, 'scope'), 'scope');
  const actorRecord = requireEventDataObject(readEventDataProperty(record, 'actor'), 'actor');
  const resourceRevisionValue = readOptionalEventDataProperty(record, 'resourceRevision');

  const event = Object.freeze({
    schemaVersion: readEventDataProperty(record, 'schemaVersion'),
    eventId: readEventDataProperty(record, 'eventId'),
    scope: Object.freeze({
      kind: readEventDataProperty(scopeRecord, 'kind'),
      scopeId: readEventDataProperty(scopeRecord, 'scopeId'),
    }),
    ...copyOptionalEventDataProperty(record, 'workspaceId'),
    ...copyOptionalEventDataProperty(record, 'teamId'),
    ...copyOptionalEventDataProperty(record, 'runId'),
    actor: materializeEventActor(actorRecord),
    eventType: readEventDataProperty(record, 'eventType'),
    ...(resourceRevisionValue === undefined
      ? {}
      : { resourceRevision: materializeResourceRevision(resourceRevisionValue) }),
    emittedAt: readEventDataProperty(record, 'emittedAt'),
    payload: materializeCoordinationJsonPayload(readEventDataProperty(record, 'payload')),
    deploymentId: readEventDataProperty(record, 'deploymentId'),
    eventEpoch: readEventDataProperty(record, 'eventEpoch'),
    eventSequence: readEventDataProperty(record, 'eventSequence'),
    eventCursor: readEventDataProperty(record, 'eventCursor'),
  }) as unknown as CoordinationEventEnvelope<TPayload>;
  const immutableWatermark =
    expectedWatermark === undefined
      ? undefined
      : materializeEventJournalWatermark(expectedWatermark);
  assertCoordinationEventEnvelope(event, immutableWatermark);
  return event;
}

export function materializeCoordinationEventEnvelopes<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(
  value: unknown,
  expectedWatermark: EventJournalWatermark,
  maximumEvents = MAX_DOMAIN_REPLAY_BATCH_SIZE
): readonly CoordinationEventEnvelope<TPayload>[] {
  if (!Array.isArray(value) || value.length > maximumEvents) {
    throw new SnapshotEventHandoffError(
      'invalid_replay_limit',
      'Replay event collection is invalid or exceeds its bound',
      { eventCount: Array.isArray(value) ? value.length : null, maximumEvents }
    );
  }
  const ownPropertySymbols = Object.getOwnPropertySymbols(value);
  const ownPropertyNames = Object.getOwnPropertyNames(value);
  if (ownPropertySymbols.length > 0 || ownPropertyNames.length !== value.length + 1) {
    throw invalidEvent('Replay event collection must contain only dense event indices');
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const events: CoordinationEventEnvelope<TPayload>[] = [];
  for (let index = 0; index < value.length; index += 1) {
    const descriptor = descriptors[String(index)];
    if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
      throw invalidEvent('Replay event collection cannot contain sparse indices or accessors');
    }
    events.push(
      materializeCoordinationEventEnvelope<TPayload>(descriptor.value, expectedWatermark)
    );
  }
  return Object.freeze(events);
}

export interface CreateReplayBatchInput<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly fromCursor: string;
  readonly events: readonly CoordinationEventEnvelope<TPayload>[];
  readonly watermark: EventJournalWatermark;
  readonly maxEvents: number;
  /** Allows a caller to freeze one bounded replay target while newer rows commit. */
  readonly throughSequence?: number;
}

export function createCoordinationReplayBatch<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(input: CreateReplayBatchInput<TPayload>): CoordinationReplayBatch<TPayload> {
  assertReplayLimit(input.maxEvents);
  const watermark = materializeEventJournalWatermark(input.watermark);
  const events = materializeCoordinationEventEnvelopes<TPayload>(
    input.events,
    watermark,
    input.maxEvents
  );
  const from = validateReplayCursor(input.fromCursor, watermark);
  const throughSequence = input.throughSequence ?? watermark.highWatermarkSequence;
  if (
    !Number.isSafeInteger(throughSequence) ||
    throughSequence < from.eventSequence ||
    throughSequence > watermark.highWatermarkSequence
  ) {
    throw new SnapshotEventHandoffError(
      'journal_watermark_mismatch',
      'Replay target is outside the journal watermark',
      {
        fromSequence: from.eventSequence,
        throughSequence,
        highWatermarkSequence: watermark.highWatermarkSequence,
      }
    );
  }

  const expectedCount = Math.min(input.maxEvents, throughSequence - from.eventSequence);
  if (events.length !== expectedCount) {
    throw new SnapshotEventHandoffError(
      'event_sequence_discontinuity',
      'Replay journal did not return the complete requested sequence range',
      {
        fromSequence: from.eventSequence,
        throughSequence,
        maxEvents: input.maxEvents,
        expectedCount,
        actualCount: events.length,
      }
    );
  }

  const seenEventIds = new Set<string>();
  let expectedSequence = from.eventSequence + 1;
  for (const event of events) {
    if (seenEventIds.has(event.eventId)) {
      throw new SnapshotEventHandoffError(
        'duplicate_event',
        'Replay journal returned a duplicate eventId',
        { eventId: event.eventId }
      );
    }
    seenEventIds.add(event.eventId);

    if (
      event.deploymentId !== from.deploymentId ||
      event.eventEpoch !== from.eventEpoch ||
      event.eventSequence !== expectedSequence
    ) {
      throw new SnapshotEventHandoffError(
        'event_sequence_discontinuity',
        'Replay journal event sequence is not contiguous',
        {
          eventId: event.eventId,
          expectedSequence,
          actualSequence: event.eventSequence,
          expectedDeploymentId: from.deploymentId,
          actualDeploymentId: event.deploymentId,
          expectedEventEpoch: from.eventEpoch,
          actualEventEpoch: event.eventEpoch,
        }
      );
    }
    expectedSequence += 1;
  }

  const nextSequence = expectedSequence - 1;
  const nextCursor = encodeReplayCursor({
    deploymentId: from.deploymentId,
    eventEpoch: from.eventEpoch,
    eventSequence: nextSequence,
  });
  return Object.freeze({
    schemaVersion: COORDINATION_EVENT_SCHEMA_VERSION,
    deploymentId: from.deploymentId,
    eventEpoch: from.eventEpoch,
    fromCursor: input.fromCursor as CoordinationReplayBatch<TPayload>['fromCursor'],
    nextCursor,
    events,
    watermark,
    hasMore: nextSequence < watermark.highWatermarkSequence,
  });
}

export interface ReconcileCoordinationReplayResult<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> {
  readonly applicableEvents: readonly CoordinationEventEnvelope<TPayload>[];
  readonly duplicateEventIds: readonly string[];
  readonly revisionVector: readonly CoordinationResourceRevision[];
  readonly state: CoordinationReplayReconciliationState;
}

/**
 * Serializable continuation state makes dedupe, revision continuity, and
 * watermark monotonicity explicit across bounded reconciliation calls.
 */
export interface CoordinationReplayReconciliationState {
  readonly snapshotCursor: string;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  /** Highest journal sequence already reconciled, including duplicates. */
  readonly processedThroughSequence: number;
  readonly nextEventSequence: number;
  readonly revisionVector: readonly CoordinationResourceRevision[];
  /** Oldest-to-newest first-seen IDs in the bounded deterministic dedupe window. */
  readonly processedEventIds: readonly string[];
  readonly watermark: EventJournalWatermark;
}

/**
 * Reconciles the deliberate snapshot/replay overlap by resource generation and
 * revision. Same/older revisions are duplicates; a newer non-contiguous
 * revision fails closed so the caller can replace the projection with a fresh
 * snapshot instead of applying a partial aggregate history.
 */
export function reconcileCoordinationSnapshotReplay<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(input: {
  readonly metadata: CoordinationSnapshotMetadata;
  readonly events: readonly CoordinationEventEnvelope<TPayload>[];
  readonly watermark: EventJournalWatermark;
  readonly previousState?: CoordinationReplayReconciliationState;
}): ReconcileCoordinationReplayResult<TPayload> {
  const metadata = materializeCoordinationSnapshotMetadata(input.metadata);
  assertMaterializedCoordinationSnapshotMetadata(metadata);
  const previousState = input.previousState;
  const previousStateRevisionVector = previousState
    ? materializeRevisionVector(previousState.revisionVector)
    : undefined;
  const snapshotPosition = decodeReplayCursor(metadata.replayCursor);
  const watermark = materializeEventJournalWatermark(input.watermark);
  const events = materializeCoordinationEventEnvelopes<TPayload>(input.events, watermark);
  assertJournalIdentity(metadata, watermark);

  let expectedSequence = snapshotPosition.eventSequence + 1;
  let processedThroughSequence = snapshotPosition.eventSequence;
  let revisionVector = metadata.revisionVector;
  let processedEventIds: readonly string[] = [];
  if (previousState && previousStateRevisionVector) {
    assertReconciliationState(previousState, metadata, previousStateRevisionVector);
    assertJournalWatermarkProgression(previousState.watermark, watermark);
    processedThroughSequence = previousState.processedThroughSequence;
    expectedSequence = previousState.nextEventSequence;
    revisionVector = previousStateRevisionVector;
    processedEventIds = previousState.processedEventIds;
  }
  validateReplayCursor(
    encodeReplayCursor({
      deploymentId: metadata.deploymentId,
      eventEpoch: metadata.eventEpoch,
      eventSequence: expectedSequence - 1,
    }),
    watermark
  );

  const revisions = new Map(
    revisionVector.map((revision) => [revision.resourceKey, Object.freeze({ ...revision })])
  );
  const seenEventIds = new Set(processedEventIds);
  const applicableEvents: CoordinationEventEnvelope<TPayload>[] = [];
  const duplicateEventIds: string[] = [];

  for (const event of events) {
    if (event.deploymentId !== metadata.deploymentId || event.eventEpoch !== metadata.eventEpoch) {
      throw new SnapshotEventHandoffError(
        'event_sequence_discontinuity',
        'Snapshot replay event belongs to a different journal identity',
        {
          eventId: event.eventId,
          expectedDeploymentId: metadata.deploymentId,
          actualDeploymentId: event.deploymentId,
          expectedEventEpoch: metadata.eventEpoch,
          actualEventEpoch: event.eventEpoch,
        }
      );
    }

    const alreadyProcessed = seenEventIds.has(event.eventId);
    if (event.eventSequence <= processedThroughSequence) {
      duplicateEventIds.push(event.eventId);
      continue;
    }
    if (event.eventSequence !== expectedSequence) {
      throw new SnapshotEventHandoffError(
        'event_sequence_discontinuity',
        'Snapshot replay does not begin contiguously after its lower barrier',
        {
          eventId: event.eventId,
          expectedDeploymentId: metadata.deploymentId,
          actualDeploymentId: event.deploymentId,
          expectedEventEpoch: metadata.eventEpoch,
          actualEventEpoch: event.eventEpoch,
          expectedSequence,
          eventSequence: event.eventSequence,
        }
      );
    }
    processedThroughSequence = event.eventSequence;
    expectedSequence += 1;
    if (alreadyProcessed) {
      duplicateEventIds.push(event.eventId);
      continue;
    }
    rememberProcessedEventId(seenEventIds, event.eventId);

    const nextRevision = event.resourceRevision;
    if (!nextRevision) {
      applicableEvents.push(event);
      continue;
    }

    const currentRevision = revisions.get(nextRevision.resourceKey);
    const isOlderRevision =
      currentRevision &&
      (nextRevision.generation < currentRevision.generation ||
        (nextRevision.generation === currentRevision.generation &&
          nextRevision.revision < currentRevision.revision));
    if (isOlderRevision) {
      if (metadata.handoffMode === 'lower_barrier') {
        duplicateEventIds.push(event.eventId);
        continue;
      }
      throw new SnapshotEventHandoffError(
        'resource_revision_regression',
        'Snapshot replay resource revision regressed',
        {
          eventId: event.eventId,
          resourceKey: nextRevision.resourceKey,
          currentGeneration: currentRevision.generation,
          currentRevision: currentRevision.revision,
          eventGeneration: nextRevision.generation,
          eventRevision: nextRevision.revision,
        }
      );
    }
    if (
      currentRevision &&
      nextRevision.generation === currentRevision.generation &&
      nextRevision.revision === currentRevision.revision
    ) {
      duplicateEventIds.push(event.eventId);
      continue;
    }
    if (
      currentRevision &&
      ((nextRevision.generation === currentRevision.generation &&
        nextRevision.revision !== currentRevision.revision + 1) ||
        nextRevision.generation > currentRevision.generation + 1)
    ) {
      throw new SnapshotEventHandoffError(
        'resource_revision_discontinuity',
        'Snapshot replay resource revision is not contiguous',
        {
          eventId: event.eventId,
          resourceKey: nextRevision.resourceKey,
          currentGeneration: currentRevision.generation,
          currentRevision: currentRevision.revision,
          eventGeneration: nextRevision.generation,
          eventRevision: nextRevision.revision,
        }
      );
    }

    if (!currentRevision && revisions.size >= MAX_REVISION_VECTOR_LENGTH) {
      throw new SnapshotEventHandoffError(
        'invalid_snapshot_metadata',
        'Snapshot replay revision vector would exceed its bound',
        {
          eventId: event.eventId,
          resourceKey: nextRevision.resourceKey,
          revisionCount: revisions.size + 1,
          maximumRevisionCount: MAX_REVISION_VECTOR_LENGTH,
        }
      );
    }
    revisions.set(nextRevision.resourceKey, Object.freeze({ ...nextRevision }));
    applicableEvents.push(event);
  }

  const nextRevisionVector = Object.freeze([...revisions.values()]);
  assertRevisionVector(nextRevisionVector);
  const state = Object.freeze({
    snapshotCursor: metadata.replayCursor,
    deploymentId: metadata.deploymentId,
    eventEpoch: metadata.eventEpoch,
    processedThroughSequence,
    nextEventSequence: expectedSequence,
    revisionVector: nextRevisionVector,
    processedEventIds: Object.freeze([...seenEventIds]),
    watermark,
  });
  return Object.freeze({
    applicableEvents: Object.freeze(applicableEvents),
    duplicateEventIds: Object.freeze(duplicateEventIds),
    revisionVector: nextRevisionVector,
    state,
  });
}

export function assertJournalWatermarkProgression(
  previous: EventJournalWatermark,
  current: EventJournalWatermark
): void {
  assertJournalWatermark(previous);
  assertJournalWatermark(current);
  if (
    previous.deploymentId !== current.deploymentId ||
    previous.eventEpoch !== current.eventEpoch
  ) {
    throw new SnapshotEventHandoffError(
      'journal_watermark_mismatch',
      'Event journal identity changed across observations',
      {
        previousDeploymentId: previous.deploymentId,
        currentDeploymentId: current.deploymentId,
        previousEventEpoch: previous.eventEpoch,
        currentEventEpoch: current.eventEpoch,
      }
    );
  }
  if (
    current.retentionFloorSequence < previous.retentionFloorSequence ||
    current.highWatermarkSequence < previous.highWatermarkSequence
  ) {
    throw new SnapshotEventHandoffError(
      'journal_watermark_regression',
      'Event journal watermark regressed across observations',
      {
        previousRetentionFloorSequence: previous.retentionFloorSequence,
        currentRetentionFloorSequence: current.retentionFloorSequence,
        previousHighWatermarkSequence: previous.highWatermarkSequence,
        currentHighWatermarkSequence: current.highWatermarkSequence,
      }
    );
  }
}

export function assertCommittedEventMatchesDraft(
  event: CoordinationEventEnvelope,
  draft: CoordinationEventDraft
): void {
  assertCoordinationEventEnvelope(event);
  assertCoordinationEventDraft(draft);
  const fields = [
    'schemaVersion',
    'eventId',
    'scope',
    'workspaceId',
    'teamId',
    'runId',
    'actor',
    'eventType',
    'resourceRevision',
    'emittedAt',
    'payload',
  ] as const;
  for (const field of fields) {
    if (!sameStructuredValue(event[field], draft[field])) {
      throw new SnapshotEventHandoffError(
        'invalid_coordination_event',
        'Committed coordination event does not match the supplied draft',
        { eventId: draft.eventId, field }
      );
    }
  }
}

export function createCoordinationEventRecoveryPoint(input: {
  readonly participantId: string;
  readonly watermark: EventJournalWatermark;
}): CoordinationEventRecoveryPoint {
  assertIdentifier(input.participantId, 'participantId', 'invalid_recovery_point');
  assertJournalWatermark(input.watermark);
  return Object.freeze({
    schemaVersion: COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION,
    participantId: input.participantId,
    deploymentId: input.watermark.deploymentId,
    eventEpoch: input.watermark.eventEpoch,
    retentionFloorSequence: input.watermark.retentionFloorSequence,
    highWatermarkSequence: input.watermark.highWatermarkSequence,
    replayCursor: encodeReplayCursor({
      deploymentId: input.watermark.deploymentId,
      eventEpoch: input.watermark.eventEpoch,
      eventSequence: input.watermark.highWatermarkSequence,
    }),
  });
}

export function assertCoordinationEventRecoveryPoint(
  recoveryPoint: CoordinationEventRecoveryPoint
): void {
  if (
    !recoveryPoint ||
    recoveryPoint.schemaVersion !== COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION
  ) {
    throw new SnapshotEventHandoffError(
      'unsupported_recovery_point_version',
      'Coordination event recovery-point version is not supported',
      { schemaVersion: recoveryPoint?.schemaVersion }
    );
  }
  assertIdentifier(recoveryPoint.participantId, 'participantId', 'invalid_recovery_point');
  const watermark: EventJournalWatermark = {
    schemaVersion: 1,
    deploymentId: recoveryPoint.deploymentId,
    eventEpoch: recoveryPoint.eventEpoch,
    retentionFloorSequence: recoveryPoint.retentionFloorSequence,
    highWatermarkSequence: recoveryPoint.highWatermarkSequence,
  };
  const position = validateReplayCursor(recoveryPoint.replayCursor, watermark);
  if (position.eventSequence !== recoveryPoint.highWatermarkSequence) {
    throw new SnapshotEventHandoffError(
      'invalid_recovery_point',
      'Coordination event recovery-point cursor does not match its durable barrier',
      {
        cursorSequence: position.eventSequence,
        highWatermarkSequence: recoveryPoint.highWatermarkSequence,
      }
    );
  }
}

function requireEventDataObject(value: unknown, field: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalidEvent(`Coordination event ${field} must be a data object`);
  }
  return value;
}

function readEventDataProperty(record: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw invalidEvent(`Coordination event ${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function readOptionalEventDataProperty(record: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor) {
    return undefined;
  }
  if (!descriptor.enumerable || !('value' in descriptor)) {
    throw invalidEvent(`Coordination event ${field} must be an enumerable data property`);
  }
  return descriptor.value;
}

function copyOptionalEventDataProperty(
  record: object,
  field: string
): Readonly<Record<string, unknown>> {
  const value = readOptionalEventDataProperty(record, field);
  return value === undefined ? {} : { [field]: value };
}

function materializeEventActor(record: object): CoordinationEventDraft['actor'] {
  const kind = readEventDataProperty(record, 'kind');
  switch (kind) {
    case 'operator':
    case 'recovery':
      return Object.freeze({
        kind,
        actorRef: readEventDataProperty(record, 'actorRef'),
      }) as CoordinationEventDraft['actor'];
    case 'verified_runtime':
      return Object.freeze({
        kind,
        actorRef: readEventDataProperty(record, 'actorRef'),
        runId: readEventDataProperty(record, 'runId'),
        ...copyOptionalEventDataProperty(record, 'memberId'),
      }) as CoordinationEventDraft['actor'];
    case 'external_file':
      return Object.freeze({
        kind,
        ...copyOptionalEventDataProperty(record, 'actorRef'),
        fileWriterEpoch: readEventDataProperty(record, 'fileWriterEpoch'),
        observationSequence: readEventDataProperty(record, 'observationSequence'),
      }) as CoordinationEventDraft['actor'];
    default:
      return Object.freeze({ kind }) as CoordinationEventDraft['actor'];
  }
}

function materializeResourceRevision(value: unknown): CoordinationResourceRevision {
  const record = requireEventDataObject(value, 'resourceRevision');
  return Object.freeze({
    resourceKey: readEventDataProperty(record, 'resourceKey'),
    generation: readEventDataProperty(record, 'generation'),
    revision: readEventDataProperty(record, 'revision'),
  }) as unknown as CoordinationResourceRevision;
}

function assertScope(draft: CoordinationEventDraft): void {
  if (!draft.scope || !COORDINATION_EVENT_SCOPE_KINDS.includes(draft.scope.kind)) {
    throw invalidEvent('Coordination event scope kind is invalid', {
      scopeKind: draft.scope?.kind,
    });
  }
  assertIdentifier(draft.scope.scopeId, 'scopeId', 'invalid_coordination_event');
}

function assertScopeReferences(draft: CoordinationEventDraft): void {
  const requiredReference =
    draft.scope.kind === 'workspace'
      ? draft.workspaceId
      : draft.scope.kind === 'team'
        ? draft.teamId
        : draft.scope.kind === 'run'
          ? draft.runId
          : draft.scope.scopeId;
  if (
    (draft.scope.kind === 'workspace' ||
      draft.scope.kind === 'team' ||
      draft.scope.kind === 'run') &&
    requiredReference !== draft.scope.scopeId
  ) {
    throw invalidEvent('Coordination event scope identity does not match its resource reference', {
      scopeKind: draft.scope.kind,
      scopeId: draft.scope.scopeId,
      resourceReference: requiredReference,
    });
  }
}

function assertActor(draft: CoordinationEventDraft): void {
  if (!draft.actor || !COORDINATION_EVENT_ACTOR_KINDS.includes(draft.actor.kind)) {
    throw invalidEvent('Coordination event actor kind is invalid', {
      actorKind: draft.actor?.kind,
    });
  }
  if (draft.actor.kind === 'external_file') {
    assertOptionalIdentity(draft.actor.actorRef, 'actorRef');
    if (
      !Number.isSafeInteger(draft.actor.fileWriterEpoch) ||
      draft.actor.fileWriterEpoch < 0 ||
      !Number.isSafeInteger(draft.actor.observationSequence) ||
      draft.actor.observationSequence < 0
    ) {
      throw invalidEvent(
        'External-file event attribution requires non-negative writer and observation sequences',
        {
          fileWriterEpoch: draft.actor.fileWriterEpoch,
          observationSequence: draft.actor.observationSequence,
        }
      );
    }
    if (draft.runId !== undefined) {
      throw invalidEvent('External-file events cannot claim verified run attribution');
    }
    return;
  }

  assertIdentifier(draft.actor.actorRef, 'actorRef', 'invalid_coordination_event');
  if (draft.actor.kind === 'verified_runtime') {
    assertIdentifier(draft.actor.runId, 'actor.runId', 'invalid_coordination_event');
    assertOptionalIdentity(draft.actor.memberId, 'actor.memberId');
    if (draft.runId !== draft.actor.runId) {
      throw invalidEvent('Verified-runtime event run attribution does not match its runId', {
        eventRunId: draft.runId,
        actorRunId: draft.actor.runId,
      });
    }
  }
}

function assertRevisionVector(vector: readonly CoordinationResourceRevision[]): void {
  if (!Array.isArray(vector) || vector.length > MAX_REVISION_VECTOR_LENGTH) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Snapshot revision vector is invalid or exceeds its bound',
      { revisionCount: Array.isArray(vector) ? vector.length : null }
    );
  }
  const keys = new Set<string>();
  for (const revision of vector) {
    assertResourceRevision(revision, 'invalid_snapshot_metadata');
    if (keys.has(revision.resourceKey)) {
      throw new SnapshotEventHandoffError(
        'invalid_snapshot_metadata',
        'Snapshot revision vector contains a duplicate resource key',
        { resourceKey: revision.resourceKey }
      );
    }
    keys.add(revision.resourceKey);
  }
}

function assertJournalIdentity(
  metadata: CoordinationSnapshotMetadata,
  watermark: EventJournalWatermark
): void {
  if (
    metadata.deploymentId !== watermark.deploymentId ||
    metadata.eventEpoch !== watermark.eventEpoch
  ) {
    throw new SnapshotEventHandoffError(
      'journal_watermark_mismatch',
      'Reconciliation watermark does not match the snapshot journal identity',
      {
        snapshotDeploymentId: metadata.deploymentId,
        watermarkDeploymentId: watermark.deploymentId,
        snapshotEventEpoch: metadata.eventEpoch,
        watermarkEventEpoch: watermark.eventEpoch,
      }
    );
  }
}

function assertReconciliationState(
  state: CoordinationReplayReconciliationState,
  metadata: CoordinationSnapshotMetadata,
  revisionVector: readonly CoordinationResourceRevision[]
): void {
  if (
    !state ||
    state.snapshotCursor !== metadata.replayCursor ||
    state.deploymentId !== metadata.deploymentId ||
    state.eventEpoch !== metadata.eventEpoch
  ) {
    throw new SnapshotEventHandoffError(
      'journal_watermark_mismatch',
      'Replay reconciliation state does not belong to this snapshot'
    );
  }
  assertJournalWatermark(state.watermark);
  const snapshotSequence = decodeReplayCursor(metadata.replayCursor).eventSequence;
  if (
    !Number.isSafeInteger(state.processedThroughSequence) ||
    state.processedThroughSequence < snapshotSequence ||
    state.processedThroughSequence > state.watermark.highWatermarkSequence ||
    !Number.isSafeInteger(state.nextEventSequence) ||
    state.nextEventSequence !== state.processedThroughSequence + 1
  ) {
    throw new SnapshotEventHandoffError(
      'event_sequence_discontinuity',
      'Replay reconciliation continuation floor is invalid',
      {
        snapshotSequence,
        processedThroughSequence: state.processedThroughSequence,
        nextEventSequence: state.nextEventSequence,
        stateHighWatermarkSequence: state.watermark.highWatermarkSequence,
      }
    );
  }
  assertRevisionVector(revisionVector);
  if (
    !Array.isArray(state.processedEventIds) ||
    state.processedEventIds.length > MAX_RECONCILIATION_PROCESSED_EVENT_IDS
  ) {
    throw new SnapshotEventHandoffError(
      'duplicate_event',
      'Replay reconciliation event identity state is invalid or exceeds its window',
      { maximumEventIds: MAX_RECONCILIATION_PROCESSED_EVENT_IDS }
    );
  }
  const eventIds = new Set<string>();
  for (const eventId of state.processedEventIds) {
    assertIdentifier(eventId, 'eventId', 'invalid_coordination_event');
    if (eventIds.has(eventId)) {
      throw new SnapshotEventHandoffError(
        'duplicate_event',
        'Replay reconciliation state contains a duplicate eventId',
        { eventId }
      );
    }
    eventIds.add(eventId);
  }
}

function rememberProcessedEventId(seenEventIds: Set<string>, eventId: string): void {
  seenEventIds.add(eventId);
  if (seenEventIds.size <= MAX_RECONCILIATION_PROCESSED_EVENT_IDS) {
    return;
  }
  const oldestEventId = seenEventIds.values().next().value;
  if (oldestEventId !== undefined) {
    seenEventIds.delete(oldestEventId);
  }
}

function assertResourceRevision(
  revision: CoordinationResourceRevision,
  code: 'invalid_snapshot_metadata' | 'invalid_coordination_event' = 'invalid_coordination_event'
): void {
  if (!revision) {
    throw new SnapshotEventHandoffError(code, 'Coordination resource revision is required');
  }
  assertIdentifier(revision.resourceKey, 'resourceKey', code);
  if (
    !Number.isSafeInteger(revision.generation) ||
    revision.generation < 0 ||
    !Number.isSafeInteger(revision.revision) ||
    revision.revision < 0
  ) {
    throw new SnapshotEventHandoffError(
      code,
      'Coordination resource generation and revision must be non-negative safe integers',
      {
        resourceKey: revision.resourceKey,
        generation: revision.generation,
        revision: revision.revision,
      }
    );
  }
}

function assertReplayLimit(maxEvents: number): void {
  if (
    !Number.isSafeInteger(maxEvents) ||
    maxEvents <= 0 ||
    maxEvents > MAX_DOMAIN_REPLAY_BATCH_SIZE
  ) {
    throw new SnapshotEventHandoffError(
      'invalid_replay_limit',
      'Replay batch limit must be a bounded positive safe integer',
      { maxEvents, maximum: MAX_DOMAIN_REPLAY_BATCH_SIZE }
    );
  }
}

function assertIdentifier(
  value: string,
  field: string,
  code: 'invalid_snapshot_metadata' | 'invalid_coordination_event' | 'invalid_recovery_point',
  maximumLength = MAX_IDENTIFIER_LENGTH
): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximumLength ||
    value.trim() !== value
  ) {
    throw new SnapshotEventHandoffError(code, `Coordination event ${field} is invalid`, { field });
  }
}

function assertOptionalIdentity(value: string | undefined, field: string): void {
  if (value !== undefined) {
    assertIdentifier(value, field, 'invalid_coordination_event');
  }
}

function invalidEvent(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): SnapshotEventHandoffError {
  return new SnapshotEventHandoffError('invalid_coordination_event', message, details);
}

function isRfc3339(value: string): boolean {
  return (
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?Z$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

/**
 * Materializes adapter-owned snapshot data as a fresh accessor-free immutable
 * tree. Only data that can actually be made deeply immutable is admitted:
 * primitives, dense arrays, and plain records. Mutable built-in objects,
 * prototypes, symbols, hidden properties, accessors, and cycles fail closed.
 */
export function materializeCoordinationSnapshotData<TSnapshot>(value: TSnapshot): TSnapshot {
  const ancestors = new Set<object>();
  let materializedNodeCount = 0;

  const invalidSnapshot = (
    message: string,
    details: Readonly<Record<string, unknown>> = {}
  ): SnapshotEventHandoffError =>
    new SnapshotEventHandoffError('invalid_snapshot_data', message, details);

  const materialize = (current: unknown, depth: number): unknown => {
    materializedNodeCount += 1;
    if (materializedNodeCount > MAX_COORDINATION_SNAPSHOT_NODES) {
      throw invalidSnapshot('Coordination snapshot exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_SNAPSHOT_NODES,
      });
    }
    if (depth > MAX_COORDINATION_SNAPSHOT_DEPTH) {
      throw invalidSnapshot('Coordination snapshot exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_SNAPSHOT_DEPTH,
      });
    }
    if (
      current === null ||
      current === undefined ||
      typeof current === 'string' ||
      typeof current === 'boolean' ||
      typeof current === 'number' ||
      typeof current === 'bigint'
    ) {
      return current;
    }
    if (typeof current !== 'object') {
      throw invalidSnapshot('Coordination snapshot must contain only detached data');
    }
    if (ancestors.has(current)) {
      throw invalidSnapshot('Coordination snapshot must be acyclic');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidSnapshot(
        'Coordination snapshot must contain only arrays and plain data objects'
      );
    }

    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        const ownKeys = Reflect.ownKeys(current);
        if (
          ownKeys.length !== current.length + 1 ||
          ownKeys.some(
            (key) => typeof key !== 'string' || (key !== 'length' && !/^(?:0|[1-9]\d*)$/.test(key))
          )
        ) {
          throw invalidSnapshot(
            'Coordination snapshot arrays must contain only dense data indices'
          );
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const result: unknown[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw invalidSnapshot(
              'Coordination snapshot arrays cannot contain sparse indices or accessors'
            );
          }
          result.push(materialize(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const ownKeys = Reflect.ownKeys(current);
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result = Object.create(null) as Record<string, unknown>;
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          throw invalidSnapshot(
            'Coordination snapshot objects cannot contain symbols or hidden properties'
          );
        }
        const descriptor = descriptors[key];
        if (!descriptor?.enumerable) {
          throw invalidSnapshot(
            'Coordination snapshot objects cannot contain symbols or hidden properties'
          );
        }
        if (!('value' in descriptor)) {
          throw invalidSnapshot('Coordination snapshot objects cannot contain accessors');
        }
        Object.defineProperty(result, key, {
          value: materialize(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  return materialize(value, 0) as TSnapshot;
}

/**
 * Copies untrusted payload data into an accessor-free immutable JSON tree
 * before the canonical budget validator observes it. Property descriptors are
 * inspected without invoking getters, so a value cannot change between
 * validation and the durable append.
 */
export function materializeCoordinationJsonPayload(value: unknown): CoordinationJsonValue {
  const ancestors = new Set<object>();
  let materializedNodeCount = 0;

  const materialize = (current: unknown, depth: number): CoordinationJsonValue => {
    materializedNodeCount += 1;
    if (materializedNodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
    if (depth > MAX_COORDINATION_EVENT_PAYLOAD_DEPTH) {
      throw invalidEvent('Coordination event payload exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
      });
    }
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return current;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw invalidEvent('Coordination event payload must be strict JSON');
      }
      return current;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      throw invalidEvent('Coordination event payload must be strict acyclic JSON');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent('Coordination event payload must contain only plain JSON objects');
    }
    ancestors.add(current);
    try {
      if (Array.isArray(current)) {
        if (materializedNodeCount + current.length > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
          throw invalidEvent('Coordination event payload exceeds its total-node budget', {
            maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
          });
        }
        const ownPropertySymbols = Object.getOwnPropertySymbols(current);
        const ownPropertyNames = Object.getOwnPropertyNames(current);
        if (ownPropertySymbols.length > 0 || ownPropertyNames.length !== current.length + 1) {
          throw invalidEvent('Coordination event payload arrays must contain only JSON indices');
        }
        const descriptors = Object.getOwnPropertyDescriptors(current);
        const result: CoordinationJsonValue[] = [];
        for (let index = 0; index < current.length; index += 1) {
          const descriptor = descriptors[String(index)];
          if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
            throw invalidEvent(
              'Coordination event payload cannot contain sparse arrays or accessors'
            );
          }
          result.push(materialize(descriptor.value, depth + 1));
        }
        return Object.freeze(result);
      }

      const ownKeys = Reflect.ownKeys(current);
      if (materializedNodeCount + ownKeys.length > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
        throw invalidEvent('Coordination event payload exceeds its total-node budget', {
          maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
        });
      }
      const descriptors = Object.getOwnPropertyDescriptors(current);
      const result = Object.create(null) as Record<string, CoordinationJsonValue>;
      for (const key of ownKeys) {
        if (typeof key !== 'string') {
          throw invalidEvent(
            'Coordination event payload objects cannot contain symbols or hidden properties'
          );
        }
        const descriptor = descriptors[key];
        if (!descriptor.enumerable) {
          throw invalidEvent(
            'Coordination event payload objects cannot contain symbols or hidden properties'
          );
        }
        if (!('value' in descriptor)) {
          throw invalidEvent('Coordination event payload objects cannot contain accessors');
        }
        Object.defineProperty(result, key, {
          value: materialize(descriptor.value, depth + 1),
          enumerable: true,
          configurable: false,
          writable: false,
        });
      }
      return Object.freeze(result);
    } finally {
      ancestors.delete(current);
    }
  };

  const payload = materialize(value, 0);
  assertCoordinationJsonPayload(payload);
  return payload;
}

function assertCoordinationJsonPayload(value: unknown): asserts value is CoordinationJsonValue {
  type WorkItem =
    | { readonly kind: 'value'; readonly value: unknown; readonly depth: number }
    | { readonly kind: 'leave'; readonly value: object };

  const work: WorkItem[] = [{ kind: 'value', value, depth: 0 }];
  const ancestors = new Set<object>();
  const encoder = new TextEncoder();
  let nodeCount = 0;
  let scheduledNodeCount = 1;
  let byteCount = 0;

  const addBytes = (count: number): void => {
    byteCount += count;
    if (byteCount > MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES) {
      throw invalidEvent('Coordination event payload exceeds its UTF-8 byte budget', {
        maximumBytes: MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
      });
    }
  };
  const addJsonStringBytes = (input: string): void => {
    if (input.length + 2 > MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES - byteCount) {
      throw invalidEvent('Coordination event payload exceeds its UTF-8 byte budget', {
        maximumBytes: MAX_COORDINATION_EVENT_PAYLOAD_UTF8_BYTES,
      });
    }
    addBytes(encoder.encode(JSON.stringify(input)).byteLength);
  };
  const scheduleNodes = (count: number): void => {
    scheduledNodeCount += count;
    if (scheduledNodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
  };

  while (work.length > 0) {
    const item = work.pop()!;
    if (item.kind === 'leave') {
      ancestors.delete(item.value);
      continue;
    }

    nodeCount += 1;
    if (nodeCount > MAX_COORDINATION_EVENT_PAYLOAD_NODES) {
      throw invalidEvent('Coordination event payload exceeds its total-node budget', {
        maximumNodes: MAX_COORDINATION_EVENT_PAYLOAD_NODES,
      });
    }
    if (item.depth > MAX_COORDINATION_EVENT_PAYLOAD_DEPTH) {
      throw invalidEvent('Coordination event payload exceeds its nesting-depth budget', {
        maximumDepth: MAX_COORDINATION_EVENT_PAYLOAD_DEPTH,
      });
    }

    const current = item.value;
    if (current === null) {
      addBytes(4);
      continue;
    }
    if (typeof current === 'string') {
      addJsonStringBytes(current);
      continue;
    }
    if (typeof current === 'boolean') {
      addBytes(current ? 4 : 5);
      continue;
    }
    if (typeof current === 'number') {
      if (!Number.isFinite(current)) {
        throw invalidEvent('Coordination event payload must be strict JSON');
      }
      addBytes(String(Object.is(current, -0) ? 0 : current).length);
      continue;
    }
    if (typeof current !== 'object' || ancestors.has(current)) {
      throw invalidEvent('Coordination event payload must be strict acyclic JSON');
    }

    const prototype = Object.getPrototypeOf(current) as unknown;
    if (!Array.isArray(current) && prototype !== Object.prototype && prototype !== null) {
      throw invalidEvent('Coordination event payload must contain only plain JSON objects');
    }
    ancestors.add(current);
    work.push({ kind: 'leave', value: current });

    if (Array.isArray(current)) {
      addBytes(2 + Math.max(0, current.length - 1));
      scheduleNodes(current.length);
      if (
        Object.getOwnPropertySymbols(current).length > 0 ||
        Object.getOwnPropertyNames(current).length !== current.length + 1
      ) {
        throw invalidEvent('Coordination event payload arrays must contain only JSON indices');
      }
      for (let index = current.length - 1; index >= 0; index -= 1) {
        if (!(index in current)) {
          throw invalidEvent('Coordination event payload cannot contain sparse arrays');
        }
        work.push({ kind: 'value', value: current[index], depth: item.depth + 1 });
      }
      continue;
    }

    const record = current as Readonly<Record<string, unknown>>;
    const keys = Object.keys(record);
    addBytes(2 + Math.max(0, keys.length - 1) + keys.length);
    scheduleNodes(keys.length);
    if (Reflect.ownKeys(record).length !== keys.length) {
      throw invalidEvent(
        'Coordination event payload objects cannot contain symbols or hidden properties'
      );
    }
    for (let index = keys.length - 1; index >= 0; index -= 1) {
      const key = keys[index];
      addJsonStringBytes(key);
      work.push({ kind: 'value', value: record[key], depth: item.depth + 1 });
    }
  }
}

function sameStructuredValue(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) {
    return true;
  }
  if (typeof left !== 'object' || left === null || typeof right !== 'object' || right === null) {
    return false;
  }
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => sameStructuredValue(item, right[index]))
    );
  }
  const leftRecord = left as Readonly<Record<string, unknown>>;
  const rightRecord = right as Readonly<Record<string, unknown>>;
  const leftKeys = Object.keys(leftRecord).sort();
  const rightKeys = Object.keys(rightRecord).sort();
  return (
    leftKeys.length === rightKeys.length &&
    leftKeys.every(
      (key, index) =>
        key === rightKeys[index] && sameStructuredValue(leftRecord[key], rightRecord[key])
    )
  );
}

function materializeRevisionVector(
  vector: readonly CoordinationResourceRevision[]
): readonly CoordinationResourceRevision[] {
  if (!Array.isArray(vector)) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Snapshot revision vector is invalid or exceeds its bound',
      { revisionCount: null }
    );
  }
  const revisionCount = vector.length;
  if (
    !Number.isSafeInteger(revisionCount) ||
    revisionCount < 0 ||
    revisionCount > MAX_REVISION_VECTOR_LENGTH
  ) {
    throw new SnapshotEventHandoffError(
      'invalid_snapshot_metadata',
      'Snapshot revision vector is invalid or exceeds its bound',
      { revisionCount }
    );
  }

  const materialized: CoordinationResourceRevision[] = [];
  for (let index = 0; index < revisionCount; index += 1) {
    const revision = vector[index];
    if (!revision || typeof revision !== 'object') {
      throw new SnapshotEventHandoffError(
        'invalid_snapshot_metadata',
        'Coordination resource revision is required',
        { revisionIndex: index }
      );
    }
    const resourceKey = revision.resourceKey;
    const generation = revision.generation;
    const revisionNumber = revision.revision;
    materialized.push(Object.freeze({ resourceKey, generation, revision: revisionNumber }));
  }
  return Object.freeze(materialized);
}
