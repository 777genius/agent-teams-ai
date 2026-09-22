import { OpenCodeTaskLogAttributionStore } from './OpenCodeTaskLogAttributionStore';

import type {
  OpenCodeTaskLogAttributionRecord,
  OpenCodeTaskLogAttributionScope,
  OpenCodeTaskLogAttributionSource,
  OpenCodeTaskLogAttributionWriteResult,
} from './OpenCodeTaskLogAttributionStore';

export interface OpenCodeTaskLogAttributionWriter {
  upsertTaskRecord(
    teamName: string,
    record: OpenCodeTaskLogAttributionRecord,
    options?: { now?: Date }
  ): Promise<OpenCodeTaskLogAttributionWriteResult>;
  replaceTaskRecords(
    teamName: string,
    taskId: string,
    records: OpenCodeTaskLogAttributionRecord[],
    options?: { now?: Date }
  ): Promise<OpenCodeTaskLogAttributionWriteResult>;
  clearTaskRecords(
    teamName: string,
    taskId: string
  ): Promise<OpenCodeTaskLogAttributionWriteResult>;
}

export interface OpenCodeTaskLogAttributionRecordDraft {
  memberName: string;
  scope?: OpenCodeTaskLogAttributionScope;
  sessionId?: string;
  since?: string | Date;
  until?: string | Date;
  startMessageUuid?: string;
  endMessageUuid?: string;
  source?: OpenCodeTaskLogAttributionSource;
}

export interface OpenCodeTaskLogAttributionTaskSessionInput {
  teamName: string;
  taskId: string;
  memberName: string;
  sessionId: string;
  since?: string | Date;
  until?: string | Date;
  startMessageUuid?: string;
  endMessageUuid?: string;
  source?: OpenCodeTaskLogAttributionSource;
}

export interface OpenCodeTaskLogAttributionMemberWindowInput {
  teamName: string;
  taskId: string;
  memberName: string;
  sessionId?: string;
  since?: string | Date;
  until?: string | Date;
  startMessageUuid?: string;
  endMessageUuid?: string;
  source?: OpenCodeTaskLogAttributionSource;
}

export interface OpenCodeTaskLogAttributionReplaceInput {
  teamName: string;
  taskId: string;
  records: OpenCodeTaskLogAttributionRecordDraft[];
  source?: OpenCodeTaskLogAttributionSource;
}

export interface OpenCodeTaskLogAttributionTaskInput {
  teamName: string;
  taskId: string;
}

export interface OpenCodeTaskLogAttributionRecordWriteOutcome {
  result: OpenCodeTaskLogAttributionWriteResult;
  record: OpenCodeTaskLogAttributionRecord;
}

export interface OpenCodeTaskLogAttributionBulkWriteOutcome {
  result: OpenCodeTaskLogAttributionWriteResult;
  recordCount: number;
}

const VALID_SOURCES = new Set<OpenCodeTaskLogAttributionSource>([
  'manual',
  'launch_runtime',
  'reconcile',
]);
const TEAM_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,127}$/;
const TASK_ID_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9-]{0,63}$/;
const MEMBER_NAME_PATTERN = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,127}$/;
const MAX_RUNTIME_ID_LENGTH = 256;

function trimOptionalString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function requireString(field: string, value: unknown): string {
  const trimmed = trimOptionalString(value);
  if (!trimmed) {
    throw new Error(`OpenCode task-log attribution ${field} is required`);
  }
  return trimmed;
}

function requirePatternString(field: string, value: unknown, pattern: RegExp): string {
  const trimmed = requireString(field, value);
  if (!pattern.test(trimmed)) {
    throw new Error(`OpenCode task-log attribution ${field} contains invalid characters`);
  }
  return trimmed;
}

function trimRuntimeId(field: string, value: unknown): string | undefined {
  const trimmed = trimOptionalString(value);
  if (!trimmed) {
    return undefined;
  }
  if (trimmed.length > MAX_RUNTIME_ID_LENGTH) {
    throw new Error(
      `OpenCode task-log attribution ${field} exceeds max length (${MAX_RUNTIME_ID_LENGTH})`
    );
  }
  return trimmed;
}

function normalizeIso(field: string, value: string | Date | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }

  const timestamp =
    value instanceof Date ? value.getTime() : Date.parse(requireString(field, value));
  if (!Number.isFinite(timestamp)) {
    throw new Error(`OpenCode task-log attribution ${field} must be a valid timestamp`);
  }

  return new Date(timestamp).toISOString();
}

function normalizeScope(
  value: OpenCodeTaskLogAttributionScope | undefined
): OpenCodeTaskLogAttributionScope {
  if (value === undefined) {
    return 'member_session_window';
  }
  if (value === 'task_session' || value === 'member_session_window') {
    return value;
  }
  throw new Error('OpenCode task-log attribution scope is invalid');
}

