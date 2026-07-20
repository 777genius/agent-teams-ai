import { FileReadTimeoutError, readFileUtf8WithTimeout } from '@main/utils/fsRead';
import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { KANBAN_COLUMN_IDS } from '@shared/constants/kanban';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { KanbanColumnId, KanbanState, UpdateKanbanPatch } from '@shared/types';

const logger = createLogger('Service:TeamKanbanManager');
const MAX_KANBAN_STATE_BYTES = 512 * 1024;

type JsonRecord = Record<string, unknown>;

interface KanbanStateDocument {
  raw: JsonRecord;
  state: KanbanState;
}

const KANBAN_TASK_KNOWN_FIELDS = ['column', 'reviewer', 'errorDescription', 'movedAt'] as const;

function isJsonRecord(value: unknown): value is JsonRecord {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function replaceKnownFields(
  existing: JsonRecord | null,
  replacement: JsonRecord,
  knownFields: readonly string[]
): JsonRecord {
  const merged = { ...(existing ?? {}) };
  for (const field of knownFields) {
    delete merged[field];
  }
  return Object.assign(merged, replacement);
}

function createDefaultState(teamName: string): KanbanState {
  return {
    teamName,
    reviewers: [],
    tasks: {},
  };
}

function isValidColumn(value: unknown): value is 'review' | 'approved' {
  return value === 'review' || value === 'approved';
}

function sanitizeColumnOrder(raw: unknown): KanbanState['columnOrder'] | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const result: NonNullable<KanbanState['columnOrder']> = {};
  for (const colId of KANBAN_COLUMN_IDS) {
    const arr = (raw as Record<string, unknown>)[colId];
    if (Array.isArray(arr)) {
      const ids = arr.filter((id): id is string => typeof id === 'string');
      if (ids.length > 0) {
        result[colId] = ids;
      }
    }
  }
  return Object.keys(result).length > 0 ? result : undefined;
}

export class TeamKanbanManager {
  async getState(teamName: string): Promise<KanbanState> {
    const document = await this.readStateDocument(teamName);
    return document?.state ?? createDefaultState(teamName);
  }

  private async readStateDocument(
    teamName: string,
    options: { failClosed?: boolean } = {}
  ): Promise<KanbanStateDocument | null> {
    const statePath = this.getStatePath(teamName);
    let raw: string;
    try {
      const stat = await fs.promises.stat(statePath);
      if (!stat.isFile() || stat.size > MAX_KANBAN_STATE_BYTES) {
        if (options.failClosed) {
          throw new Error('Refusing to replace unsafe or oversized kanban state');
        }
        return null;
      }
      raw = await readFileUtf8WithTimeout(statePath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return null;
      }
      if (error instanceof FileReadTimeoutError) {
        if (!options.failClosed) {
          return null;
        }
      }
      throw error;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(raw) as unknown;
    } catch (error) {
      if (options.failClosed) {
        throw new Error('Refusing to replace malformed kanban state', { cause: error });
      }
      return null;
    }
    if (!isJsonRecord(parsed) || (parsed.version !== undefined && parsed.version !== 1)) {
      if (options.failClosed) {
        throw new Error('Refusing to replace unsupported kanban state');
      }
      return null;
    }
    if (
      (parsed.reviewers !== undefined && !Array.isArray(parsed.reviewers)) ||
      (parsed.tasks !== undefined && !isJsonRecord(parsed.tasks)) ||
      (parsed.columnOrder !== undefined && !isJsonRecord(parsed.columnOrder)) ||
      (parsed.teamName !== undefined && typeof parsed.teamName !== 'string')
    ) {
      if (options.failClosed) {
        throw new Error('Refusing to replace malformed kanban state');
      }
      return null;
    }

    const sanitizedTasks: KanbanState['tasks'] = {};
    if (isJsonRecord(parsed.tasks)) {
      for (const [taskId, value] of Object.entries(parsed.tasks)) {
        if (!isJsonRecord(value) || (options.failClosed && taskId.length === 0)) {
          if (options.failClosed) {
            throw new Error('Refusing to replace malformed kanban task state');
          }
          continue;
        }

        const candidate = value as Partial<KanbanState['tasks'][string]>;
        if (
          !isValidColumn(candidate.column) ||
          typeof candidate.movedAt !== 'string' ||
          (options.failClosed &&
            ((candidate.reviewer !== undefined &&
              candidate.reviewer !== null &&
              typeof candidate.reviewer !== 'string') ||
              (candidate.errorDescription !== undefined &&
                typeof candidate.errorDescription !== 'string')))
        ) {
          if (options.failClosed) {
            throw new Error('Refusing to replace malformed kanban task state');
          }
          continue;
        }

        sanitizedTasks[taskId] = {
          column: candidate.column,
          movedAt: candidate.movedAt,
          reviewer:
            typeof candidate.reviewer === 'string' || candidate.reviewer === null
              ? candidate.reviewer
              : undefined,
          errorDescription:
            typeof candidate.errorDescription === 'string' ? candidate.errorDescription : undefined,
        };
      }
    }

    if (options.failClosed && parsed.teamName !== undefined && parsed.teamName !== teamName) {
      throw new Error('Refusing to replace mismatched kanban state');
    }
    if (
      options.failClosed &&
      Array.isArray(parsed.reviewers) &&
      parsed.reviewers.some(
        (reviewer) => typeof reviewer !== 'string' || reviewer.trim().length === 0
      )
    ) {
      throw new Error('Refusing to replace malformed kanban reviewers');
    }
    if (options.failClosed && isJsonRecord(parsed.columnOrder)) {
      for (const colId of KANBAN_COLUMN_IDS) {
        const ids = parsed.columnOrder[colId];
        if (
          ids !== undefined &&
          (!Array.isArray(ids) ||
            ids.some((taskId) => typeof taskId !== 'string' || taskId.length === 0))
        ) {
          throw new Error('Refusing to replace malformed kanban column order');
        }
      }
    }

    return {
      raw: parsed,
      state: {
        teamName,
        reviewers: Array.isArray(parsed.reviewers)
          ? parsed.reviewers.filter(
              (reviewer): reviewer is string =>
                typeof reviewer === 'string' && reviewer.trim().length > 0
            )
          : [],
        tasks: sanitizedTasks,
        columnOrder: sanitizeColumnOrder(parsed.columnOrder),
      },
    };
  }

