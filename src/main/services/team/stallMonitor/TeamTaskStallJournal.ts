import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';

import type {
  TaskStallEvaluation,
  TaskStallJournalEntry,
  TaskStallJournalState,
} from './TeamTaskStallTypes';

function isValidState(value: unknown): value is TaskStallJournalState {
  return value === 'suspected' || value === 'alert_ready' || value === 'alerted';
}

export class TeamTaskStallJournal {
  private getFilePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'stall-monitor-journal.json');
  }

  async reconcileScan(args: {
    teamName: string;
    evaluations: TaskStallEvaluation[];
    activeTaskIds: string[];
    now: string;
  }): Promise<TaskStallEvaluation[]> {
    const filePath = this.getFilePath(args.teamName);
    let readyEvaluations: TaskStallEvaluation[] = [];

    await withFileLock(filePath, async () => {
      const entries = await this.readUnlocked(filePath);
      const candidateByEpoch = new Map(
        args.evaluations
          .filter(
            (
              evaluation
            ): evaluation is TaskStallEvaluation &
              Required<Pick<TaskStallEvaluation, 'taskId' | 'branch' | 'signal' | 'epochKey'>> =>
              evaluation.status === 'alert' &&
              typeof evaluation.taskId === 'string' &&
              typeof evaluation.branch === 'string' &&
              typeof evaluation.signal === 'string' &&
              typeof evaluation.epochKey === 'string'
          )
          .map((evaluation) => [evaluation.epochKey, evaluation] as const)
      );

      const activeTaskIdSet = new Set(args.activeTaskIds);
      for (let i = entries.length - 1; i >= 0; i -= 1) {
        const entry = entries[i];
        if (!activeTaskIdSet.has(entry.taskId) || !candidateByEpoch.has(entry.epochKey)) {
          entries.splice(i, 1);
        }
      }

      for (const [epochKey, evaluation] of candidateByEpoch) {
        const existing = entries.find((entry) => entry.epochKey === epochKey);
        if (!existing) {
          entries.push({
            epochKey,
            teamName: args.teamName,
            taskId: evaluation.taskId,
            branch: evaluation.branch,
            signal: evaluation.signal,
            state: 'suspected',
            consecutiveScans: 1,
            createdAt: args.now,
            updatedAt: args.now,
          });
          continue;
        }

        existing.updatedAt = args.now;
        if (existing.state === 'alerted') {
          continue;
        }

        existing.consecutiveScans += 1;
        if (existing.consecutiveScans >= 2) {
          existing.state = 'alert_ready';
          readyEvaluations.push(evaluation);
        }
      }

      await atomicWriteAsync(filePath, JSON.stringify(entries, null, 2));
    });

    return readyEvaluations;
  }

  async markAlerted(teamName: string, epochKey: string, now: string): Promise<void> {
    const filePath = this.getFilePath(teamName);
    await withFileLock(filePath, async () => {
      const entries = await this.readUnlocked(filePath);
      const target = entries.find((entry) => entry.epochKey === epochKey);
      if (!target) {
        return;
      }
      target.state = 'alerted';
      target.updatedAt = now;
      target.alertedAt = now;
      await atomicWriteAsync(filePath, JSON.stringify(entries, null, 2));
    });
  }

  private async readUnlocked(filePath: string): Promise<TaskStallJournalEntry[]> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) {
        return [];
      }

      return parsed
        .filter(
          (item): item is TaskStallJournalEntry =>
            item != null &&
            typeof item === 'object' &&
            typeof (item as TaskStallJournalEntry).epochKey === 'string' &&
            typeof (item as TaskStallJournalEntry).teamName === 'string' &&
            typeof (item as TaskStallJournalEntry).taskId === 'string' &&
            ((item as TaskStallJournalEntry).branch === 'work' ||
              (item as TaskStallJournalEntry).branch === 'review') &&
            ((item as TaskStallJournalEntry).signal === 'turn_ended_after_touch' ||
              (item as TaskStallJournalEntry).signal === 'mid_turn_after_touch' ||
              (item as TaskStallJournalEntry).signal === 'touch_then_other_turns') &&
            isValidState((item as TaskStallJournalEntry).state) &&
            typeof (item as TaskStallJournalEntry).consecutiveScans === 'number' &&
            typeof (item as TaskStallJournalEntry).createdAt === 'string' &&
            typeof (item as TaskStallJournalEntry).updatedAt === 'string'
        )
        .map((entry) => ({
          ...entry,
          ...(entry.alertedAt ? { alertedAt: entry.alertedAt } : {}),
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