function normalizeSource(
  value: OpenCodeTaskLogAttributionSource | undefined,
  fallback: OpenCodeTaskLogAttributionSource
): OpenCodeTaskLogAttributionSource {
  const source = value ?? fallback;
  if (!VALID_SOURCES.has(source)) {
    throw new Error('OpenCode task-log attribution source is invalid');
  }
  return source;
}

function assertRecordPolicy(record: OpenCodeTaskLogAttributionRecord): void {
  if (record.since && record.until && Date.parse(record.since) > Date.parse(record.until)) {
    throw new Error('OpenCode task-log attribution since must be before or equal to until');
  }

  if (record.scope === 'task_session') {
    if (!record.sessionId) {
      throw new Error('OpenCode task-log attribution task_session requires sessionId');
    }
    return;
  }

  if (!record.since && !record.startMessageUuid) {
    throw new Error(
      'OpenCode task-log attribution member_session_window requires since or startMessageUuid'
    );
  }
}

function buildRecord(
  taskId: string,
  draft: OpenCodeTaskLogAttributionRecordDraft,
  fallbackSource: OpenCodeTaskLogAttributionSource
): OpenCodeTaskLogAttributionRecord {
  const sessionId = trimRuntimeId('sessionId', draft.sessionId);
  const since = normalizeIso('since', draft.since);
  const until = normalizeIso('until', draft.until);
  const startMessageUuid = trimRuntimeId('startMessageUuid', draft.startMessageUuid);
  const endMessageUuid = trimRuntimeId('endMessageUuid', draft.endMessageUuid);
  const record: OpenCodeTaskLogAttributionRecord = {
    taskId: requirePatternString('taskId', taskId, TASK_ID_PATTERN),
    memberName: requirePatternString('memberName', draft.memberName, MEMBER_NAME_PATTERN),
    scope: normalizeScope(draft.scope),
    ...(sessionId ? { sessionId } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(startMessageUuid ? { startMessageUuid } : {}),
    ...(endMessageUuid ? { endMessageUuid } : {}),
    source: normalizeSource(draft.source, fallbackSource),
  };
  assertRecordPolicy(record);
  return record;
}

export class OpenCodeTaskLogAttributionService {
  constructor(
    private readonly writer: OpenCodeTaskLogAttributionWriter = new OpenCodeTaskLogAttributionStore(),
    private readonly now: () => Date = () => new Date()
  ) {}

  async recordTaskSession(
    input: OpenCodeTaskLogAttributionTaskSessionInput
  ): Promise<OpenCodeTaskLogAttributionRecordWriteOutcome> {
    const teamName = requirePatternString('teamName', input.teamName, TEAM_NAME_PATTERN);
    const record = buildRecord(
      requireString('taskId', input.taskId),
      {
        memberName: input.memberName,
        scope: 'task_session',
        sessionId: input.sessionId,
        since: input.since,
        until: input.until,
        startMessageUuid: input.startMessageUuid,
        endMessageUuid: input.endMessageUuid,
        source: input.source,
      },
      'launch_runtime'
    );

    return {
      result: await this.writer.upsertTaskRecord(teamName, record, { now: this.now() }),
      record,
    };
  }

  async recordMemberSessionWindow(
    input: OpenCodeTaskLogAttributionMemberWindowInput
  ): Promise<OpenCodeTaskLogAttributionRecordWriteOutcome> {
    const teamName = requirePatternString('teamName', input.teamName, TEAM_NAME_PATTERN);
    const record = buildRecord(
      requireString('taskId', input.taskId),
      {
        memberName: input.memberName,
        scope: 'member_session_window',
        sessionId: input.sessionId,
        since: input.since,
        until: input.until,
        startMessageUuid: input.startMessageUuid,
        endMessageUuid: input.endMessageUuid,
        source: input.source,
      },
      'reconcile'
    );

    return {
      result: await this.writer.upsertTaskRecord(teamName, record, { now: this.now() }),
      record,
    };
  }

  async replaceTaskAttribution(
    input: OpenCodeTaskLogAttributionReplaceInput
  ): Promise<OpenCodeTaskLogAttributionBulkWriteOutcome> {
    const teamName = requirePatternString('teamName', input.teamName, TEAM_NAME_PATTERN);
    const taskId = requirePatternString('taskId', input.taskId, TASK_ID_PATTERN);
    const fallbackSource = normalizeSource(input.source, 'reconcile');
    const records = input.records.map((record) => buildRecord(taskId, record, fallbackSource));

    return {
      result: await this.writer.replaceTaskRecords(teamName, taskId, records, { now: this.now() }),
      recordCount: records.length,
    };
  }

  async clearTaskAttribution(
    input: OpenCodeTaskLogAttributionTaskInput
  ): Promise<OpenCodeTaskLogAttributionBulkWriteOutcome> {
    const teamName = requirePatternString('teamName', input.teamName, TEAM_NAME_PATTERN);
    const taskId = requirePatternString('taskId', input.taskId, TASK_ID_PATTERN);

    return {
      result: await this.writer.clearTaskRecords(teamName, taskId),
      recordCount: 0,
    };
  }
}
