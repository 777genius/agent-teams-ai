import {
  isRuntimeControlProviderId,
  type RuntimeControlProviderId,
} from './RuntimeControlProvider';

declare const runtimeControlCommandIdBrand: unique symbol;
declare const runtimeControlEventIdBrand: unique symbol;
declare const runtimeControlStringKindBrand: unique symbol;

export type RuntimeControlCommandId = string & {
  readonly [runtimeControlCommandIdBrand]: true;
};
export type RuntimeControlEventId = string & { readonly [runtimeControlEventIdBrand]: true };
export type RuntimeControlTeamName = string & {
  readonly [runtimeControlStringKindBrand]?: 'teamName';
};
export type RuntimeControlRunId = string & {
  readonly [runtimeControlStringKindBrand]?: 'runId';
};
export type RuntimeControlLaneId = string & {
  readonly [runtimeControlStringKindBrand]?: 'laneId';
};
export type RuntimeControlMemberName = string & {
  readonly [runtimeControlStringKindBrand]?: 'memberName';
};
export type RuntimeControlRuntimeSessionId = string & {
  readonly [runtimeControlStringKindBrand]?: 'runtimeSessionId';
};
export type RuntimeControlIdempotencyKey = string & {
  readonly [runtimeControlStringKindBrand]?: 'idempotencyKey';
};

export interface RuntimeControlCommandIdPartsInput {
  providerId: RuntimeControlProviderId;
  verb: string;
  teamName: RuntimeControlTeamName;
  laneId: RuntimeControlLaneId;
  runId: RuntimeControlRunId;
  parts?: readonly string[];
}

export interface RuntimeBootstrapCheckinCommandIdInput {
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  laneId: RuntimeControlLaneId;
  runId: RuntimeControlRunId;
  memberName: RuntimeControlMemberName;
  runtimeSessionId: RuntimeControlRuntimeSessionId;
}

export interface RuntimeHeartbeatCommandIdInput extends RuntimeBootstrapCheckinCommandIdInput {
  observedAt: string;
}

export interface RuntimeTaskEventCommandIdInput {
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  laneId: RuntimeControlLaneId;
  runId: RuntimeControlRunId;
  idempotencyKey: RuntimeControlIdempotencyKey;
}

export interface RuntimeDeliverMessageCommandIdInput {
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  laneId: RuntimeControlLaneId;
  runId: RuntimeControlRunId;
  idempotencyKey: RuntimeControlIdempotencyKey;
}

export interface RuntimePermissionAnswerCommandIdInput {
  providerId: RuntimeControlProviderId;
  teamName: RuntimeControlTeamName;
  laneId: RuntimeControlLaneId;
  runId: RuntimeControlRunId;
  requestId: string;
  decision: string;
}

export interface RuntimeControlEventIdInput {
  providerId: RuntimeControlProviderId;
  eventType: string;
  commandId: RuntimeControlCommandId;
  occurredAt: string;
}

export interface RuntimeControlCommandEventIdInput {
  providerId: RuntimeControlProviderId;
  eventType: string;
  commandId: RuntimeControlCommandId;
}

export function createRuntimeControlCommandId(value: string): RuntimeControlCommandId {
  return normalizeRuntimeControlId(value, 'commandId') as RuntimeControlCommandId;
}

export function createRuntimeControlEventId(value: string): RuntimeControlEventId {
  return normalizeRuntimeControlId(value, 'eventId') as RuntimeControlEventId;
}

export function buildRuntimeControlCommandId(
  input: RuntimeControlCommandIdPartsInput
): RuntimeControlCommandId {
  assertRuntimeControlProviderId(input.providerId);
  return createRuntimeControlCommandId(
    [
      input.providerId,
      normalizeRuntimeControlIdPart(input.verb, 'verb'),
      normalizeRuntimeControlIdPart(input.teamName, 'teamName'),
      normalizeRuntimeControlIdPart(input.laneId, 'laneId'),
      normalizeRuntimeControlIdPart(input.runId, 'runId'),
      ...(input.parts ?? []).map((part, index) =>
        normalizeRuntimeControlIdPart(part, `parts[${index}]`)
      ),
    ].join(':')
  );
}

export function buildRuntimeBootstrapCheckinCommandId(
  input: RuntimeBootstrapCheckinCommandIdInput
): RuntimeControlCommandId {
  return buildRuntimeControlCommandId({
    ...input,
    verb: 'bootstrap-checkin',
    parts: [input.memberName, input.runtimeSessionId],
  });
}

export function buildRuntimeHeartbeatCommandId(
  input: RuntimeHeartbeatCommandIdInput
): RuntimeControlCommandId {
  return buildRuntimeControlCommandId({
    ...input,
    verb: 'heartbeat',
    parts: [input.memberName, input.runtimeSessionId, input.observedAt],
  });
}

export function buildRuntimeTaskEventCommandId(
  input: RuntimeTaskEventCommandIdInput
): RuntimeControlCommandId {
  return buildRuntimeControlCommandId({
    ...input,
    verb: 'task-event',
    parts: [input.idempotencyKey],
  });
}

export function buildRuntimeDeliverMessageCommandId(
  input: RuntimeDeliverMessageCommandIdInput
): RuntimeControlCommandId {
  return buildRuntimeControlCommandId({
    ...input,
    verb: 'deliver-message',
    parts: [input.idempotencyKey],
  });
}

export function buildRuntimePermissionAnswerCommandId(
  input: RuntimePermissionAnswerCommandIdInput
): RuntimeControlCommandId {
  return buildRuntimeControlCommandId({
    ...input,
    verb: 'permission-answer',
    parts: [input.requestId, input.decision],
  });
}

export function buildRuntimeControlEventId(
  input: RuntimeControlEventIdInput
): RuntimeControlEventId {
  assertRuntimeControlProviderId(input.providerId);
  return createRuntimeControlEventId(
    [
      input.providerId,
      normalizeRuntimeControlIdPart(input.eventType, 'eventType'),
      normalizeRuntimeControlIdPart(input.commandId, 'commandId'),
      normalizeRuntimeControlIdPart(input.occurredAt, 'occurredAt'),
    ].join(':')
  );
}

export function buildRuntimeControlCommandEventId(
  input: RuntimeControlCommandEventIdInput
): RuntimeControlEventId {
  assertRuntimeControlProviderId(input.providerId);
  return createRuntimeControlEventId(
    [
      input.providerId,
      normalizeRuntimeControlIdPart(input.eventType, 'eventType'),
      normalizeRuntimeControlIdPart(input.commandId, 'commandId'),
    ].join(':')
  );
}

export function normalizeRuntimeControlIdPart(value: string, fieldName: string): string {
  return encodeURIComponent(normalizeRuntimeControlId(value, fieldName));
}

function normalizeRuntimeControlId(value: string, fieldName: string): string {
  const trimmed = value.trim();
  if (!trimmed) {
    throw new Error(`Runtime control id missing ${fieldName}`);
  }
  return trimmed;
}

function assertRuntimeControlProviderId(providerId: RuntimeControlProviderId): void {
  if (!isRuntimeControlProviderId(providerId)) {
    throw new Error(`Invalid runtime control provider: ${String(providerId)}`);
  }
}
