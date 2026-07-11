import { isHostedWebErrorCode } from './http';
import {
  HOSTED_WEB_EFFORT_LEVELS,
  HOSTED_WEB_PROVISIONING_STATES,
  HOSTED_WEB_TEAM_FAST_MODES,
  HOSTED_WEB_TEAM_PROVIDER_IDS,
  HOSTED_WEB_TEAM_REVIEW_STATES,
  HOSTED_WEB_TEAM_TASK_STATUSES,
  type HostedWebProvisioningState,
} from './primitives';

import type {
  HostedWebErrorCode,
  HostedWebEventCursor,
  HostedWebRunId,
  HostedWebTaskSummary,
  HostedWebTeamId,
  HostedWebTeamSnapshotResponse,
  HostedWebTerminalSessionId,
} from './http';

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
  state: HostedWebProvisioningState;
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

const HOSTED_WEB_KANBAN_STATUSES = [
  ...HOSTED_WEB_TEAM_TASK_STATUSES,
  'review',
  'approved',
] as const;

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
      assertTaskSummary(payload.task, 'payload.task');
      assertNonEmptyString(payload.revision, 'payload.revision');
      return;
    case 'hosted.provisioning.progress':
      assertNonEmptyString(payload.runId, 'payload.runId');
      if (!isOneOf(payload.state, HOSTED_WEB_PROVISIONING_STATES)) {
        throw new Error('Hosted web provisioning progress state is invalid');
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
      if (payload.configReady != null) {
        assertBoolean(payload.configReady, 'payload.configReady');
      }
      return;
    case 'hosted.member.message':
      assertNonEmptyString(payload.messageId, 'payload.messageId');
      assertNonEmptyString(payload.fromMemberId, 'payload.fromMemberId');
      assertOptionalString(payload.summary, 'payload.summary');
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
  assertTeamSummary(payload.team, 'payload.team');
  assertNonEmptyString(payload.revision, 'payload.revision');
  if (!Array.isArray(payload.tasks)) {
    throw new Error('Hosted web team snapshot tasks must be an array');
  }
  for (const task of payload.tasks) {
    assertTaskSummary(task, 'payload.tasks[]');
  }
  if (!Array.isArray(payload.kanban)) {
    throw new Error('Hosted web team snapshot kanban must be an array');
  }
  for (const column of payload.kanban) {
    assertRecord(column, 'payload.kanban[]');
    if (!isOneOf(column.status, HOSTED_WEB_KANBAN_STATUSES)) {
      throw new Error('Hosted web team snapshot kanban status is invalid');
    }
    assertStringArray(column.taskIds, 'payload.kanban[].taskIds');
  }
}

function assertTeamSummary(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  assertNonEmptyString(value.teamId, `${fieldName}.teamId`);
  assertNonEmptyString(value.displayName, `${fieldName}.displayName`);
  assertString(value.description, `${fieldName}.description`);
  if (value.project !== null && value.project !== undefined) {
    assertRecord(value.project, `${fieldName}.project`);
    assertRecord(value.project.workspaceRef, `${fieldName}.project.workspaceRef`);
    assertNonEmptyString(value.project.workspaceRef.id, `${fieldName}.project.workspaceRef.id`);
    assertNonEmptyString(
      value.project.workspaceRef.displayName,
      `${fieldName}.project.workspaceRef.displayName`
    );
    assertOptionalString(
      value.project.workspaceRef.repositoryLabel,
      `${fieldName}.project.workspaceRef.repositoryLabel`
    );
    assertOptionalString(
      value.project.workspaceRef.branchLabel,
      `${fieldName}.project.workspaceRef.branchLabel`
    );
  }
  if (value.color !== undefined) {
    assertString(value.color, `${fieldName}.color`);
  }
  if (!Array.isArray(value.members)) {
    throw new Error(`Hosted web SSE ${fieldName}.members must be an array`);
  }
  for (const member of value.members) {
    assertRecord(member, `${fieldName}.members[]`);
    assertNonEmptyString(member.memberId, `${fieldName}.members[].memberId`);
    assertNonEmptyString(member.displayName, `${fieldName}.members[].displayName`);
    assertOptionalString(member.role, `${fieldName}.members[].role`);
    assertOptionalString(member.color, `${fieldName}.members[].color`);
    if (member.provider !== undefined) {
      assertProviderSelection(member.provider, `${fieldName}.members[].provider`);
    }
    if (member.currentTaskId !== null && member.currentTaskId !== undefined) {
      assertNonEmptyString(member.currentTaskId, `${fieldName}.members[].currentTaskId`);
    }
    assertNumber(member.taskCount, `${fieldName}.members[].taskCount`);
    if (
      member.isolation !== undefined &&
      member.isolation !== 'shared-workspace' &&
      member.isolation !== 'managed-worktree'
    ) {
      throw new Error(`Hosted web SSE ${fieldName}.members[].isolation is invalid`);
    }
  }
  assertNumber(value.taskCount, `${fieldName}.taskCount`);
  if (value.lastActivity !== null && value.lastActivity !== undefined) {
    assertString(value.lastActivity, `${fieldName}.lastActivity`);
  }
  if (value.pendingCreate !== undefined) {
    assertBoolean(value.pendingCreate, `${fieldName}.pendingCreate`);
  }
  if (value.partialLaunchFailure !== undefined) {
    assertBoolean(value.partialLaunchFailure, `${fieldName}.partialLaunchFailure`);
  }
  assertRecord(value.runtime, `${fieldName}.runtime`);
  assertBoolean(value.runtime.isAlive, `${fieldName}.runtime.isAlive`);
  assertBoolean(value.runtime.terminalAvailable, `${fieldName}.runtime.terminalAvailable`);
  assertNumber(value.runtime.activeProcessCount, `${fieldName}.runtime.activeProcessCount`);
}

