import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from '../atomicWrite';
import { withFileLock } from '../fileLock';

import { sanitizeTaskStallJournalEntries } from './TaskStallJournalStore';

import type { TaskStallJournalMutation, TaskStallJournalStore } from './TaskStallJournalStore';
import type { TaskStallJournalEntry } from './TeamTaskStallTypes';

export const STALL_MONITOR_JOURNAL_FILENAME = 'stall-monitor-journal.json';

export function getStallMonitorJournalPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, STALL_MONITOR_JOURNAL_FILENAME);
}

/**
 * Legacy JSON-file journal persistence. The file lock spans the whole
 * read-mutate-write cycle, matching the original TeamTaskStallJournal behavior.
 */
export class JsonTaskStallJournalStore implements TaskStallJournalStore {
  async update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    const filePath = getStallMonitorJournalPath(teamName);
    return withFileLock(filePath, async () => {
      const entries = await this.readUnlocked(filePath);
      const { entries: nextEntries, result, changed = true } = mutate(entries);
      if (changed) {
        await atomicWriteAsync(filePath, JSON.stringify(nextEntries, null, 2));
      }
      return result;
    });
  }

  private async readUnlocked(filePath: string): Promise<TaskStallJournalEntry[]> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return sanitizeTaskStallJournalEntries(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      if (error instanceof SyntaxError) {
        return [];
      }
      throw error;
    }
  }
}
