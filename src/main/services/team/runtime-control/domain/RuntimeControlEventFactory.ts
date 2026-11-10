import { buildRuntimeControlCommandEventId, type RuntimeControlLaneId } from './RuntimeControlIds';
import { canonicalizeRuntimeIdempotencyKey } from './RuntimeIdempotencyKey';

import type { RuntimeControlAck } from './RuntimeControlAck';
import type {
  RuntimeControlCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
} from './RuntimeControlCommand';
import type {
  RuntimeBootstrapAcceptedEvent,
  RuntimeControlEvent,
  RuntimeControlEventEnvelope,
  RuntimeControlEventType,
  RuntimeHeartbeatAcceptedEvent,
  RuntimeMessageDeliveredEvent,
  RuntimeMessageDuplicateEvent,
  RuntimePermissionAnsweredEvent,
  RuntimeTaskEventRecordedEvent,
} from './RuntimeControlEvent';

export interface RuntimeControlEventFactoryOptions {
  occurredAt?: string;
}

export function createRuntimeControlEventFromAck(
  command: RuntimeControlCommand,
  ack: RuntimeControlAck,
  options: RuntimeControlEventFactoryOptions = {}
): RuntimeControlEvent {
  assertRuntimeControlAckMatchesCommand(command, ack);

  const type = getRuntimeControlEventType(command, ack);
  const base = createRuntimeControlEventBase(command, type, options.occurredAt ?? ack.observedAt);

  switch (command.kind) {
    case 'runtime.bootstrap-checkin':
      return {
        ...base,
        type: 'RuntimeBootstrapAccepted',
        memberName: command.memberName,
        runtimeSessionId: command.runtimeSessionId,
      } satisfies RuntimeBootstrapAcceptedEvent;
    case 'runtime.deliver-message':
      return createRuntimeControlMessageEvent(command, ack, base);
    case 'runtime.task-event':
      return {
        ...base,
        type: 'RuntimeTaskEventRecorded',
        memberName: command.memberName,
        taskId: command.taskId,
        taskEvent: command.event,
        idempotencyKey: command.idempotencyKey,
      } satisfies RuntimeTaskEventRecordedEvent;
    case 'runtime.heartbeat':
      return createRuntimeControlHeartbeatEvent(command, base);
    case 'runtime.permission-answer':
      return createRuntimeControlPermissionAnsweredEvent(command, base);
    default:
      return assertNever(command);
  }
}

function createRuntimeControlEventBase(
  command: RuntimeControlCommand,
  eventType: RuntimeControlEventType,
  occurredAt: string
): RuntimeControlEventEnvelope {
  return {
    eventId: buildRuntimeControlCommandEventId({
      providerId: command.providerId,
      eventType,
      commandId: command.commandId,
    }),
    type: eventType,
    providerId: command.providerId,
    teamName: command.teamName,
    runId: command.runId,
    laneId: requireRuntimeControlLaneId(command),
    occurredAt,
    commandId: command.commandId,
  };
}

function createRuntimeControlMessageEvent(
  command: RuntimeDeliverMessageCommand,
  ack: RuntimeControlAck,
  base: RuntimeControlEventEnvelope
): RuntimeMessageDeliveredEvent | RuntimeMessageDuplicateEvent {
  if (ack.state === 'duplicate') {
    return {
      ...base,
      type: 'RuntimeMessageDuplicate',
      idempotencyKey: command.idempotencyKey,
    } satisfies RuntimeMessageDuplicateEvent;
  }

  return {
    ...base,
    type: 'RuntimeMessageDelivered',
    idempotencyKey: command.idempotencyKey,
    fromMemberName: command.fromMemberName,
    ...(ack.location ? { location: ack.location } : {}),
  } satisfies RuntimeMessageDeliveredEvent;
}

