import {
  buildRuntimeBootstrapCheckinCommandId,
  buildRuntimeDeliverMessageCommandId,
  buildRuntimeHeartbeatCommandId,
  buildRuntimePermissionAnswerCommandId,
  buildRuntimeTaskEventCommandId,
} from '../domain/RuntimeControlIds';
import { canonicalizeRuntimeIdempotencyKey } from '../domain/RuntimeIdempotencyKey';

import type { OpenCodeRuntimeControlAck } from '../domain/RuntimeControlAck';
import type {
  RuntimeBootstrapCheckinCommand,
  RuntimeControlSafeMetadata,
  RuntimeDeliverMessageCommand,
  RuntimeDeliverMessageTarget,
  RuntimeHeartbeatCommand,
  RuntimePermissionAnswerCommand,
  RuntimePermissionAnswerDecision,
  RuntimePermissionExpectedMember,
  RuntimeTaskEventCommand,
} from '../domain/RuntimeControlCommand';
import type { RuntimeControlLaneId } from '../domain/RuntimeControlIds';
import type { PersistedTeamLaunchSnapshot, TaskRef, TeamProviderId } from '@shared/types';

export interface OpenCodeRuntimeControlRouter {
  recordBootstrapCheckin(
    command: RuntimeBootstrapCheckinCommand
  ): Promise<OpenCodeRuntimeControlAck>;
  deliverMessage(command: RuntimeDeliverMessageCommand): Promise<OpenCodeRuntimeControlAck>;
  recordTaskEvent(command: RuntimeTaskEventCommand): Promise<OpenCodeRuntimeControlAck>;
  recordHeartbeat(command: RuntimeHeartbeatCommand): Promise<OpenCodeRuntimeControlAck>;
  answerPermission(command: RuntimePermissionAnswerCommand): Promise<OpenCodeRuntimeControlAck>;
}

export interface OpenCodeRuntimeControlApiPorts {
  runtimeControl: OpenCodeRuntimeControlRouter;
  resolveOpenCodeRuntimeLaneId(input: {
    teamName: string;
    runId: string;
    memberName?: string;
  }): Promise<string>;
}

