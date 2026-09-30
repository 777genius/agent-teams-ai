import {
  COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION,
  COORDINATION_EVENT_SCHEMA_VERSION,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationEventRecoveryPoint,
  type CoordinationJsonValue,
  type CoordinationReplayBatch,
  type CoordinationResourceRevision,
  type CoordinationSnapshotMetadata,
  type EventJournalWatermark,
} from '../../contracts';

import { sameStructuredValue } from './coordinationJson';
import {
  assertJournalWatermark,
  decodeReplayCursor,
  encodeReplayCursor,
  materializeEventJournalWatermark,
  validateReplayCursor,
} from './replayCursor';
import {
  assertCoordinationEventDraft,
  assertCoordinationEventEnvelope,
  assertIdentifier,
  assertJournalIdentity,
  assertMaterializedCoordinationSnapshotMetadata,
  assertReconciliationState,
  assertReplayLimit,
  assertRevisionVector,
  materializeCoordinationEventEnvelopes,
  materializeCoordinationSnapshotMetadata,
  materializeRevisionVector,
  rememberProcessedEventId,
} from './snapshotEventIdentity';
import { MAX_REVISION_VECTOR_LENGTH, SnapshotEventHandoffError } from './snapshotEventLimits';

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
      nextRevision.generation === currentRevision?.generation &&
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
  if (recoveryPoint?.schemaVersion !== COORDINATION_EVENT_RECOVERY_POINT_SCHEMA_VERSION) {
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
