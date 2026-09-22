import {
  COORDINATION_SNAPSHOT_SCHEMA_VERSION,
  type CoordinationJsonValue,
  type CoordinationResourceRevision,
  type CoordinationSnapshotEnvelope,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationResyncReason,
  type ReplayCursor,
  SNAPSHOT_EVENT_HANDOFF_MODES,
  type SnapshotEventHandoffMode,
} from '../../contracts';

const DEFAULT_PROCESSED_EVENT_WINDOW = 2_048;
const MAX_PROCESSED_EVENT_WINDOW = 10_000;
const MAX_REVISION_VECTOR_LENGTH = 10_000;
const MAX_IDENTIFIER_LENGTH = 256;
const MAX_CURSOR_LENGTH = 2_048;

export interface HostedCoordinationEventReconciliationState {
  /** Fences async work belonging to a prior login or selection. */
  readonly generation: number;
  readonly deploymentId: string;
  readonly eventEpoch: string;
  readonly handoffMode: SnapshotEventHandoffMode;
  readonly cursor: ReplayCursor;
  readonly lastEventSequence: number | null;
  readonly revisionVector: readonly CoordinationResourceRevision[];
  readonly processedEvents: readonly {
    readonly eventId: string;
    readonly eventCursor: ReplayCursor;
  }[];
}

export type HostedCoordinationEventReconcileResult<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
> =
  | {
      readonly kind: 'applied';
      readonly state: HostedCoordinationEventReconciliationState;
      readonly event: HostedCoordinationEventEnvelope<TPayload>;
    }
  | {
      readonly kind: 'duplicate';
      readonly state: HostedCoordinationEventReconciliationState;
    }
  | {
      readonly kind: 'resync_required';
      readonly state: HostedCoordinationEventReconciliationState;
      readonly reason: HostedCoordinationResyncReason;
    }
  | {
      readonly kind: 'stale_generation';
      readonly state: HostedCoordinationEventReconciliationState;
    };

export interface HostedCoordinationEventReconcilerOptions {
  readonly processedEventWindow?: number;
}

