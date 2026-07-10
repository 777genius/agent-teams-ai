import { isHostedWebErrorCode } from './http';

import type {
  HostedWebErrorCode,
  HostedWebEventCursor,
  HostedWebRunId,
  HostedWebTaskSummary,
  HostedWebTeamId,
  HostedWebTeamSnapshotResponse,
  HostedWebTerminalSessionId,
} from './http';
import type { TeamProvisioningState } from '@shared/types/team';

export const HOSTED_WEB_SSE_EVENT_TYPES = [
  'hosted.team.snapshot',
  'hosted.task.changed',
  'hosted.provisioning.progress',
  'hosted.member.message',
  'hosted.runtime.state',
  'hosted.error',
] as const;

export type HostedWebSseEventType = (typeof HOSTED_WEB_SSE_EVENT_TYPES)[number];

interface HostedWebEventBase<Type extends HostedWebSseEventType, Payload> {
  type: Type;
  eventId: HostedWebEventCursor;
  teamId: HostedWebTeamId;
  emittedAt: string;
  payload: Payload;
}

export interface HostedWebProvisioningProgressPayload {
  runId: HostedWebRunId;
  state: Exclude<TeamProvisioningState, 'idle'>;
  message: string;
  severity?: 'info' | 'warning' | 'error';
  startedAt: string;
  updatedAt: string;
  configReady?: boolean;
}

export interface HostedWebMemberMessagePayload {
  messageId: string;
  fromMemberId: string;
  summary?: string;
  body: string;
  taskIds?: string[];
  createdAt: string;
}

export interface HostedWebRuntimeStatePayload {
  isAlive: boolean;
  terminalAvailable: boolean;
  activeTerminalSessionIds: HostedWebTerminalSessionId[];
}

export interface HostedWebErrorPayload {
  code: HostedWebErrorCode;
  message: string;
  retryable?: boolean;
}

export type HostedWebTeamSnapshotEvent = HostedWebEventBase<
  'hosted.team.snapshot',
  HostedWebTeamSnapshotResponse
>;

export type HostedWebTaskChangedEvent = HostedWebEventBase<
  'hosted.task.changed',
  { task: HostedWebTaskSummary; revision: string }
>;

export type HostedWebProvisioningProgressEvent = HostedWebEventBase<
  'hosted.provisioning.progress',
  HostedWebProvisioningProgressPayload
>;

export type HostedWebMemberMessageEvent = HostedWebEventBase<
  'hosted.member.message',
  HostedWebMemberMessagePayload
>;

export type HostedWebRuntimeStateEvent = HostedWebEventBase<
  'hosted.runtime.state',
  HostedWebRuntimeStatePayload
>;

export type HostedWebErrorEvent = HostedWebEventBase<'hosted.error', HostedWebErrorPayload>;

export type HostedWebEvent =
  | HostedWebTeamSnapshotEvent
  | HostedWebTaskChangedEvent
  | HostedWebProvisioningProgressEvent
  | HostedWebMemberMessageEvent
  | HostedWebRuntimeStateEvent
  | HostedWebErrorEvent;

export interface ParseHostedWebSseEventOptions {
  lastEventId?: string;
}

export function isHostedWebSseEventType(value: string): value is HostedWebSseEventType {
  return HOSTED_WEB_SSE_EVENT_TYPES.includes(value as HostedWebSseEventType);
}

