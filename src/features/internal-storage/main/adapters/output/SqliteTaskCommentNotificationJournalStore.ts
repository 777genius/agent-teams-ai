import {
  commentJournalEntryToRecord,
  commentJournalRecordsToEntries,
} from './commentJournalEntryRecordMapper';

import type { CommentJournalEntryRecord } from '../../../contracts/internalStorageContracts';
import type { ImportLegacyJsonStoreUseCase } from '../../../core/application/ImportLegacyJsonStoreUseCase';
import type { KeyedMutex } from '../../../core/application/KeyedMutex';
import type { InternalStorageGateway } from '../../../core/application/ports';
import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from '@main/services/team/TaskCommentNotificationJournalStore';

export interface SqliteTaskCommentNotificationJournalStoreDeps {
  gateway: InternalStorageGateway;
  importer: ImportLegacyJsonStoreUseCase<CommentJournalEntryRecord>;
  mutex: KeyedMutex;
}

/**
 * SQLite-backed comment-notification journal persistence. Every method runs
 * the lazy legacy-JSON import first, under the per-team mutex — this also
 * makes exists() correct while a not-yet-imported legacy file is present
 * (the import turns the file into the initialization marker row).
 */
export class SqliteTaskCommentNotificationJournalStore implements TaskCommentNotificationJournalStore {
  constructor(private readonly deps: SqliteTaskCommentNotificationJournalStoreDeps) {}

  async exists(teamName: string): Promise<boolean> {
    return this.deps.mutex.run(teamName, async () => {
      await this.deps.importer.ensureImported(teamName);
      return this.deps.gateway.commentJournalExists(teamName);
    });
  }

  async ensureInitialized(teamName: string): Promise<void> {
    await this.deps.mutex.run(teamName, async () => {
      await this.deps.importer.ensureImported(teamName);
      await this.deps.gateway.ensureCommentJournalInitialized(teamName);
    });
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    return this.deps.mutex.run(teamName, async () => {
      await this.deps.importer.ensureImported(teamName);
      const records = await this.deps.gateway.loadCommentJournalEntries(teamName);
      return commentJournalRecordsToEntries(records);
    });
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    return this.deps.mutex.run(teamName, async () => {
      await this.deps.importer.ensureImported(teamName);
      const records = await this.deps.gateway.loadCommentJournalEntries(teamName);
      const entries = commentJournalRecordsToEntries(records);
      const outcome = await fn(entries);
      if (outcome.changed) {
        await this.deps.gateway.replaceCommentJournalEntries(
          teamName,
          entries.map((entry) => commentJournalEntryToRecord(teamName, entry))
        );
      }
      return outcome.result;
    });
  }
}