export interface OpenCodeRuntimeControlApi {
  recordOpenCodeRuntimeBootstrapCheckin(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  deliverOpenCodeRuntimeMessage(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeTaskEvent(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  recordOpenCodeRuntimeHeartbeat(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
  answerOpenCodeRuntimePermission(raw: unknown): Promise<OpenCodeRuntimeControlAck>;
}

export function createOpenCodeRuntimeControlApi(
  ports: OpenCodeRuntimeControlApiPorts
): OpenCodeRuntimeControlApi {
  return {
    recordOpenCodeRuntimeBootstrapCheckin: async (raw) => {
      const payload = asOpenCodeRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const memberName = requireRuntimeString(payload.memberName, 'memberName');
      const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
      const observedAt = normalizeRuntimeIso(payload.observedAt);
      const laneId = await resolveLaneId(ports, { teamName, runId, memberName });
      const metadata = normalizeRuntimeSafeMetadata(payload.metadata);

      return ports.runtimeControl.recordBootstrapCheckin({
        commandId: buildRuntimeBootstrapCheckinCommandId({
          providerId: 'opencode',
          teamName,
          laneId,
          runId,
          memberName,
          runtimeSessionId,
        }),
        kind: 'runtime.bootstrap-checkin',
        providerId: 'opencode',
        teamName,
        runId,
        laneId,
        memberName,
        runtimeSessionId,
        observedAt,
        diagnostics: normalizeRuntimeStringArray(payload.diagnostics),
        ...(metadata ? { metadata } : {}),
      });
    },
    deliverOpenCodeRuntimeMessage: async (raw) => {
      const payload = asOpenCodeRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const fromMemberName = requireRuntimeString(payload.fromMemberName, 'fromMemberName');
      const laneId = await resolveLaneId(ports, {
        teamName,
        runId,
        memberName: fromMemberName,
      });
      const idempotencyKey = canonicalizeRuntimeIdempotencyKey(payload.idempotencyKey, {
        errorPrefix: 'Runtime delivery envelope',
      });
      const taskRefs = normalizeOpenCodeRuntimeIngressTaskRefs(teamName, payload.taskRefs);

      return ports.runtimeControl.deliverMessage({
        commandId: buildRuntimeDeliverMessageCommandId({
          providerId: 'opencode',
          teamName,
          laneId,
          runId,
          idempotencyKey,
        }),
        kind: 'runtime.deliver-message',
        providerId: 'opencode',
        teamName,
        runId,
        laneId,
        idempotencyKey,
        fromMemberName,
        runtimeSessionId: requireRuntimeDeliveryString(
          payload.runtimeSessionId,
          'runtimeSessionId'
        ),
        target: normalizeRuntimeDeliveryTarget(payload.to),
        text: requireRuntimeDeliveryString(payload.text, 'text'),
        createdAt: requireRuntimeDeliveryIso(payload.createdAt, 'createdAt'),
        summary:
          payload.summary === undefined || payload.summary === null
            ? null
            : String(payload.summary),
        ...(taskRefs ? { taskRefs } : {}),
      });
    },
    recordOpenCodeRuntimeTaskEvent: async (raw) => {
      const payload = asOpenCodeRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const memberName = requireRuntimeString(payload.memberName, 'memberName');
      const taskId = requireRuntimeString(payload.taskId, 'taskId');
      const event = requireRuntimeString(payload.event, 'event');
      const idempotencyKey = canonicalizeRuntimeIdempotencyKey(payload.idempotencyKey, {
        errorPrefix: 'OpenCode runtime payload',
      });
      const runtimeSessionId = optionalRuntimeString(payload.runtimeSessionId);
      const createdAt = requireRuntimeIso(payload.createdAt, 'createdAt');
      const laneId = await resolveLaneId(ports, { teamName, runId, memberName });

      return ports.runtimeControl.recordTaskEvent({
        commandId: buildRuntimeTaskEventCommandId({
          providerId: 'opencode',
          teamName,
          laneId,
          runId,
          idempotencyKey,
        }),
        kind: 'runtime.task-event',
        providerId: 'opencode',
        teamName,
        runId,
        laneId,
        memberName,
        taskId,
        event,
        idempotencyKey,
        ...(runtimeSessionId ? { runtimeSessionId } : {}),
        createdAt,
      });
    },
    recordOpenCodeRuntimeHeartbeat: async (raw) => {
      const payload = asOpenCodeRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const memberName = requireRuntimeString(payload.memberName, 'memberName');
      const runtimeSessionId = requireRuntimeString(payload.runtimeSessionId, 'runtimeSessionId');
      const observedAt = normalizeRuntimeIso(payload.observedAt);
      const laneId = await resolveLaneId(ports, { teamName, runId, memberName });
      const status = optionalRuntimeString(payload.status);
      const metadata = normalizeRuntimeSafeMetadata(payload.metadata);

      return ports.runtimeControl.recordHeartbeat({
        commandId: buildRuntimeHeartbeatCommandId({
          providerId: 'opencode',
          teamName,
          laneId,
          runId,
          memberName,
          runtimeSessionId,
          observedAt,
        }),
        kind: 'runtime.heartbeat',
        providerId: 'opencode',
        teamName,
        runId,
        laneId,
        memberName,
        runtimeSessionId,
        observedAt,
        ...(status ? { status } : {}),
        ...(metadata ? { metadata } : {}),
      });
    },
    answerOpenCodeRuntimePermission: async (raw) => {
      const payload = asOpenCodeRuntimeRecord(raw);
      const teamName = requireRuntimeString(payload.teamName, 'teamName');
      const runId = requireRuntimeString(payload.runId, 'runId');
      const memberName = requireRuntimeString(payload.memberName, 'memberName');
      const cwd = requireRuntimeString(payload.cwd ?? payload.projectPath, 'cwd');
      const requestId = normalizeOpenCodeRuntimePermissionRequestId(
        requireRuntimeString(payload.providerRequestId ?? payload.requestId, 'requestId'),
        runId
      );
      const decision = normalizeRuntimePermissionAnswerDecision(payload.decision);
      const laneId = await resolveLaneId(ports, { teamName, runId, memberName });

      return ports.runtimeControl.answerPermission({
        commandId: buildRuntimePermissionAnswerCommandId({
          providerId: 'opencode',
          teamName,
          laneId,
          runId,
          requestId,
          decision,
        }),
        kind: 'runtime.permission-answer',
        providerId: 'opencode',
        teamName,
        runId,
        laneId,
        cwd,
        memberName,
        requestId,
        decision,
        expectedMembers: normalizeRuntimePermissionExpectedMembers(payload.expectedMembers),
        previousLaunchState: normalizeRuntimePermissionPreviousLaunchState(
          payload.previousLaunchState
        ),
      });
    },
  };
}

async function resolveLaneId(
  ports: Pick<OpenCodeRuntimeControlApiPorts, 'resolveOpenCodeRuntimeLaneId'>,
  input: {
    teamName: string;
    runId: string;
    memberName?: string;
  }
): Promise<RuntimeControlLaneId> {
  return ports.resolveOpenCodeRuntimeLaneId(input);
}

function asOpenCodeRuntimeRecord(value: unknown): Record<string, unknown> {
  if (!isRecord(value)) {
    throw new Error('OpenCode runtime payload must be an object');
  }
  return value;
}

function requireRuntimeString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`OpenCode runtime payload missing ${fieldName}`);
  }
  return value.trim();
}

function requireRuntimeDeliveryString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Runtime delivery envelope missing ${fieldName}`);
  }
  return value;
}

function optionalRuntimeString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
}

function normalizeRuntimeIso(value: unknown, fallback: string = new Date().toISOString()): string {
  const raw = optionalRuntimeString(value);
  if (!raw) {
    return fallback;
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : fallback;
}

function requireRuntimeIso(
  value: unknown,
  fieldName: string,
  errorPrefix = 'OpenCode runtime payload'
): string {
  const raw = optionalRuntimeString(value);
  if (!raw) {
    throw new Error(`${errorPrefix} missing ${fieldName}`);
  }
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(`${errorPrefix} invalid ${fieldName}`);
  }
  return new Date(parsed).toISOString();
}

function requireRuntimeDeliveryIso(value: unknown, fieldName: string): string {
  return requireRuntimeIso(value, fieldName, 'Runtime delivery envelope');
}

function normalizeRuntimeStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
    : [];
}

function normalizeRuntimeSafeMetadata(value: unknown): RuntimeControlSafeMetadata | undefined {
  if (!isRecord(value)) {
    return undefined;
  }
  const entries = Object.entries(value).filter(
    (entry): entry is [string, string | number | boolean | null] =>
      typeof entry[1] === 'string' ||
      typeof entry[1] === 'number' ||
      typeof entry[1] === 'boolean' ||
      entry[1] === null
  );
  return entries.length > 0 ? Object.fromEntries(entries) : undefined;
}

function normalizeRuntimePermissionAnswerDecision(value: unknown): RuntimePermissionAnswerDecision {
  if (value === 'allow' || value === 'reject') {
    return value;
  }
  throw new Error('OpenCode runtime permission answer decision must be allow or reject');
}

function normalizeOpenCodeRuntimePermissionRequestId(value: string, runId: string): string {
  const prefix = `opencode:${runId}:`;
  const normalized = value.startsWith(prefix) ? value.slice(prefix.length) : value;
  if (!normalized.trim()) {
    throw new Error('OpenCode runtime payload missing requestId');
  }
  return normalized;
}

function normalizeRuntimePermissionExpectedMembers(
  value: unknown
): readonly RuntimePermissionExpectedMember[] {
  if (value === undefined || value === null) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error('OpenCode runtime permission expectedMembers must be an array');
  }
  return value.map(normalizeRuntimePermissionExpectedMember);
}

function normalizeRuntimePermissionExpectedMember(
  value: unknown,
  index: number
): RuntimePermissionExpectedMember {
  if (!isRecord(value)) {
    throw new Error(`OpenCode runtime permission expectedMembers[${index}] must be an object`);
  }
  const name = requireRuntimeString(value.name, `expectedMembers[${index}].name`);
  const role = optionalRuntimeString(value.role);
  const workflow = optionalRuntimeString(value.workflow);
  const providerId = normalizeOptionalRuntimePermissionProviderId(
    value.providerId,
    `expectedMembers[${index}].providerId`
  );
  const cwd = optionalRuntimeString(value.cwd);
  return {
    name,
    ...(role ? { role } : {}),
    ...(workflow ? { workflow } : {}),
    ...(providerId ? { providerId } : {}),
    ...(cwd ? { cwd } : {}),
  };
}

function normalizeOptionalRuntimePermissionProviderId(
  value: unknown,
  fieldName: string
): TeamProviderId | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined;
  }
  if (value === 'anthropic' || value === 'codex' || value === 'gemini' || value === 'opencode') {
    return value;
  }
  throw new Error(`OpenCode runtime permission ${fieldName} is invalid`);
}

function normalizeRuntimePermissionPreviousLaunchState(
  value: unknown
): PersistedTeamLaunchSnapshot | null {
  if (value === undefined || value === null) {
    return null;
  }
  if (!isRecord(value)) {
    throw new Error('OpenCode runtime permission previousLaunchState must be an object');
  }
  return value as unknown as PersistedTeamLaunchSnapshot;
}

function normalizeRuntimeDeliveryTarget(value: unknown): RuntimeDeliverMessageTarget {
  if (value === 'user') {
    return 'user';
  }
  if (!isRecord(value)) {
    throw new Error('Runtime delivery target must be user or object');
  }
  const memberName = requireRuntimeDeliveryString(value.memberName, 'to.memberName').trim();
  if (typeof value.teamName === 'string' && value.teamName.trim()) {
    return { teamName: value.teamName.trim(), memberName };
  }
  return { memberName };
}

function normalizeOpenCodeRuntimeIngressTaskRefs(
  teamName: string,
  value: unknown
): readonly TaskRef[] | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  if (!Array.isArray(value)) {
    throw new Error('Runtime delivery envelope taskRefs must be an array');
  }
  if (value.length === 0) {
    return undefined;
  }
  return value.map((item, index) => normalizeOpenCodeRuntimeIngressTaskRef(teamName, item, index));
}

function normalizeOpenCodeRuntimeIngressTaskRef(
  teamName: string,
  value: unknown,
  index: number
): TaskRef {
  if (typeof value === 'string') {
    const taskId = value.trim();
    if (!taskId) {
      throw new Error(`Runtime delivery envelope missing taskRefs[${index}]`);
    }
    return { teamName, taskId, displayId: taskId };
  }
  if (!isRecord(value)) {
    throw new Error(`Runtime delivery envelope taskRefs[${index}] must be a string or TaskRef`);
  }
  return {
    taskId: requireRuntimeTaskRefString(value.taskId, `taskRefs[${index}].taskId`),
    displayId: requireRuntimeTaskRefString(value.displayId, `taskRefs[${index}].displayId`),
    teamName: requireRuntimeTaskRefString(value.teamName, `taskRefs[${index}].teamName`),
  };
}

function requireRuntimeTaskRefString(value: unknown, fieldName: string): string {
  if (typeof value !== 'string' || value.trim().length === 0) {
    throw new Error(`Runtime delivery envelope missing ${fieldName}`);
  }
  return value.trim();
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
