import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { OPENCODE_TASK_LOG_ATTRIBUTION_FILE } from '@shared/constants/opencodeTaskLogAttribution';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from '../../atomicWrite';
import { withFileLock } from '../../fileLock';

const logger = createLogger('OpenCodeTaskLogAttributionStore');

const MAX_ATTRIBUTION_FILE_BYTES = 512 * 1024;

export type OpenCodeTaskLogAttributionScope = 'task_session' | 'member_session_window';
export type OpenCodeTaskLogAttributionSource = 'manual' | 'launch_runtime' | 'reconcile';

export interface OpenCodeTaskLogAttributionRecord {
  taskId: string;
  memberName: string;
  scope: OpenCodeTaskLogAttributionScope;
  sessionId?: string;
  since?: string;
  until?: string;
  startMessageUuid?: string;
  endMessageUuid?: string;
  source?: OpenCodeTaskLogAttributionSource;
  createdAt?: string;
  updatedAt?: string;
}

interface RawAttributionRecord extends Record<string, unknown> {
  taskId?: unknown;
}

interface OpenCodeTaskLogAttributionFile {
  schemaVersion: 1;
  tasks: Record<string, OpenCodeTaskLogAttributionRecord[]>;
}

export type OpenCodeTaskLogAttributionWriteResult = 'created' | 'updated' | 'unchanged' | 'deleted';

export interface OpenCodeTaskLogAttributionReader {
  readTaskRecords(teamName: string, taskId: string): Promise<OpenCodeTaskLogAttributionRecord[]>;
}

function trimString(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function normalizeIso(value: unknown): string | undefined {
  const trimmed = trimString(value);
  if (!trimmed) {
    return undefined;
  }
  const parsed = Date.parse(trimmed);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : undefined;
}

function normalizeScope(value: unknown): OpenCodeTaskLogAttributionScope {
  return value === 'task_session' ? 'task_session' : 'member_session_window';
}

function normalizeSource(value: unknown): OpenCodeTaskLogAttributionSource | undefined {
  return value === 'manual' || value === 'launch_runtime' || value === 'reconcile'
    ? value
    : undefined;
}

function normalizeRecord(
  taskId: string,
  raw: RawAttributionRecord
): OpenCodeTaskLogAttributionRecord | null {
  const memberName = trimString(raw.memberName);
  if (!memberName) {
    return null;
  }

  const since = normalizeIso(raw.since);
  const until = normalizeIso(raw.until);
  if (since && until && Date.parse(since) > Date.parse(until)) {
    return null;
  }
  const sessionId = trimString(raw.sessionId);
  const startMessageUuid = trimString(raw.startMessageUuid);
  const endMessageUuid = trimString(raw.endMessageUuid);
  const source = normalizeSource(raw.source);
  const createdAt = normalizeIso(raw.createdAt);
  const updatedAt = normalizeIso(raw.updatedAt);

  return {
    taskId,
    memberName,
    scope: normalizeScope(raw.scope),
    ...(sessionId ? { sessionId } : {}),
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(startMessageUuid ? { startMessageUuid } : {}),
    ...(endMessageUuid ? { endMessageUuid } : {}),
    ...(source ? { source } : {}),
    ...(createdAt ? { createdAt } : {}),
    ...(updatedAt ? { updatedAt } : {}),
  };
}

function extractRawRecords(parsed: unknown, taskId: string): RawAttributionRecord[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const file = parsed as Record<string, unknown>;
  if (file.schemaVersion !== 1) {
    return [];
  }

  const rawRecords: RawAttributionRecord[] = [];
  if (file.tasks && typeof file.tasks === 'object' && !Array.isArray(file.tasks)) {
    const taskRecords = (file.tasks as Record<string, unknown>)[taskId];
    if (Array.isArray(taskRecords)) {
      for (const record of taskRecords) {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          rawRecords.push(record as RawAttributionRecord);
        }
      }
    }
  }

  if (Array.isArray(file.records)) {
    for (const record of file.records) {
      if (!record || typeof record !== 'object' || Array.isArray(record)) {
        continue;
      }
      const raw = record as RawAttributionRecord;
      if (trimString(raw.taskId) === taskId) {
        rawRecords.push(raw);
      }
    }
  }

  return rawRecords;
}

function extractAllRawRecords(parsed: unknown): RawAttributionRecord[] {
  if (!parsed || typeof parsed !== 'object') {
    return [];
  }

  const file = parsed as Record<string, unknown>;
  if (file.schemaVersion !== 1) {
    return [];
  }

  const rawRecords: RawAttributionRecord[] = [];
  if (file.tasks && typeof file.tasks === 'object' && !Array.isArray(file.tasks)) {
    for (const [taskId, taskRecords] of Object.entries(file.tasks as Record<string, unknown>)) {
      if (!Array.isArray(taskRecords)) {
        continue;
      }
      for (const record of taskRecords) {
        if (record && typeof record === 'object' && !Array.isArray(record)) {
          rawRecords.push({
            ...(record as RawAttributionRecord),
            taskId,
          });
        }
      }
    }
  }

  if (Array.isArray(file.records)) {
    for (const record of file.records) {
      if (record && typeof record === 'object' && !Array.isArray(record)) {
        rawRecords.push(record as RawAttributionRecord);
      }
    }
  }

  return rawRecords;
}

