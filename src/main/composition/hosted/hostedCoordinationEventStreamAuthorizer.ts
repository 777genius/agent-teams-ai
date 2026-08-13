import { HOSTED_COORDINATION_EVENT_SSE_EVENT } from '@features/coordination-events/contracts';

import type {
  CoordinationEventEnvelope,
  CoordinationJsonValue,
  CoordinationResourceRevision,
  HostedCoordinationEventProjection,
} from '@features/coordination-events/contracts';
import type { HostedCoordinationEventStreamAuthorizer } from '@features/coordination-events/main';
import type { HostedAuthHttpFacade } from '@features/hosted-access/main';
import type { TeamId } from '@shared/contracts/hosted';

const MAX_IDENTIFIER_LENGTH = 256;
const MAX_EXTERNAL_FILE_KEY_LENGTH = 1_024;
const MAX_EXTERNAL_RECONCILIATION_ID_LENGTH = 4 * MAX_EXTERNAL_FILE_KEY_LENGTH + 128;
const MAX_EXTERNAL_RESOURCE_ID_LENGTH = 240;
const MAX_JSON_DEPTH = 16;
const MAX_JSON_NODES = 2_048;
const MAX_JSON_STRING_LENGTH = 64 * 1_024;
const INVALID_JSON = Symbol('invalid_json');

const PROJECTABLE_SCOPE_KINDS = new Set<CoordinationEventEnvelope['scope']['kind']>([
  'workspace',
  'team',
  'run',
  'session',
]);

const TEAM_LIFECYCLE_STATUS_EVENT_TYPES = new Set([
  'team-lifecycle.run-cancelling',
  'team-lifecycle.run-recovering',
  'team-lifecycle.run-stopping',
  'team-lifecycle.lane-cancel-observed',
  'team-lifecycle.lane-drain-absence-proven',
  'team-lifecycle.lane-drain-ambiguous',
  'team-lifecycle.lane-drain-incomplete',
  'team-lifecycle.lane-launch-observed',
  'team-lifecycle.lane-launching',
  'team-lifecycle.lane-preflight-rejected',
  'team-lifecycle.lane-recovery-observed',
  'team-lifecycle.lane-status-observed',
  'team-lifecycle.lane-stop-observed',
  'team-lifecycle.lane-terminal-observation-ambiguous',
  'team-lifecycle.lane-terminal-observation-unsettled',
  'team-lifecycle.legacy-cancelling',
  'team-lifecycle.legacy-drain-observed',
  'team-lifecycle.legacy-recovering',
  'team-lifecycle.legacy-recovery-observed',
  'team-lifecycle.legacy-status-observed',
  'team-lifecycle.legacy-stopping',
]);

const TEAM_LIFECYCLE_INVALIDATION_PAYLOAD = Object.freeze({
  kind: 'invalidate',
  resource: 'team_lifecycle',
} as const);

const TEAM_TASK_BOARD_INVALIDATION_PAYLOAD = Object.freeze({
  kind: 'invalidate',
  resource: 'team_task_board',
} as const);

const TEAM_MESSAGES_INVALIDATION_PAYLOAD = Object.freeze({
  kind: 'invalidate',
  resource: 'team_messages',
} as const);

const EXTERNAL_TASK_EVENT_TYPE = 'team.task.external_file_observed';
const EXTERNAL_MESSAGE_EVENT_TYPE = 'team.message.external_inbox_observed';

interface HostedCoordinationEventAuth extends HostedAuthHttpFacade {
  isTeamWorkspaceEventAuthorized(
    request: unknown,
    teamId: TeamId,
    runtimeWorkspaceId: string
  ): Promise<boolean>;
}

function identifier(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    value.length <= MAX_IDENTIFIER_LENGTH &&
    value.trim() === value &&
    !/[\r\n]/.test(value)
  );
}