function assertTaskSummary(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  assertNonEmptyString(value.taskId, `${fieldName}.taskId`);
  if (value.displayId !== undefined) {
    assertString(value.displayId, `${fieldName}.displayId`);
  }
  assertNonEmptyString(value.subject, `${fieldName}.subject`);
  if (!isOneOf(value.status, HOSTED_WEB_TEAM_TASK_STATUSES)) {
    throw new Error(`Hosted web SSE ${fieldName}.status is invalid`);
  }
  if (value.ownerMemberId !== undefined) {
    assertString(value.ownerMemberId, `${fieldName}.ownerMemberId`);
  }
  if (
    value.reviewState !== undefined &&
    !isOneOf(value.reviewState, HOSTED_WEB_TEAM_REVIEW_STATES)
  ) {
    throw new Error(`Hosted web SSE ${fieldName}.reviewState is invalid`);
  }
  if (value.blockedBy !== undefined) {
    assertStringArray(value.blockedBy, `${fieldName}.blockedBy`);
  }
  if (value.related !== undefined) {
    assertStringArray(value.related, `${fieldName}.related`);
  }
  if (value.createdAt !== undefined) {
    assertIsoTimestamp(value.createdAt, `${fieldName}.createdAt`);
  }
  if (value.updatedAt !== undefined) {
    assertIsoTimestamp(value.updatedAt, `${fieldName}.updatedAt`);
  }
  if (
    value.needsClarification !== undefined &&
    value.needsClarification !== 'lead' &&
    value.needsClarification !== 'user'
  ) {
    throw new Error(`Hosted web SSE ${fieldName}.needsClarification is invalid`);
  }
}

function assertProviderSelection(value: unknown, fieldName: string): void {
  assertRecord(value, fieldName);
  if (!isOneOf(value.providerId, HOSTED_WEB_TEAM_PROVIDER_IDS)) {
    throw new Error(`Hosted web SSE ${fieldName}.providerId is invalid`);
  }
  assertOptionalString(value.modelId, `${fieldName}.modelId`);
  if (value.effort !== undefined && !isOneOf(value.effort, HOSTED_WEB_EFFORT_LEVELS)) {
    throw new Error(`Hosted web SSE ${fieldName}.effort is invalid`);
  }
  if (value.fastMode !== undefined && !isOneOf(value.fastMode, HOSTED_WEB_TEAM_FAST_MODES)) {
    throw new Error(`Hosted web SSE ${fieldName}.fastMode is invalid`);
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

function assertString(value: unknown, fieldName: string): asserts value is string {
  if (typeof value !== 'string') {
    throw new Error(`Hosted web SSE ${fieldName} must be a string`);
  }
}

function assertOptionalString(value: unknown, fieldName: string): void {
  if (value !== undefined) {
    assertString(value, fieldName);
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

function assertNumber(value: unknown, fieldName: string): asserts value is number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`Hosted web SSE ${fieldName} must be a finite number`);
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

function isOneOf<const Values extends readonly string[]>(
  value: unknown,
  allowed: Values
): value is Values[number] {
  return typeof value === 'string' && allowed.includes(value);
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
