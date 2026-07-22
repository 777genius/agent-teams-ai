import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';
import { sanitizeTaskCommentNotificationJournalEntries } from './TaskCommentNotificationJournalStore';

import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from './TaskCommentNotificationJournalStore';

export const COMMENT_NOTIFICATION_JOURNAL_FILENAME = 'comment-notification-journal.json';

export function getCommentNotificationJournalPath(teamName: string): string {
  return path.join(getTeamsBasePath(), teamName, COMMENT_NOTIFICATION_JOURNAL_FILENAME);
}

/**
 * Legacy JSON-file journal persistence. The file's presence doubles as the
 * initialization marker; a corrupt file intentionally throws (matching the
 * original behavior) instead of being treated as empty, because an emptied
 * journal would re-notify the lead about every historical comment.
 */
export class JsonTaskCommentNotificationJournalStore implements TaskCommentNotificationJournalStore {
  async exists(teamName: string): Promise<boolean> {
    try {
      await fs.promises.access(getCommentNotificationJournalPath(teamName), fs.constants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async ensureInitialized(teamName: string): Promise<void> {
    const filePath = getCommentNotificationJournalPath(teamName);
    await withFileLock(filePath, async () => {
      const existing = await this.readUnlocked(filePath);
      await atomicWriteAsync(filePath, JSON.stringify(existing, null, 2));
    });
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    return this.readUnlocked(getCommentNotificationJournalPath(teamName));
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    const filePath = getCommentNotificationJournalPath(teamName);
    let result!: T;

    await withFileLock(filePath, async () => {
      const entries = await this.readUnlocked(filePath);
      const outcome = await fn(entries);
      result = outcome.result;
      if (!outcome.changed) return;
      await atomicWriteAsync(filePath, JSON.stringify(entries, null, 2));
    });

    return result;
  }

  private async readUnlocked(filePath: string): Promise<TaskCommentNotificationJournalEntry[]> {
    try {
      const raw = await fs.promises.readFile(filePath, 'utf8');
      return sanitizeTaskCommentNotificationJournalEntries(JSON.parse(raw));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