export function parseHostedWebSseEvent(
  type: string,
  data: string,
  options: ParseHostedWebSseEventOptions = {}
): HostedWebEvent {
  if (!isHostedWebSseEventType(type)) {
    throw new Error(`Unsupported hosted web SSE event type: ${type}`);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch (error) {
    throw new Error(`Invalid hosted web SSE JSON: ${toErrorMessage(error)}`);
  }

  assertEventEnvelope(parsed, type, options.lastEventId);
  assertPayload(parsed.type, parsed.payload);
  return parsed;
}

function assertEventEnvelope(
  value: unknown,
  expectedType: HostedWebSseEventType,
  lastEventId: string | undefined
): asserts value is HostedWebEvent {
  if (!isRecord(value)) {
    throw new Error('Hosted web SSE event must be an object');
  }
  if (value.type !== expectedType) {
    throw new Error(
      `Hosted web SSE event type mismatch: expected ${expectedType}, got ${String(value.type)}`
    );
  }
  assertNonEmptyString(value.eventId, 'eventId');
  assertNonEmptyString(value.teamId, 'teamId');
  assertIsoTimestamp(value.emittedAt, 'emittedAt');
  if (lastEventId && lastEventId !== value.eventId) {
    throw new Error(
      `Hosted web SSE cursor mismatch: Last-Event-ID ${lastEventId} did not match envelope ${value.eventId}`
    );
  }
}

function assertPayload(type: HostedWebSseEventType, payload: unknown): void {
  if (!isRecord(payload)) {
    throw new Error(`Hosted web SSE ${type} payload must be an object`);
  }

  switch (type) {
    case 'hosted.team.snapshot':
      assertTeamSnapshotPayload(payload);
      return;
    case 'hosted.task.changed':
      assertRecord(payload.task, 'payload.task');
      assertNonEmptyString(payload.revision, 'payload.revision');
      return;
    case 'hosted.provisioning.progress':
      assertNonEmptyString(payload.runId, 'payload.runId');
      assertNonEmptyString(payload.state, 'payload.state');
      if (payload.state === 'idle') {
        throw new Error('Hosted web provisioning progress state must not be idle');
      }
      assertNonEmptyString(payload.message, 'payload.message');
      assertIsoTimestamp(payload.startedAt, 'payload.startedAt');
      assertIsoTimestamp(payload.updatedAt, 'payload.updatedAt');
      if (
        payload.severity != null &&
        !['info', 'warning', 'error'].includes(String(payload.severity))
      ) {
        throw new Error('Hosted web provisioning severity is invalid');
      }
      return;
    case 'hosted.member.message':
      assertNonEmptyString(payload.messageId, 'payload.messageId');
      assertNonEmptyString(payload.fromMemberId, 'payload.fromMemberId');
      assertNonEmptyString(payload.body, 'payload.body');
      assertIsoTimestamp(payload.createdAt, 'payload.createdAt');
      if (payload.taskIds != null) {
        assertStringArray(payload.taskIds, 'payload.taskIds');
      }
      return;
    case 'hosted.runtime.state':
      assertBoolean(payload.isAlive, 'payload.isAlive');
      assertBoolean(payload.terminalAvailable, 'payload.terminalAvailable');
      assertStringArray(payload.activeTerminalSessionIds, 'payload.activeTerminalSessionIds');
      return;
    case 'hosted.error':
      if (!isHostedWebErrorCode(payload.code)) {
        throw new Error('Hosted web error code must be namespaced under /api/hosted/v1');
      }
      assertNonEmptyString(payload.message, 'payload.message');
      if (payload.retryable != null) {
        assertBoolean(payload.retryable, 'payload.retryable');
      }
      return;
  }
}

function assertTeamSnapshotPayload(payload: Record<string, unknown>): void {
  assertRecord(payload.team, 'payload.team');
  assertNonEmptyString(payload.revision, 'payload.revision');
  if (!Array.isArray(payload.tasks)) {
    throw new Error('Hosted web team snapshot tasks must be an array');
  }
  if (!Array.isArray(payload.kanban)) {
    throw new Error('Hosted web team snapshot kanban must be an array');
  }
  assertRecord(payload.team.runtime, 'payload.team.runtime');
  assertBoolean(payload.team.runtime.isAlive, 'payload.team.runtime.isAlive');
  assertBoolean(payload.team.runtime.terminalAvailable, 'payload.team.runtime.terminalAvailable');
  if (!Array.isArray(payload.team.members)) {
    throw new Error('Hosted web team snapshot members must be an array');
  }
  if (payload.team.project !== null && payload.team.project !== undefined) {
    assertRecord(payload.team.project, 'payload.team.project');
    assertRecord(payload.team.project.workspaceRef, 'payload.team.project.workspaceRef');
    assertNonEmptyString(
      payload.team.project.workspaceRef.id,
      'payload.team.project.workspaceRef.id'
    );
    assertNonEmptyString(
      payload.team.project.workspaceRef.displayName,
      'payload.team.project.workspaceRef.displayName'
    );
  }
}

function assertRecord(value: unknown, fieldName: string): asserts value is Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error(`Hosted web SSE ${fieldName} must be an object`);
  }
}

function assertNonEmptyString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string' || value.length === 0) {
    throw new Error(`Hosted web SSE ${fieldName} must be a non-empty string`);
  }
}

function assertIsoTimestamp(value: unknown, fieldName: string): asserts value is string {
  assertNonEmptyString(value, fieldName);
  if (Number.isNaN(Date.parse(value))) {
    throw new Error(`Hosted web SSE ${fieldName} must be a valid timestamp`);
  }
}

function assertBoolean(value: unknown, fieldName: string): asserts value is boolean {
  if (typeof value !== 'boolean') {
    throw new Error(`Hosted web SSE ${fieldName} must be a boolean`);
  }
}

function assertStringArray(value: unknown, fieldName: string): asserts value is string[] {
  if (!Array.isArray(value) || value.some((item) => typeof item !== 'string')) {
    throw new Error(`Hosted web SSE ${fieldName} must be a string array`);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