function validIdentity(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function validCursor(value: unknown): value is ReplayCursor {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_CURSOR_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

function validSequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function materializeRevisionVector(
  value: readonly CoordinationResourceRevision[]
): readonly CoordinationResourceRevision[] {
  if (!Array.isArray(value) || value.length > MAX_REVISION_VECTOR_LENGTH) {
    throw new Error('invalid_hosted_coordination_snapshot_revision_vector');
  }
  const seen = new Set<string>();
  const revisions = value.map((revision) => {
    if (
      !revision ||
      !validIdentity(revision.resourceKey) ||
      !validSequence(revision.generation) ||
      !validSequence(revision.revision) ||
      seen.has(revision.resourceKey)
    ) {
      throw new Error('invalid_hosted_coordination_snapshot_revision_vector');
    }
    seen.add(revision.resourceKey);
    return Object.freeze({
      resourceKey: revision.resourceKey,
      generation: revision.generation,
      revision: revision.revision,
    });
  });
  return Object.freeze(revisions);
}

function rememberBoundedEvent(
  values: HostedCoordinationEventReconciliationState['processedEvents'],
  event: HostedCoordinationEventEnvelope,
  maximum: number
): HostedCoordinationEventReconciliationState['processedEvents'] {
  const next = [
    ...values,
    Object.freeze({ eventId: event.eventId, eventCursor: event.eventCursor }),
  ];
  if (next.length > maximum) next.splice(0, next.length - maximum);
  return Object.freeze(next);
}

function replacementRevisionVector(
  state: HostedCoordinationEventReconciliationState,
  revision: CoordinationResourceRevision | undefined
): readonly CoordinationResourceRevision[] | null {
  if (!revision) return state.revisionVector;
  if (
    !validIdentity(revision.resourceKey) ||
    !validSequence(revision.generation) ||
    !validSequence(revision.revision)
  ) {
    return null;
  }
  const currentIndex = state.revisionVector.findIndex(
    ({ resourceKey }) => resourceKey === revision.resourceKey
  );
  if (currentIndex === -1) {
    if (state.revisionVector.length >= MAX_REVISION_VECTOR_LENGTH) return null;
    return Object.freeze([...state.revisionVector, Object.freeze({ ...revision })]);
  }
  const next = [...state.revisionVector];
  next[currentIndex] = Object.freeze({ ...revision });
  return Object.freeze(next);
}

function advanceState(
  state: HostedCoordinationEventReconciliationState,
  event: HostedCoordinationEventEnvelope,
  processedEventWindow: number,
  revisionVector = state.revisionVector
): HostedCoordinationEventReconciliationState {
  return Object.freeze({
    ...state,
    cursor: event.eventCursor,
    lastEventSequence: event.eventSequence,
    revisionVector,
    processedEvents: rememberBoundedEvent(state.processedEvents, event, processedEventWindow),
  });
}

function resync<TPayload extends CoordinationJsonValue>(
  state: HostedCoordinationEventReconciliationState,
  reason: HostedCoordinationResyncReason
): HostedCoordinationEventReconcileResult<TPayload> {
  return Object.freeze({ kind: 'resync_required', state, reason });
}

/**
 * Pure protocol reconciliation. The class owns no mutable stream state, so a
 * result depends only on the snapshot/event inputs and configured window.
 */
export class HostedCoordinationEventReconciler {
  private readonly processedEventWindow: number;

  constructor(options: HostedCoordinationEventReconcilerOptions = {}) {
    const processedEventWindow = options.processedEventWindow ?? DEFAULT_PROCESSED_EVENT_WINDOW;
    if (
      !Number.isSafeInteger(processedEventWindow) ||
      processedEventWindow <= 0 ||
      processedEventWindow > MAX_PROCESSED_EVENT_WINDOW
    ) {
      throw new Error('invalid_hosted_coordination_event_reconciler_options');
    }
    this.processedEventWindow = processedEventWindow;
  }

  fromSnapshot<TSnapshot>(input: {
    readonly snapshot: CoordinationSnapshotEnvelope<TSnapshot>;
    readonly generation: number;
  }): HostedCoordinationEventReconciliationState {
    const metadata = input.snapshot?.metadata;
    if (
      !metadata ||
      metadata.schemaVersion !== COORDINATION_SNAPSHOT_SCHEMA_VERSION ||
      !validSequence(input.generation) ||
      !validIdentity(metadata.deploymentId) ||
      !validIdentity(metadata.eventEpoch) ||
      !SNAPSHOT_EVENT_HANDOFF_MODES.includes(metadata.handoffMode) ||
      !validCursor(metadata.replayCursor)
    ) {
      throw new Error('invalid_hosted_coordination_snapshot');
    }
    return Object.freeze({
      generation: input.generation,
      deploymentId: metadata.deploymentId,
      eventEpoch: metadata.eventEpoch,
      handoffMode: metadata.handoffMode,
      cursor: metadata.replayCursor,
      lastEventSequence: null,
      revisionVector: materializeRevisionVector(metadata.revisionVector),
      processedEvents: Object.freeze([]),
    });
  }

  reconcile<TPayload extends CoordinationJsonValue = CoordinationJsonValue>(input: {
    readonly state: HostedCoordinationEventReconciliationState;
    readonly event: HostedCoordinationEventEnvelope<TPayload>;
    readonly generation: number;
  }): HostedCoordinationEventReconcileResult<TPayload> {
    const { state, event } = input;
    if (input.generation !== state.generation) {
      return Object.freeze({ kind: 'stale_generation', state });
    }
    if (event.deploymentId !== state.deploymentId) return resync(state, 'foreign_deployment');
    if (event.eventEpoch !== state.eventEpoch) return resync(state, 'foreign_epoch');
    if (
      !validSequence(event.eventSequence) ||
      !validIdentity(event.eventId) ||
      !validCursor(event.previousEventCursor) ||
      !validCursor(event.eventCursor)
    ) {
      return resync(state, 'projection_invalid');
    }

    const hasExactEvent = state.processedEvents.some(
      (processed) =>
        processed.eventId === event.eventId && processed.eventCursor === event.eventCursor
    );
    const hasEventId = state.processedEvents.some(
      (processed) => processed.eventId === event.eventId
    );
    const hasEventCursor = state.processedEvents.some(
      (processed) => processed.eventCursor === event.eventCursor
    );
    if (hasEventId || hasEventCursor) {
      return hasExactEvent
        ? Object.freeze({ kind: 'duplicate', state })
        : resync(state, 'event_gap');
    }
    if (event.eventCursor === state.cursor) {
      return Object.freeze({ kind: 'duplicate', state });
    }
    if (
      event.previousEventCursor !== state.cursor ||
      (state.lastEventSequence !== null && event.eventSequence <= state.lastEventSequence)
    ) {
      return resync(state, 'event_gap');
    }

    const nextRevision = event.resourceRevision;
    if (nextRevision) {
      if (
        !validIdentity(nextRevision.resourceKey) ||
        !validSequence(nextRevision.generation) ||
        !validSequence(nextRevision.revision)
      ) {
        return resync(state, 'projection_invalid');
      }
      const currentRevision = state.revisionVector.find(
        ({ resourceKey }) => resourceKey === nextRevision.resourceKey
      );
      if (currentRevision) {
        const older =
          nextRevision.generation < currentRevision.generation ||
          (nextRevision.generation === currentRevision.generation &&
            nextRevision.revision < currentRevision.revision);
        const equal =
          nextRevision.generation === currentRevision.generation &&
          nextRevision.revision === currentRevision.revision;
        if (older && state.handoffMode !== 'lower_barrier') return resync(state, 'event_gap');
        if (older || equal) {
          return Object.freeze({
            kind: 'duplicate',
            state: advanceState(state, event, this.processedEventWindow),
          });
        }
        if (
          (nextRevision.generation === currentRevision.generation &&
            nextRevision.revision !== currentRevision.revision + 1) ||
          nextRevision.generation > currentRevision.generation + 1
        ) {
          return resync(state, 'event_gap');
        }
      }
    }

    const revisionVector = replacementRevisionVector(state, nextRevision);
    if (revisionVector === null) return resync(state, 'event_gap');
    const nextState = advanceState(state, event, this.processedEventWindow, revisionVector);
    return Object.freeze({ kind: 'applied', state: nextState, event });
  }
}