function dedupeRecords(
  records: OpenCodeTaskLogAttributionRecord[]
): OpenCodeTaskLogAttributionRecord[] {
  const deduped = new Map<string, OpenCodeTaskLogAttributionRecord>();
  for (const record of records) {
    deduped.set(
      [
        record.taskId,
        record.memberName.trim().toLowerCase(),
        record.scope,
        record.sessionId ?? '',
        record.since ?? '',
        record.until ?? '',
        record.startMessageUuid ?? '',
        record.endMessageUuid ?? '',
      ].join('\0'),
      record
    );
  }
  return Array.from(deduped.values()).sort((left, right) => {
    const leftStart = left.since ?? left.createdAt ?? '';
    const rightStart = right.since ?? right.createdAt ?? '';
    if (leftStart !== rightStart) {
      return leftStart.localeCompare(rightStart);
    }
    return left.memberName.localeCompare(right.memberName);
  });
}

function buildUpsertKey(record: OpenCodeTaskLogAttributionRecord): string {
  return JSON.stringify([
    record.taskId,
    record.memberName.trim().toLowerCase(),
    record.scope,
    record.sessionId ?? '',
    record.since ?? '',
    record.startMessageUuid ?? '',
  ]);
}

function canonicalizeFile(
  records: OpenCodeTaskLogAttributionRecord[]
): OpenCodeTaskLogAttributionFile {
  const byTask = new Map<string, OpenCodeTaskLogAttributionRecord[]>();
  for (const record of records) {
    const existing = byTask.get(record.taskId) ?? [];
    existing.push(record);
    byTask.set(record.taskId, existing);
  }

  const tasks: Record<string, OpenCodeTaskLogAttributionRecord[]> = {};
  for (const [taskId, taskRecords] of [...byTask.entries()].sort(([left], [right]) =>
    left.localeCompare(right)
  )) {
    const normalized = dedupeRecords(taskRecords);
    if (normalized.length > 0) {
      tasks[taskId] = normalized;
    }
  }

  return {
    schemaVersion: 1,
    tasks,
  };
}

function normalizeRecordForWrite(
  record: OpenCodeTaskLogAttributionRecord
): OpenCodeTaskLogAttributionRecord | null {
  return normalizeRecord(record.taskId, record as unknown as RawAttributionRecord);
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function stripAuditFields(
  record: OpenCodeTaskLogAttributionRecord
): Omit<OpenCodeTaskLogAttributionRecord, 'createdAt' | 'updatedAt'> {
  const { createdAt: _createdAt, updatedAt: _updatedAt, ...rest } = record;
  return rest;
}

export function getOpenCodeTaskLogAttributionPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, OPENCODE_TASK_LOG_ATTRIBUTION_FILE);
}

export class OpenCodeTaskLogAttributionStore implements OpenCodeTaskLogAttributionReader {
  private async readFileForWrite(filePath: string): Promise<OpenCodeTaskLogAttributionFile> {
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile()) {
        throw new Error(`OpenCode task-log attribution path is not a file: ${filePath}`);
      }
      if (stat.size > MAX_ATTRIBUTION_FILE_BYTES) {
        throw new Error(`OpenCode task-log attribution file is too large: ${filePath}`);
      }

      const raw = await readFileUtf8WithTimeout(filePath, 5_000);
      const parsed = JSON.parse(raw) as unknown;
      if (
        !parsed ||
        typeof parsed !== 'object' ||
        (parsed as { schemaVersion?: unknown }).schemaVersion !== 1
      ) {
        throw new Error(`Unsupported OpenCode task-log attribution schema: ${filePath}`);
      }

