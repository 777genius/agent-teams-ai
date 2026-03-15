import { getTeamsBasePath } from '@main/utils/pathDecoder';
import * as fs from 'fs';
import * as path from 'path';

import { atomicWriteAsync } from './atomicWrite';
import { withFileLock } from './fileLock';

export type TaskCommentNotificationState = 'seeded' | 'pending_send' | 'sent';

export interface TaskCommentNotificationJournalEntry {
  key: string;
  taskId: string;
  commentId: string;
  author: string;
  commentCreatedAt?: string;
  messageId?: string;
  state: TaskCommentNotificationState;
  createdAt: string;
  updatedAt: string;
  sentAt?: string;
}

function isValidState(value: unknown): value is TaskCommentNotificationState {
  return value === 'seeded' || value === 'pending_send' || value === 'sent';
}

export class TeamTaskCommentNotificationJournal {
  private getFilePath(teamName: string): string {
    return path.join(getTeamsBasePath(), teamName, 'comment-notification-journal.json');
  }

  async exists(teamName: string): Promise<boolean> {
    try {
      await fs.promises.access(this.getFilePath(teamName), fs.constants.F_OK);
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return false;
      }
      throw error;
    }
  }

  async ensureFile(teamName: string): Promise<void> {
    const filePath = this.getFilePath(teamName);
    await withFileLock(filePath, async () => {
      const existing = await this.readUnlocked(filePath);
      await atomicWriteAsync(filePath, JSON.stringify(existing, null, 2));
    });
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    const filePath = this.getFilePath(teamName);
    return this.readUnlocked(filePath);
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) => Promise<{ result: T; changed: boolean }> | { result: T; changed: boolean }
  ): Promise<T> {
    const filePath = this.getFilePath(teamName);
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
      const parsed = JSON.parse(raw) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed
        .filter(
          (item): item is TaskCommentNotificationJournalEntry =>
            item != null &&
            typeof item === 'object' &&
            typeof (item as TaskCommentNotificationJournalEntry).key === 'string' &&
            typeof (item as TaskCommentNotificationJournalEntry).taskId === 'string' &&
            typeof (item as TaskCommentNotificationJournalEntry).commentId === 'string' &&
            typeof (item as TaskCommentNotificationJournalEntry).author === 'string' &&
            isValidState((item as TaskCommentNotificationJournalEntry).state) &&
            typeof (item as TaskCommentNotificationJournalEntry).createdAt === 'string' &&
            typeof (item as TaskCommentNotificationJournalEntry).updatedAt === 'string'
        )
        .map((entry) => ({
          key: entry.key,
          taskId: entry.taskId,
          commentId: entry.commentId,
          author: entry.author,
          ...(entry.commentCreatedAt ? { commentCreatedAt: entry.commentCreatedAt } : {}),
          ...(entry.messageId ? { messageId: entry.messageId } : {}),
          state: entry.state,
          createdAt: entry.createdAt,
          updatedAt: entry.updatedAt,
          ...(entry.sentAt ? { sentAt: entry.sentAt } : {}),
        }));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return [];
      }
      throw error;
    }
  }
}