function createRuntimeControlHeartbeatEvent(
  command: RuntimeHeartbeatCommand,
  base: RuntimeControlEventEnvelope
): RuntimeHeartbeatAcceptedEvent {
  return {
    ...base,
    type: 'RuntimeHeartbeatAccepted',
    memberName: command.memberName,
    runtimeSessionId: command.runtimeSessionId,
    ...(command.status ? { status: command.status } : {}),
  };
}

function createRuntimeControlPermissionAnsweredEvent(
  command: RuntimePermissionAnswerCommand,
  base: RuntimeControlEventEnvelope
): RuntimePermissionAnsweredEvent {
  return {
    ...base,
    type: 'RuntimePermissionAnswered',
    memberName: command.memberName,
    requestId: command.requestId,
    decision: command.decision,
  };
}

function getRuntimeControlEventType(
  command: RuntimeControlCommand,
  ack: RuntimeControlAck
): RuntimeControlEventType {
  switch (command.kind) {
    case 'runtime.bootstrap-checkin':
      return 'RuntimeBootstrapAccepted';
    case 'runtime.deliver-message':
      return ack.state === 'duplicate' ? 'RuntimeMessageDuplicate' : 'RuntimeMessageDelivered';
    case 'runtime.task-event':
      return 'RuntimeTaskEventRecorded';
    case 'runtime.heartbeat':
      return 'RuntimeHeartbeatAccepted';
    case 'runtime.permission-answer':
      return 'RuntimePermissionAnswered';
    default:
      return assertNever(command);
  }
}

function requireRuntimeControlLaneId(command: RuntimeControlCommand): RuntimeControlLaneId {
  if (!command.laneId) {
    throw new Error(`Runtime control event missing laneId for ${command.kind}`);
  }
  return command.laneId;
}

export function assertRuntimeControlAckMatchesCommand(
  command: RuntimeControlCommand,
  ack: RuntimeControlAck
): void {
  if (ack.providerId !== command.providerId) {
    throw new Error(
      `Runtime control ack provider mismatch: expected ${command.providerId}, received ${ack.providerId}`
    );
  }
  if (ack.teamName !== command.teamName) {
    throw new Error(
      `Runtime control ack team mismatch: expected ${command.teamName}, received ${ack.teamName}`
    );
  }
  if (ack.runId !== command.runId) {
    throw new Error(
      `Runtime control ack run mismatch: expected ${command.runId}, received ${ack.runId}`
    );
  }

  const expectedStates = getExpectedRuntimeControlAckStates(command);
  if (!expectedStates.includes(ack.state)) {
    throw new Error(
      `Runtime control ack state mismatch for ${command.kind}: expected ${expectedStates.join(' or ')}, received ${ack.state}`
    );
  }

  if (
    (command.kind === 'runtime.deliver-message' || command.kind === 'runtime.task-event') &&
    ack.idempotencyKey !== undefined
  ) {
    const expectedIdempotencyKey = canonicalizeRuntimeIdempotencyKey(command.idempotencyKey);
    const receivedIdempotencyKey = canonicalizeRuntimeIdempotencyKey(ack.idempotencyKey, {
      errorPrefix: 'Runtime control ack',
    });
    if (receivedIdempotencyKey !== expectedIdempotencyKey) {
      throw new Error(
        `Runtime control ack idempotency mismatch: expected ${expectedIdempotencyKey}, received ${receivedIdempotencyKey}`
      );
    }
  }
}

function getExpectedRuntimeControlAckStates(
  command: RuntimeControlCommand
): readonly RuntimeControlAck['state'][] {
  switch (command.kind) {
    case 'runtime.bootstrap-checkin':
    case 'runtime.heartbeat':
    case 'runtime.permission-answer':
      return ['accepted'];
    case 'runtime.deliver-message':
      return ['delivered', 'duplicate'];
    case 'runtime.task-event':
      return ['recorded'];
    default:
      return assertNever(command);
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported runtime control command: ${String(value)}`);
}
