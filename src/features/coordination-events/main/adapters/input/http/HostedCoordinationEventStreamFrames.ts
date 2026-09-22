import {
  type CoordinationEventEnvelope,
  HOSTED_COORDINATION_EVENT_SSE_EVENT,
  HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
  HOSTED_COORDINATION_RESYNC_SSE_EVENT,
  type HostedCoordinationEventEnvelope,
  type HostedCoordinationEventProjection,
  type HostedCoordinationResyncReason,
  type HostedCoordinationResyncRequired,
  type ReplayCursor,
} from '../../../../contracts';

import { boundedCursor } from './HostedCoordinationEventStreamRequestSupport';

const MAX_IDENTIFIER_LENGTH = 256;
const UTF8_ENCODER = new TextEncoder();

function validIdentifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !value.includes('\r') &&
    !value.includes('\n')
  );
}

export function materializeProjectedEnvelope(input: {
  readonly event: CoordinationEventEnvelope;
  readonly projection: HostedCoordinationEventProjection;
  readonly previousEventCursor: ReplayCursor;
  readonly maxFrameBytes: number;
}): { readonly envelope: HostedCoordinationEventEnvelope; readonly data: string } | null {
  const { event, projection } = input;
  if (
    !validIdentifier(event.deploymentId) ||
    !validIdentifier(event.eventEpoch) ||
    !validIdentifier(event.eventId) ||
    !boundedCursor(event.eventCursor) ||
    !Number.isSafeInteger(event.eventSequence) ||
    event.eventSequence < 0 ||
    !event.scope ||
    !validIdentifier(event.scope.scopeId) ||
    !validIdentifier(projection.eventType) ||
    !projection.scope ||
    !validIdentifier(projection.scope.scopeId) ||
    projection.publicPayload === undefined ||
    projection.scope.kind !== event.scope.kind ||
    projection.scope.scopeId !== event.scope.scopeId
  ) {
    return null;
  }
  const envelope: HostedCoordinationEventEnvelope = Object.freeze({
    schemaVersion: HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
    kind: HOSTED_COORDINATION_EVENT_SSE_EVENT,
    deploymentId: event.deploymentId,
    eventEpoch: event.eventEpoch,
    eventSequence: event.eventSequence,
    eventId: event.eventId,
    previousEventCursor: input.previousEventCursor,
    eventCursor: event.eventCursor,
    scope: Object.freeze({ ...projection.scope }),
    eventType: projection.eventType,
    ...(projection.resourceRevision === undefined
      ? {}
      : { resourceRevision: Object.freeze({ ...projection.resourceRevision }) }),
    emittedAt: event.emittedAt,
    payload: projection.publicPayload,
  });
  let data: string;
  try {
    data = JSON.stringify(envelope);
  } catch {
    return null;
  }
  if (UTF8_ENCODER.encode(data).byteLength > input.maxFrameBytes) return null;
  return Object.freeze({ envelope, data });
}

export function eventFrame(cursor: ReplayCursor, data: string): string {
  return `id: ${cursor}\nevent: ${HOSTED_COORDINATION_EVENT_SSE_EVENT}\ndata: ${data}\n\n`;
}

export function resyncFrame(reason: HostedCoordinationResyncReason): string {
  const message: HostedCoordinationResyncRequired = Object.freeze({
    schemaVersion: HOSTED_COORDINATION_EVENT_STREAM_SCHEMA_VERSION,
    kind: HOSTED_COORDINATION_RESYNC_SSE_EVENT,
    reason,
  });
  return `event: ${HOSTED_COORDINATION_RESYNC_SSE_EVENT}\ndata: ${JSON.stringify(message)}\n\n`;
}
