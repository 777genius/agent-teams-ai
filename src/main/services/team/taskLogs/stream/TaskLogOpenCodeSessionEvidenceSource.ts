import { readdir } from 'node:fs/promises';
import * as path from 'node:path';

import {
  createOpenCodePromptDeliveryLedgerStore,
  getLatestOpenCodeRuntimePromptMessageId,
  type OpenCodePromptDeliveryLedgerRecord,
} from '../../opencode/delivery/OpenCodePromptDeliveryLedger';
import {
  getOpenCodeLaneScopedRuntimeFilePath,
  getOpenCodeTeamRuntimeDirectory,
  readOpenCodeRuntimeLaneIndex,
} from '../../opencode/store/OpenCodeRuntimeManifestEvidenceReader';

import type { OpenCodeTaskLogAttributionRecord } from './OpenCodeTaskLogAttributionStore';
import type { TeamTask } from '@shared/types';

const OPENCODE_PROMPT_DELIVERY_LEDGER_FILE = 'opencode-prompt-delivery-ledger.json';
const OPENCODE_TEAM_RUNTIME_LANES_DIR = 'lanes';
const MAX_LEDGER_FILES_TO_SCAN = 48;
const MAX_RECORDS_PER_LEDGER = 96;
const MAX_EVIDENCE_RECORDS = 3;
const TERMINAL_EVIDENCE_GRACE_MS = 5 * 60_000;

interface TaskLogOpenCodeSessionEvidenceSourceOptions {
  teamsBasePath: string;
  maxLedgerFilesToScan?: number;
  maxRecordsPerLedger?: number;
  maxEvidenceRecords?: number;
}

export interface OpenCodeTaskLogSessionEvidenceReader {
  readTaskRecords(teamName: string, task: TeamTask): Promise<OpenCodeTaskLogAttributionRecord[]>;
}

