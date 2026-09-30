import {
  COORDINATION_EVENT_SCOPE_KINDS,
  type CoordinationEventActor,
  type CoordinationEventDraft,
  type CoordinationEventEnvelope,
  type CoordinationJsonValue,
  type EventJournalWatermark,
} from '../../contracts';
import {
  encodeReplayCursor,
  materializeCoordinationEventDraft,
  materializeCoordinationEventEnvelope,
  materializeCoordinationEventEnvelopes,
  materializeCoordinationJsonPayload,
  materializeEventJournalWatermark,
} from '../domain';

import { CoordinationEventHandoffError } from './coordinationEventHandoffError';

import type {
  CoordinationSnapshotRequest,
  PublishCoordinationEventCommand,
  TrustedCoordinationEventContext,
} from './ports';

export function bindTrustedEventAttribution<TPayload extends CoordinationJsonValue>(
  command: PublishCoordinationEventCommand<TPayload>
): CoordinationEventDraft<TPayload> {
  if (!command?.trustedContext || !command.draft) {
    throw invalidOptions('Trusted event context and publish draft are required');
  }
  const context: TrustedCoordinationEventContext = command.trustedContext;
  const draft = command.draft;
  const payload = materializeCoordinationJsonPayload(draft.payload) as TPayload;
  return materializeCoordinationEventDraft<TPayload>({
    schemaVersion: draft.schemaVersion,
    eventId: draft.eventId,
    scope: draft.scope,
    workspaceId: draft.workspaceId,
    teamId: draft.teamId,
    ...(context.runId === undefined ? {} : { runId: context.runId }),
    actor: bindTrustedActor(context.actor),
    eventType: draft.eventType,
    resourceRevision: draft.resourceRevision,
    emittedAt: draft.emittedAt,
    payload,
  });
}

function bindTrustedActor(actor: CoordinationEventActor): CoordinationEventActor {
  switch (actor?.kind) {
    case 'operator':
    case 'recovery':
      return Object.freeze({ kind: actor.kind, actorRef: actor.actorRef });
    case 'verified_runtime':
      return Object.freeze({
        kind: actor.kind,
        actorRef: actor.actorRef,
        runId: actor.runId,
        ...(actor.memberId === undefined ? {} : { memberId: actor.memberId }),
      });
    case 'external_file':
      return Object.freeze({
        kind: actor.kind,
        ...(actor.actorRef === undefined ? {} : { actorRef: actor.actorRef }),
        fileWriterEpoch: actor.fileWriterEpoch,
        observationSequence: actor.observationSequence,
      });
    default:
      throw invalidOptions('Trusted event actor kind is invalid');
  }
}

export function encodePosition(watermark: EventJournalWatermark, eventSequence: number): string {
  return encodeReplayCursor({
    deploymentId: watermark.deploymentId,
    eventEpoch: watermark.eventEpoch,
    eventSequence,
  });
}

export function assertSnapshotRequest(request: CoordinationSnapshotRequest): void {
  if (!request || !COORDINATION_EVENT_SCOPE_KINDS.includes(request.scopeKind)) {
    throw invalidOptions('Coordination snapshot scope kind is invalid');
  }
  assertIdentifier(request.scopeId, 'scopeId');
}

export function assertSameJournalIdentity(
  expected: EventJournalWatermark,
  actual: EventJournalWatermark
): void {
  if (expected.deploymentId !== actual.deploymentId || expected.eventEpoch !== actual.eventEpoch) {
    throw journalProtocolError('Event journal identity changed during one handoff operation', {
      expectedDeploymentId: expected.deploymentId,
      actualDeploymentId: actual.deploymentId,
      expectedEventEpoch: expected.eventEpoch,
      actualEventEpoch: actual.eventEpoch,
    });
  }
}

export function assertBoundedPositiveInteger(value: number, field: string, maximum: number): void {
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw invalidOptions(`${field} must be a bounded positive safe integer`, {
      field,
      value,
      maximum,
    });
  }
}

export function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 256 ||
    value.trim() !== value
  ) {
    throw invalidOptions(`${field} must be a bounded non-empty string`, { field });
  }
}

export function materializeJournalReplayRead<
  TPayload extends CoordinationJsonValue = CoordinationJsonValue,
>(
  value: unknown,
  maximumEvents: number
): {
  readonly events: readonly CoordinationEventEnvelope<TPayload>[];
  readonly watermark: EventJournalWatermark;
} {
  const record = requireJournalDataObject(value, 'replay read');
  const watermark = materializeEventJournalWatermark(readJournalDataProperty(record, 'watermark'));
  return Object.freeze({
    events: materializeCoordinationEventEnvelopes<TPayload>(
      readJournalDataProperty(record, 'events'),
      watermark,
      maximumEvents
    ),
    watermark,
  });
}

export function materializeCommittedEventAppend<TPayload extends CoordinationJsonValue>(
  value: unknown
): {
  readonly event: CoordinationEventEnvelope<TPayload>;
  readonly watermark: EventJournalWatermark;
} {
  const record = requireJournalDataObject(value, 'committed append');
  const watermark = materializeEventJournalWatermark(readJournalDataProperty(record, 'watermark'));
  return Object.freeze({
    event: materializeCoordinationEventEnvelope<TPayload>(
      readJournalDataProperty(record, 'event'),
      watermark
    ),
    watermark,
  });
}

function requireJournalDataObject(value: unknown, boundary: string): object {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw journalProtocolError(`Event journal ${boundary} must be a data object`);
  }
  return value;
}

function readJournalDataProperty(record: object, field: string): unknown {
  const descriptor = Object.getOwnPropertyDescriptor(record, field);
  if (!descriptor || !descriptor.enumerable || !('value' in descriptor)) {
    throw journalProtocolError(
      `Event journal ${field} must be returned as an enumerable data property`
    );
  }
  return descriptor.value;
}

export function invalidOptions(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): CoordinationEventHandoffError {
  return new CoordinationEventHandoffError('invalid_handoff_options', message, details);
}

export function journalProtocolError(
  message: string,
  details: Readonly<Record<string, unknown>> = {}
): CoordinationEventHandoffError {
  return new CoordinationEventHandoffError('journal_protocol_error', message, details);
}
