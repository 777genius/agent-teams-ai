import { getTeamsBasePath } from '@main/utils/pathDecoder';
import { createLogger } from '@shared/utils/logger';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';

import type { KanbanState, UpdateKanbanPatch } from '@shared/types';

const logger = createLogger('Service:TeamKanbanManager');

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

export class TeamKanbanManager {
  async getState(teamName: string): Promise<KanbanState> {
    const statePath = this.getStatePath(teamName);

    let raw: string;
    try {
      raw = await fs.promises.readFile(statePath, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
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
    };
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

    const after = Object.keys(state.tasks).length;
    if (before === after) {
      return;
    }

    logger.debug(`Removed ${before - after} stale kanban entries for team ${teamName}`);
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
    };
    await atomicWriteAsync(statePath, JSON.stringify(payload, null, 2));
  }
}
