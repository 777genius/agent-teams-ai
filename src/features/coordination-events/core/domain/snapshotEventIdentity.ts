import {
  COORDINATION_EVENT_ACTOR_KINDS,
  COORDINATION_EVENT_SCHEMA_VERSION,
  COORDINATION_EVENT_SCOPE_KINDS,
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationJsonValue,
  type CoordinationResourceRevision,
  type CoordinationSnapshotMetadata,
  type EventJournalWatermark,
  SNAPSHOT_EVENT_HANDOFF_MODES,
  type SnapshotEventHandoffMode,
} from '../../contracts';

import {
  assertCoordinationJsonPayload,
  materializeCoordinationJsonPayload,
} from './coordinationJson';
import {
  assertJournalWatermark,
  decodeReplayCursor,
  encodeReplayCursor,
  materializeEventJournalWatermark,
  validateReplayCursor,
} from './replayCursor';
import {
  MAX_DOMAIN_REPLAY_BATCH_SIZE,
  MAX_EVENT_TYPE_LENGTH,
  MAX_IDENTIFIER_LENGTH,
  MAX_RECONCILIATION_PROCESSED_EVENT_IDS,
  MAX_REVISION_VECTOR_LENGTH,
  SnapshotEventHandoffError,
} from './snapshotEventLimits';

import type { CoordinationReplayReconciliationState } from './snapshotReplay';

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

export function materializeCoordinationSnapshotMetadata(
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

export function assertMaterializedCoordinationSnapshotMetadata(
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
  if (draft?.schemaVersion !== COORDINATION_EVENT_SCHEMA_VERSION) {
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

export function assertRevisionVector(vector: readonly CoordinationResourceRevision[]): void {
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

export function assertJournalIdentity(
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

export function assertReconciliationState(
  state: CoordinationReplayReconciliationState,
  metadata: CoordinationSnapshotMetadata,
  revisionVector: readonly CoordinationResourceRevision[]
): void {
  if (
    state?.snapshotCursor !== metadata.replayCursor ||
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

export function rememberProcessedEventId(seenEventIds: Set<string>, eventId: string): void {
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

export function assertReplayLimit(maxEvents: number): void {
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

export function assertIdentifier(
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

export function materializeRevisionVector(
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