      return canonicalizeFile(
        extractAllRawRecords(parsed)
          .map((record) => {
            const taskId = trimString(record.taskId);
            return taskId ? normalizeRecord(taskId, record) : null;
          })
          .filter((record): record is OpenCodeTaskLogAttributionRecord => record !== null)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return { schemaVersion: 1, tasks: {} };
      }
      if (error instanceof SyntaxError) {
        throw new Error(`Invalid OpenCode task-log attribution JSON: ${filePath}`);
      }
      throw error;
    }
  }

  private async writeFileIfChanged(
    filePath: string,
    previous: OpenCodeTaskLogAttributionFile,
    next: OpenCodeTaskLogAttributionFile
  ): Promise<boolean> {
    if (sameJson(previous, next)) {
      return false;
    }

    await atomicWriteAsync(filePath, `${JSON.stringify(next, null, 2)}\n`);
    return true;
  }

  async readTaskRecords(
    teamName: string,
    taskId: string
  ): Promise<OpenCodeTaskLogAttributionRecord[]> {
    const filePath = getOpenCodeTaskLogAttributionPath(teamName);
    try {
      const stat = await fs.promises.stat(filePath);
      if (!stat.isFile() || stat.size > MAX_ATTRIBUTION_FILE_BYTES) {
        return [];
      }

      const raw = await readFileUtf8WithTimeout(filePath, 5_000);
      const parsed = JSON.parse(raw) as unknown;
      return dedupeRecords(
        extractRawRecords(parsed, taskId)
          .map((record) => normalizeRecord(taskId, record))
          .filter((record): record is OpenCodeTaskLogAttributionRecord => record !== null)
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      if (error instanceof SyntaxError) {
        logger.warn(`[${teamName}/${taskId}] invalid OpenCode task-log attribution JSON`);
        return [];
      }
      if (error instanceof FileReadTimeoutError) {
        logger.warn(`[${teamName}/${taskId}] OpenCode task-log attribution read timed out`);
        return [];
      }
      logger.warn(
        `[${teamName}/${taskId}] failed to read OpenCode task-log attribution: ${
          error instanceof Error ? error.message : String(error)
        }`
      );
      return [];
    }
  }

  async upsertTaskRecord(
    teamName: string,
    record: OpenCodeTaskLogAttributionRecord,
    options?: { now?: Date }
  ): Promise<OpenCodeTaskLogAttributionWriteResult> {
    const normalized = normalizeRecordForWrite(record);
    if (!normalized) {
      throw new Error('Invalid OpenCode task-log attribution record');
    }

    const filePath = getOpenCodeTaskLogAttributionPath(teamName);
    return withFileLock(filePath, async () => {
      const previous = await this.readFileForWrite(filePath);
      const now = (options?.now ?? new Date()).toISOString();
      const taskRecords = previous.tasks[normalized.taskId] ?? [];
      const targetKey = buildUpsertKey(normalized);
      const existingIndex = taskRecords.findIndex(
        (candidate) => buildUpsertKey(candidate) === targetKey
      );
      const existingRecord = existingIndex >= 0 ? taskRecords[existingIndex] : undefined;
      if (
        existingRecord &&
        sameJson(stripAuditFields(existingRecord), stripAuditFields(normalized))
      ) {
        return 'unchanged';
      }

      const nextRecord: OpenCodeTaskLogAttributionRecord = {
        ...normalized,
        createdAt: existingRecord?.createdAt ?? normalized.createdAt ?? now,
        updatedAt: now,
      };

      const nextTaskRecords =
        existingIndex >= 0
          ? taskRecords.map((candidate, index) =>
              index === existingIndex ? nextRecord : candidate
            )
          : [...taskRecords, nextRecord];
      const next = canonicalizeFile([
        ...Object.entries(previous.tasks).flatMap(([taskId, records]) =>
          taskId === normalized.taskId ? [] : records
        ),
        ...nextTaskRecords,
      ]);
      const changed = await this.writeFileIfChanged(filePath, previous, next);
      if (!changed) {
        return 'unchanged';
      }
      return existingIndex >= 0 ? 'updated' : 'created';
    });
  }

  async replaceTaskRecords(
    teamName: string,
    taskId: string,
    records: OpenCodeTaskLogAttributionRecord[],
    options?: { now?: Date }
  ): Promise<OpenCodeTaskLogAttributionWriteResult> {
    const normalizedTaskId = trimString(taskId);
    if (!normalizedTaskId) {
      throw new Error('Invalid OpenCode task-log attribution task id');
    }

    const now = (options?.now ?? new Date()).toISOString();
    const normalizedRecords = records.map((record) =>
      normalizeRecordForWrite({
        ...record,
        taskId: normalizedTaskId,
        createdAt: record.createdAt ?? now,
        updatedAt: record.updatedAt ?? now,
      })
    );
    if (normalizedRecords.some((record) => record === null)) {
      throw new Error('Invalid OpenCode task-log attribution record');
    }
    const validRecords = normalizedRecords as OpenCodeTaskLogAttributionRecord[];

    const filePath = getOpenCodeTaskLogAttributionPath(teamName);
    return withFileLock(filePath, async () => {
      const previous = await this.readFileForWrite(filePath);
      const next = canonicalizeFile([
        ...Object.entries(previous.tasks).flatMap(([candidateTaskId, taskRecords]) =>
          candidateTaskId === normalizedTaskId ? [] : taskRecords
        ),
        ...validRecords,
      ]);
      const changed = await this.writeFileIfChanged(filePath, previous, next);
      return changed ? 'updated' : 'unchanged';
    });
  }

  async clearTaskRecords(
    teamName: string,
    taskId: string
  ): Promise<OpenCodeTaskLogAttributionWriteResult> {
    const normalizedTaskId = trimString(taskId);
    if (!normalizedTaskId) {
      throw new Error('Invalid OpenCode task-log attribution task id');
    }

    const filePath = getOpenCodeTaskLogAttributionPath(teamName);
    return withFileLock(filePath, async () => {
      const previous = await this.readFileForWrite(filePath);
      if (!previous.tasks[normalizedTaskId]) {
        return 'unchanged';
      }

      const next = canonicalizeFile(
        Object.entries(previous.tasks).flatMap(([candidateTaskId, taskRecords]) =>
          candidateTaskId === normalizedTaskId ? [] : taskRecords
        )
      );
      await this.writeFileIfChanged(filePath, previous, next);
      return 'deleted';
    });
  }
}