function normalizeTaskRef(value: unknown): string | null {
  if (typeof value !== 'string' && typeof value !== 'number') {
    return null;
  }
  const normalized = String(value).trim().replace(/^#/, '').toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function buildTaskRefSet(task: TeamTask): Set<string> {
  return new Set(
    [task.id, task.displayId, task.sourceMessageId]
      .map(normalizeTaskRef)
      .filter((value): value is string => value !== null)
  );
}

function parseTimestampMs(value: string | null | undefined): number {
  if (!value) {
    return 0;
  }
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function minTimestampIso(values: (string | null | undefined)[]): string | undefined {
  const times = values.map(parseTimestampMs).filter((value) => Number.isFinite(value) && value > 0);
  if (times.length === 0) {
    return undefined;
  }
  return new Date(Math.min(...times)).toISOString();
}

function maxTimestampIso(values: (string | null | undefined)[]): string | undefined {
  const times = values.map(parseTimestampMs).filter((value) => Number.isFinite(value) && value > 0);
  if (times.length === 0) {
    return undefined;
  }
  return new Date(Math.max(...times)).toISOString();
}

function addMsToIso(value: string | undefined, deltaMs: number): string | undefined {
  if (!value) {
    return undefined;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return undefined;
  }
  return new Date(timestamp + deltaMs).toISOString();
}

function recordReferencesTask(
  record: OpenCodePromptDeliveryLedgerRecord,
  taskRefs: Set<string>,
  task: TeamTask
): boolean {
  if (task.sourceMessageId && record.inboxMessageId === task.sourceMessageId) {
    return true;
  }
  return record.taskRefs.some((ref) => {
    const taskId = normalizeTaskRef(ref.taskId);
    const displayId = normalizeTaskRef(ref.displayId);
    return Boolean((taskId && taskRefs.has(taskId)) || (displayId && taskRefs.has(displayId)));
  });
}

function isTerminalTask(task: TeamTask): boolean {
  return task.status === 'completed' || task.status === 'pending' || task.status === 'deleted';
}

function shouldUseRecord(
  record: OpenCodePromptDeliveryLedgerRecord,
  teamName: string,
  task: TeamTask,
  taskRefs: Set<string>
): boolean {
  return (
    record.teamName === teamName &&
    Boolean(record.runtimeSessionId?.trim()) &&
    !(record.status === 'failed_terminal' && !record.acceptedAt) &&
    recordReferencesTask(record, taskRefs, task)
  );
}

function recordSortTimestamp(record: OpenCodePromptDeliveryLedgerRecord): number {
  return Math.max(
    parseTimestampMs(record.respondedAt),
    parseTimestampMs(record.lastObservedAt),
    parseTimestampMs(record.acceptedAt),
    parseTimestampMs(record.lastAttemptAt),
    parseTimestampMs(record.inboxTimestamp),
    parseTimestampMs(record.updatedAt),
    parseTimestampMs(record.createdAt),
    0
  );
}

function toAttributionRecord(
  record: OpenCodePromptDeliveryLedgerRecord,
  task: TeamTask
): OpenCodeTaskLogAttributionRecord | null {
  const sessionId = record.runtimeSessionId?.trim();
  const memberName = record.memberName.trim();
  if (!sessionId || !memberName) {
    return null;
  }

  const since = minTimestampIso([
    record.inboxTimestamp,
    record.acceptedAt,
    record.lastAttemptAt,
    record.createdAt,
  ]);
  const terminalUntil = isTerminalTask(task)
    ? maxTimestampIso([task.updatedAt, record.respondedAt, record.lastObservedAt, record.updatedAt])
    : undefined;
  const fallbackUntil =
    record.status === 'responded' || record.status === 'failed_terminal'
      ? maxTimestampIso([
          record.respondedAt,
          record.lastObservedAt,
          record.failedAt,
          record.updatedAt,
        ])
      : undefined;
  const until = addMsToIso(terminalUntil ?? fallbackUntil, TERMINAL_EVIDENCE_GRACE_MS);
  const startMessageUuid =
    record.deliveredUserMessageId?.trim() ||
    getLatestOpenCodeRuntimePromptMessageId(record) ||
    undefined;

  return {
    taskId: task.id,
    memberName,
    scope: 'member_session_window',
    laneId: record.laneId.trim(),
    sessionId,
    source: 'delivery_ledger',
    ...(since ? { since } : {}),
    ...(until ? { until } : {}),
    ...(startMessageUuid ? { startMessageUuid } : {}),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

async function mapWithConcurrency<TInput, TOutput>(
  inputs: readonly TInput[],
  concurrency: number,
  mapper: (input: TInput) => Promise<TOutput>
): Promise<TOutput[]> {
  const results: TOutput[] = [];
  let index = 0;
  const workerCount = Math.max(1, Math.min(concurrency, inputs.length));
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (index < inputs.length) {
        const currentIndex = index;
        index += 1;
        results[currentIndex] = await mapper(inputs[currentIndex]);
      }
    })
  );
  return results;
}

export class TaskLogOpenCodeSessionEvidenceSource implements OpenCodeTaskLogSessionEvidenceReader {
  private readonly teamsBasePath: string;
  private readonly maxLedgerFilesToScan: number;
  private readonly maxRecordsPerLedger: number;
  private readonly maxEvidenceRecords: number;

  constructor(options: TaskLogOpenCodeSessionEvidenceSourceOptions) {
    this.teamsBasePath = options.teamsBasePath;
    this.maxLedgerFilesToScan = options.maxLedgerFilesToScan ?? MAX_LEDGER_FILES_TO_SCAN;
    this.maxRecordsPerLedger = options.maxRecordsPerLedger ?? MAX_RECORDS_PER_LEDGER;
    this.maxEvidenceRecords = options.maxEvidenceRecords ?? MAX_EVIDENCE_RECORDS;
  }

  async readTaskRecords(
    teamName: string,
    task: TeamTask
  ): Promise<OpenCodeTaskLogAttributionRecord[]> {
    const taskRefs = buildTaskRefSet(task);
    if (taskRefs.size === 0) {
      return [];
    }

    const ledgerPaths = await this.discoverLedgerPaths(teamName);
    if (ledgerPaths.length === 0) {
      return [];
    }

    const recordBatches = await mapWithConcurrency(ledgerPaths, 4, async (filePath) =>
      this.readLedgerRecords(filePath)
    );
    const records = recordBatches
      .flat()
      .filter((record) => shouldUseRecord(record, teamName, task, taskRefs))
      .sort((left, right) => recordSortTimestamp(right) - recordSortTimestamp(left));

    const seen = new Set<string>();
    const result: OpenCodeTaskLogAttributionRecord[] = [];
    for (const record of records) {
      const sessionId = record.runtimeSessionId?.trim();
      if (!sessionId) {
        continue;
      }
      const key = [
        record.memberName.trim().toLowerCase(),
        record.laneId.trim(),
        sessionId,
        record.deliveredUserMessageId ??
          getLatestOpenCodeRuntimePromptMessageId(record) ??
          record.inboxMessageId,
      ].join('::');
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      const attributionRecord = toAttributionRecord(record, task);
      if (!attributionRecord) {
        continue;
      }
      result.push(attributionRecord);
      if (result.length >= this.maxEvidenceRecords) {
        break;
      }
    }

    return result;
  }

  private async discoverLedgerPaths(teamName: string): Promise<string[]> {
    const ledgerPaths = new Set<string>();
    const runtimeDir = getOpenCodeTeamRuntimeDirectory(this.teamsBasePath, teamName);
    const lanesDir = path.join(runtimeDir, OPENCODE_TEAM_RUNTIME_LANES_DIR);
    const laneDirs = await readdir(lanesDir, { withFileTypes: true }).catch(() => []);
    for (const entry of laneDirs) {
      if (!entry.isDirectory()) {
        continue;
      }
      ledgerPaths.add(path.join(lanesDir, entry.name, OPENCODE_PROMPT_DELIVERY_LEDGER_FILE));
      if (ledgerPaths.size >= this.maxLedgerFilesToScan) {
        break;
      }
    }

    const laneIndex = await readOpenCodeRuntimeLaneIndex(this.teamsBasePath, teamName).catch(
      () => null
    );
    for (const laneId of Object.keys(laneIndex?.lanes ?? {})) {
      if (ledgerPaths.size >= this.maxLedgerFilesToScan) {
        break;
      }
      ledgerPaths.add(
        getOpenCodeLaneScopedRuntimeFilePath({
          teamsBasePath: this.teamsBasePath,
          teamName,
          laneId,
          fileName: OPENCODE_PROMPT_DELIVERY_LEDGER_FILE,
        })
      );
    }

    return Array.from(ledgerPaths);
  }

  private async readLedgerRecords(filePath: string): Promise<OpenCodePromptDeliveryLedgerRecord[]> {
    const store = createOpenCodePromptDeliveryLedgerStore({ filePath });
    return await store
      .list()
      .then((records) => records.slice(-this.maxRecordsPerLedger))
      .catch(() => []);
  }
}