  async updateColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    const document = await this.readStateDocument(teamName, { failClosed: true });
    const state = document?.state ?? createDefaultState(teamName);
    const columnOrder = { ...state.columnOrder };
    if (orderedTaskIds.length > 0) {
      columnOrder[columnId] = orderedTaskIds;
    } else {
      delete columnOrder[columnId];
    }
    await this.writeState(teamName, { ...state, columnOrder }, document?.raw);
  }

  async updateTask(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    const document = await this.readStateDocument(teamName, { failClosed: true });
    const state = document?.state ?? createDefaultState(teamName);

    if (patch.op === 'remove' || patch.op === 'request_changes') {
      delete state.tasks[taskId];
    } else if (patch.column === 'review') {
      state.tasks[taskId] = {
        column: 'review',
        reviewer: null,
        movedAt: new Date().toISOString(),
      };
    } else {
      state.tasks[taskId] = {
        column: 'approved',
        movedAt: new Date().toISOString(),
      };
    }

    await this.writeState(teamName, state, document?.raw);
  }

  async garbageCollect(teamName: string, validTaskIds: Set<string>): Promise<void> {
    const document = await this.readStateDocument(teamName, { failClosed: true });
    const state = document?.state ?? createDefaultState(teamName);
    const before = Object.keys(state.tasks).length;

    for (const taskId of Object.keys(state.tasks)) {
      if (!validTaskIds.has(taskId)) {
        delete state.tasks[taskId];
      }
    }

    let columnOrderChanged = false;
    if (state.columnOrder) {
      const cleaned: NonNullable<KanbanState['columnOrder']> = {};
      for (const [colId, ids] of Object.entries(state.columnOrder)) {
        const valid = ids.filter((id) => validTaskIds.has(id));
        if (valid.length > 0) {
          cleaned[colId as KanbanColumnId] = valid;
        }
        if (valid.length !== ids.length) {
          columnOrderChanged = true;
        }
      }
      if (columnOrderChanged) {
        state.columnOrder = Object.keys(cleaned).length > 0 ? cleaned : undefined;
      }
    }

    const after = Object.keys(state.tasks).length;
    const tasksChanged = before !== after;
    if (!tasksChanged && !columnOrderChanged) {
      return;
    }

    if (tasksChanged) {
      logger.debug(`Removed ${before - after} stale kanban entries for team ${teamName}`);
    }
    await this.writeState(teamName, state, document?.raw);
  }

  private getStatePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'kanban-state.json');
  }

  private async writeState(
    teamName: string,
    state: KanbanState,
    existing: JsonRecord | null = null
  ): Promise<void> {
    const statePath = this.getStatePath(teamName);
    const existingTasks = isJsonRecord(existing?.tasks) ? existing.tasks : {};
    const tasks = Object.fromEntries(
      Object.entries(state.tasks).map(([taskId, task]) => [
        taskId,
        replaceKnownFields(
          isJsonRecord(existingTasks[taskId]) ? existingTasks[taskId] : null,
          task as unknown as JsonRecord,
          KANBAN_TASK_KNOWN_FIELDS
        ),
      ])
    );
    const knownPayload: JsonRecord = {
      teamName,
      reviewers: state.reviewers,
      tasks,
    };
    const existingColumnOrder = isJsonRecord(existing?.columnOrder) ? existing.columnOrder : null;
    const mergedColumnOrder = replaceKnownFields(
      existingColumnOrder,
      (state.columnOrder ?? {}) as JsonRecord,
      KANBAN_COLUMN_IDS
    );
    if (Object.keys(mergedColumnOrder).length > 0) {
      knownPayload.columnOrder = mergedColumnOrder;
    }
    const payload = replaceKnownFields(existing, knownPayload, [
      'teamName',
      'reviewers',
      'tasks',
      'columnOrder',
    ]);
    await atomicWriteAsync(statePath, JSON.stringify(payload, null, 2));
  }
}