function record(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

function exactKeys(
  source: Readonly<Record<string, unknown>>,
  expected: readonly string[]
): boolean {
  const actual = Object.keys(source);
  return actual.length === expected.length && expected.every((key) => Object.hasOwn(source, key));
}

function nonNegativeInteger(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

function cloneJson(
  value: unknown,
  budget: { nodes: number },
  depth = 0
): CoordinationJsonValue | typeof INVALID_JSON {
  budget.nodes += 1;
  if (depth > MAX_JSON_DEPTH || budget.nodes > MAX_JSON_NODES) return INVALID_JSON;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'string') {
    return value.length <= MAX_JSON_STRING_LENGTH ? value : INVALID_JSON;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : INVALID_JSON;
  if (Array.isArray(value)) {
    const projected: CoordinationJsonValue[] = [];
    for (const child of value) {
      const cloned = cloneJson(child, budget, depth + 1);
      if (cloned === INVALID_JSON) return INVALID_JSON;
      projected.push(cloned);
    }
    return Object.freeze(projected);
  }
  const source = record(value);
  if (source === null) return INVALID_JSON;
  const projected: Record<string, CoordinationJsonValue> = {};
  for (const [key, child] of Object.entries(source)) {
    if (!identifier(key) || key === '__proto__' || key === 'constructor' || key === 'prototype') {
      return INVALID_JSON;
    }
    const cloned = cloneJson(child, budget, depth + 1);
    if (cloned === INVALID_JSON) return INVALID_JSON;
    projected[key] = cloned;
  }
  return Object.freeze(projected);
}

function revision(value: unknown): CoordinationResourceRevision | null | undefined {
  if (value === undefined) return undefined;
  const source = record(value);
  if (
    source === null ||
    !exactKeys(source, ['resourceKey', 'generation', 'revision']) ||
    !identifier(source.resourceKey) ||
    !nonNegativeInteger(source.generation) ||
    !nonNegativeInteger(source.revision)
  ) {
    return null;
  }
  return Object.freeze({
    resourceKey: source.resourceKey,
    generation: source.generation,
    revision: source.revision,
  });
}

function validRunAcceptedPayload(value: unknown): boolean {
  const source = record(value);
  return (
    source !== null &&
    exactKeys(source, ['fileWriterEpoch', 'generation', 'planHash', 'runId', 'watcherWatermark']) &&
    nonNegativeInteger(source.fileWriterEpoch) &&
    nonNegativeInteger(source.generation) &&
    identifier(source.planHash) &&
    identifier(source.runId) &&
    nonNegativeInteger(source.watcherWatermark)
  );
}

function validLifecycleStatusPayload(value: unknown): boolean {
  const source = record(value);
  return (
    source !== null &&
    exactKeys(source, ['generation', 'state']) &&
    (source.generation === null || nonNegativeInteger(source.generation)) &&
    identifier(source.state)
  );
}

function canonicalTeamId(value: unknown): value is TeamId {
  return typeof value === 'string' && /^team_[0-9a-f]{32}$/u.test(value);
}

function boundedOpaqueString(value: unknown, maximum: number): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= maximum;
}

function validExternalWriterPayload(
  value: unknown,
  resourceKey: 'taskId' | 'inboxId',
  countKey?: 'messageCount'
): boolean {
  const source = record(value);
  if (source === null) return false;
  const actorKind = source.actorKind;
  const expectedKeys = [
    'actorKind',
    'contentChecksum',
    'effect',
    'fileKey',
    'reconciliationId',
    resourceKey,
    ...(countKey === undefined ? [] : [countKey]),
    ...(actorKind === 'verified_run' ? ['runGeneration'] : []),
  ];
  return (
    exactKeys(source, expectedKeys) &&
    (actorKind === 'external_file' || actorKind === 'verified_run') &&
    source.effect === 'observed' &&
    boundedOpaqueString(source.reconciliationId, MAX_EXTERNAL_RECONCILIATION_ID_LENGTH) &&
    boundedOpaqueString(source.fileKey, MAX_EXTERNAL_FILE_KEY_LENGTH) &&
    boundedOpaqueString(source[resourceKey], MAX_EXTERNAL_RESOURCE_ID_LENGTH) &&
    typeof source.contentChecksum === 'string' &&
    /^[0-9a-f]{64}$/u.test(source.contentChecksum) &&
    (countKey === undefined || nonNegativeInteger(source[countKey])) &&
    (actorKind !== 'verified_run' || nonNegativeInteger(source.runGeneration))
  );
}

function externalInvalidationPayload(
  eventType: string,
  sourcePayload: CoordinationJsonValue
): CoordinationJsonValue | null {
  if (eventType === EXTERNAL_TASK_EVENT_TYPE) {
    return validExternalWriterPayload(sourcePayload, 'taskId')
      ? TEAM_TASK_BOARD_INVALIDATION_PAYLOAD
      : null;
  }
  if (eventType === EXTERNAL_MESSAGE_EVENT_TYPE) {
    return validExternalWriterPayload(sourcePayload, 'inboxId', 'messageCount')
      ? TEAM_MESSAGES_INVALIDATION_PAYLOAD
      : null;
  }
  return null;
}

function exactInvalidationPayload(value: unknown, expected: CoordinationJsonValue): boolean {
  const source = record(value);
  const expectedSource = record(expected);
  return (
    source !== null &&
    expectedSource !== null &&
    exactKeys(source, ['kind', 'resource']) &&
    source.kind === expectedSource.kind &&
    source.resource === expectedSource.resource
  );
}

/**
 * Durable event payloads are server-internal records. A hosted stream exposes
 * only closed browser DTOs; adding a durable field or event type never makes it
 * browser-visible without an explicit case here.
 */
function browserPayload(
  eventType: string,
  sourcePayload: CoordinationJsonValue,
  projectedPayload: unknown
): CoordinationJsonValue | null {
  const externalPayload = externalInvalidationPayload(eventType, sourcePayload);
  if (externalPayload !== null) {
    return exactInvalidationPayload(projectedPayload, externalPayload) ? externalPayload : null;
  }
  const valid =
    eventType === 'team-lifecycle.run-accepted'
      ? validRunAcceptedPayload(sourcePayload) && validRunAcceptedPayload(projectedPayload)
      : TEAM_LIFECYCLE_STATUS_EVENT_TYPES.has(eventType)
        ? validLifecycleStatusPayload(sourcePayload) &&
          validLifecycleStatusPayload(projectedPayload)
        : false;
  return valid ? TEAM_LIFECYCLE_INVALIDATION_PAYLOAD : null;
}

function projectableScope(value: unknown): CoordinationEventEnvelope['scope'] | null {
  const source = record(value);
  if (
    source === null ||
    !exactKeys(source, ['kind', 'scopeId']) ||
    !PROJECTABLE_SCOPE_KINDS.has(source.kind as CoordinationEventEnvelope['scope']['kind']) ||
    !identifier(source.scopeId)
  ) {
    return null;
  }
  return Object.freeze({
    kind: source.kind as CoordinationEventEnvelope['scope']['kind'],
    scopeId: source.scopeId,
  });
}

async function isCurrent(hostedAuth: HostedAuthHttpFacade, request: unknown): Promise<boolean> {
  try {
    return await hostedAuth.isEventStreamAuthorized(request);
  } catch {
    return false;
  }
}

async function projectEvent(
  hostedAuth: HostedCoordinationEventAuth,
  request: unknown,
  event: CoordinationEventEnvelope
): Promise<HostedCoordinationEventProjection | null> {
  const sourceScope = projectableScope(event.scope);
  if (sourceScope === null || !identifier(event.workspaceId) || !identifier(event.eventType)) {
    return null;
  }
  const payload = cloneJson(event.payload, { nodes: 0 });
  const sourceRevision = revision(event.resourceRevision);
  if (payload === INVALID_JSON || sourceRevision === null) return null;

  const externalPayload = externalInvalidationPayload(event.eventType, payload);
  const isExternalEvent = externalPayload !== null;
  const externalTeamId = isExternalEvent && canonicalTeamId(event.teamId) ? event.teamId : null;
  if (
    (event.eventType === EXTERNAL_TASK_EVENT_TYPE ||
      event.eventType === EXTERNAL_MESSAGE_EVENT_TYPE) &&
    (!isExternalEvent ||
      sourceScope.kind !== 'team' ||
      externalTeamId === null ||
      sourceScope.scopeId !== event.teamId)
  ) {
    return null;
  }
  if (isExternalEvent) {
    if (externalTeamId === null) return null;
    try {
      if (
        !(await hostedAuth.isTeamWorkspaceEventAuthorized(
          request,
          externalTeamId,
          event.workspaceId
        ))
      ) {
        return null;
      }
    } catch {
      return null;
    }
  }

  const allowlisted = Object.freeze({
    workspaceId: event.workspaceId,
    scope: sourceScope,
    eventType: event.eventType,
    ...(sourceRevision === undefined || isExternalEvent
      ? {}
      : { resourceRevision: sourceRevision }),
    payload: externalPayload ?? payload,
  });
  let projected: unknown;
  try {
    projected = await hostedAuth.projectEvent(
      request,
      HOSTED_COORDINATION_EVENT_SSE_EVENT,
      allowlisted
    );
  } catch {
    return null;
  }
  const output = record(projected);
  const expectedOutputKeys = [
    'workspaceId',
    'scope',
    'eventType',
    ...(sourceRevision === undefined || isExternalEvent ? [] : ['resourceRevision']),
    'payload',
  ];
  const projectedScope = output === null ? null : projectableScope(output.scope);
  const publicRevision = output === null ? null : revision(output.resourceRevision);
  if (
    output === null ||
    !exactKeys(output, expectedOutputKeys) ||
    !identifier(output.workspaceId) ||
    output.workspaceId === event.workspaceId ||
    output.eventType !== event.eventType ||
    projectedScope === null ||
    projectedScope.kind !== sourceScope.kind ||
    publicRevision === null ||
    (sourceRevision === undefined || isExternalEvent) !== (publicRevision === undefined)
  ) {
    return null;
  }

  const publicPayload = browserPayload(event.eventType, payload, output.payload);
  if (publicPayload === null) return null;

  let publicScope: CoordinationEventEnvelope['scope'];
  if (isExternalEvent) {
    if (externalTeamId === null) return null;
    try {
      if (
        !(await hostedAuth.isTeamWorkspaceEventAuthorized(
          request,
          externalTeamId,
          event.workspaceId
        ))
      ) {
        return null;
      }
    } catch {
      return null;
    }
    publicScope = Object.freeze({ kind: 'team', scopeId: externalTeamId });
  } else {
    publicScope = Object.freeze({ kind: 'workspace', scopeId: output.workspaceId });
  }

  return Object.freeze({
    scope: publicScope,
    eventType: event.eventType,
    publicPayload,
  });
}

export function createHostedCoordinationEventStreamAuthorizer(
  hostedAuth: HostedCoordinationEventAuth
): HostedCoordinationEventStreamAuthorizer {
  return Object.freeze({
    allowedOrigin: hostedAuth.allowedOrigin,
    authorize: async (
      request: Parameters<HostedCoordinationEventStreamAuthorizer['authorize']>[0]
    ) => {
      if (!(await isCurrent(hostedAuth, request))) return null;
      return Object.freeze({
        isCurrent: () => isCurrent(hostedAuth, request),
        projectEvent: (event: CoordinationEventEnvelope) =>
          projectEvent(hostedAuth, request, event),
      });
    },
  });
}
