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
    const statePath = this.getStatePath(teamName);

    let raw: string;
    try {
      const stat = await fs.promises.stat(statePath);
      if (!stat.isFile() || stat.size > MAX_KANBAN_STATE_BYTES) {
        return createDefaultState(teamName);
      }
      raw = await readFileUtf8WithTimeout(statePath, 5_000);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return createDefaultState(teamName);
      }
      if (error instanceof FileReadTimeoutError) {
        return createDefaultState(teamName);
      }
      throw error;
    }

    let parsed: Partial<KanbanState>;
    try {
      parsed = JSON.parse(raw) as Partial<KanbanState>;
    } catch {
      return createDefaultState(teamName);
    }
    const sanitizedTasks: KanbanState['tasks'] = {};
    if (parsed.tasks && typeof parsed.tasks === 'object') {
      for (const [taskId, value] of Object.entries(parsed.tasks)) {
        if (!value || typeof value !== 'object') {
          continue;
        }

        const candidate = value as Partial<KanbanState['tasks'][string]>;
        if (!isValidColumn(candidate.column) || typeof candidate.movedAt !== 'string') {
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

    return {
      teamName,
      reviewers: Array.isArray(parsed.reviewers)
        ? parsed.reviewers.filter((r): r is string => typeof r === 'string' && r.trim().length > 0)
        : [],
      tasks: sanitizedTasks,
      columnOrder: sanitizeColumnOrder(parsed.columnOrder),
    };
  }

  async updateColumnOrder(
    teamName: string,
    columnId: KanbanColumnId,
    orderedTaskIds: string[]
  ): Promise<void> {
    const state = await this.getState(teamName);
    const columnOrder = { ...state.columnOrder };
    if (orderedTaskIds.length > 0) {
      columnOrder[columnId] = orderedTaskIds;
    } else {
      delete columnOrder[columnId];
    }
    await this.writeState(teamName, { ...state, columnOrder });
  }

  async updateTask(teamName: string, taskId: string, patch: UpdateKanbanPatch): Promise<void> {
    const state = await this.getState(teamName);

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

    await this.writeState(teamName, state);
  }

  async garbageCollect(teamName: string, validTaskIds: Set<string>): Promise<void> {
    const state = await this.getState(teamName);
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
    await this.writeState(teamName, state);
  }

  private getStatePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'kanban-state.json');
  }

  private async writeState(teamName: string, state: KanbanState): Promise<void> {
    const statePath = this.getStatePath(teamName);
    const payload: KanbanState = {
      teamName,
      reviewers: state.reviewers,
      tasks: state.tasks,
      ...(state.columnOrder && Object.keys(state.columnOrder).length > 0
        ? { columnOrder: state.columnOrder }
        : {}),
    };
    await atomicWriteAsync(statePath, JSON.stringify(payload, null, 2));
  }
}
