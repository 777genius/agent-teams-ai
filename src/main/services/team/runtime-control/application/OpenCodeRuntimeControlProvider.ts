import { RuntimeControlService } from '../RuntimeControlService';

import type { OpenCodeRuntimeControlAck, RuntimeControlAck } from '../domain/RuntimeControlAck';
import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeDeliverMessageCommand,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimeTaskEventCommand,
} from '../domain/RuntimeControlCommand';
import type { RuntimeControlProviderHandler } from '../domain/RuntimeControlProvider';
import type { OpenCodeRuntimeControlRouter } from './OpenCodeRuntimeControlApi';
import type { RuntimeControlEventSink } from './RuntimeControlPorts';
import type { TaskRef } from '@shared/types';

export interface OpenCodeRuntimeControlPort {
  recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  answerOpenCodeRuntimePermission(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
}

export interface OpenCodeRuntimeControlRouterOptions {
  eventSink?: RuntimeControlEventSink;
}

export function createOpenCodeRuntimeControlProvider(
  port: OpenCodeRuntimeControlPort
): RuntimeControlProviderHandler {
  return {
    providerId: 'opencode',
    recordBootstrapCheckin: (command) =>
      port.recordOpenCodeRuntimeBootstrapCheckin(toOpenCodeBootstrapCheckinPayload(command)),
    deliverMessage: (command) =>
      port.deliverOpenCodeRuntimeMessage(toOpenCodeDeliveryPayload(command)),
    recordTaskEvent: (command) =>
      port.recordOpenCodeRuntimeTaskEvent(toOpenCodeTaskEventPayload(command)),
    recordHeartbeat: (command) =>
      port.recordOpenCodeRuntimeHeartbeat(toOpenCodeHeartbeatPayload(command)),
    answerPermission: (command) =>
      port.answerOpenCodeRuntimePermission(toOpenCodePermissionAnswerPayload(command)),
  };
}

export function createOpenCodeRuntimeControlRouter(
  port: OpenCodeRuntimeControlPort,
  options: OpenCodeRuntimeControlRouterOptions = {}
): OpenCodeRuntimeControlRouter {
  const service = new RuntimeControlService({
    providers: [createOpenCodeRuntimeControlProvider(port)],
    eventSink: options.eventSink,
  });
  return {
    recordBootstrapCheckin: async (command) =>
      toOpenCodeRuntimeControlAck(await service.recordBootstrapCheckin(command)),
    deliverMessage: async (command) =>
      toOpenCodeRuntimeControlAck(await service.deliverMessage(command)),
    recordTaskEvent: async (command) =>
      toOpenCodeRuntimeControlAck(await service.recordTaskEvent(command)),
    recordHeartbeat: async (command) =>
      toOpenCodeRuntimeControlAck(await service.recordHeartbeat(command)),
    answerPermission: async (command) =>
      toOpenCodeRuntimeControlAck(await service.answerPermission(command)),
  };
}

function toOpenCodeBootstrapCheckinPayload(command: RuntimeBootstrapCheckinCommand) {
  return {
    teamName: command.teamName,
    runId: command.runId,
    memberName: command.memberName,
    runtimeSessionId: command.runtimeSessionId,
    observedAt: command.observedAt,
    ...(command.diagnostics ? { diagnostics: command.diagnostics } : {}),
    ...(command.metadata ? { metadata: command.metadata } : {}),
  };
}

function toOpenCodeDeliveryPayload(command: RuntimeDeliverMessageCommand) {
  return {
    teamName: command.teamName,
    runId: command.runId,
    fromMemberName: command.fromMemberName,
    idempotencyKey: command.idempotencyKey,
    runtimeSessionId: command.runtimeSessionId,
    to: command.target,
    text: command.text,
    createdAt: command.createdAt,
    ...(command.summary === undefined ? {} : { summary: command.summary }),
    ...(command.taskRefs?.length
      ? { taskRefs: command.taskRefs.map(toRuntimeDeliveryTaskRef) }
      : {}),
  };
}

function toOpenCodeTaskEventPayload(command: RuntimeTaskEventCommand) {
  return {
    teamName: command.teamName,
    runId: command.runId,
    memberName: command.memberName,
    taskId: command.taskId,
    event: command.event,
    idempotencyKey: command.idempotencyKey,
    ...(command.runtimeSessionId ? { runtimeSessionId: command.runtimeSessionId } : {}),
    createdAt: command.createdAt,
  };
}

function toOpenCodeHeartbeatPayload(command: RuntimeHeartbeatCommand) {
  return {
    teamName: command.teamName,
    runId: command.runId,
    memberName: command.memberName,
    runtimeSessionId: command.runtimeSessionId,
    observedAt: command.observedAt,
    ...(command.status ? { status: command.status } : {}),
    ...(command.metadata ? { metadata: command.metadata } : {}),
  };
}

function toOpenCodePermissionAnswerPayload(command: RuntimePermissionAnswerCommand) {
  return {
    teamName: command.teamName,
    runId: command.runId,
    laneId: command.laneId,
    cwd: command.cwd,
    memberName: command.memberName,
    requestId: command.requestId,
    decision: command.decision,
    expectedMembers: command.expectedMembers,
    previousLaunchState: command.previousLaunchState,
  };
}

function toRuntimeDeliveryTaskRef(taskRef: TaskRef): TaskRef {
  return {
    taskId: taskRef.taskId,
    displayId: taskRef.displayId,
    teamName: taskRef.teamName,
  };
}

function toOpenCodeRuntimeControlAck(ack: RuntimeControlAck): OpenCodeRuntimeControlAck {
  assertOpenCodeRuntimeControlAck(ack);
  return ack;
}

function assertOpenCodeRuntimeControlAck(
  ack: RuntimeControlAck
): asserts ack is OpenCodeRuntimeControlAck {
  if (ack.providerId !== 'opencode') {
    throw new Error(`Expected OpenCode runtime-control ack, received ${ack.providerId}`);
  }
}
