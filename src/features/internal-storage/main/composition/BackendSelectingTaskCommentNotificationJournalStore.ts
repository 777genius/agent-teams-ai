import type { InternalStorageBackendSelector } from './InternalStorageBackendSelector';
import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from '@main/services/team/TaskCommentNotificationJournalStore';

/** Routes comment-journal persistence through the session backend decision. */
export class BackendSelectingTaskCommentNotificationJournalStore implements TaskCommentNotificationJournalStore {
  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: TaskCommentNotificationJournalStore,
    private readonly jsonStore: TaskCommentNotificationJournalStore
  ) {}

  async exists(teamName: string): Promise<boolean> {
    const backend = await this.selector.select(this.sqliteStore, this.jsonStore);
    return backend.exists(teamName);
  }

  async ensureInitialized(teamName: string): Promise<void> {
    const backend = await this.selector.select(this.sqliteStore, this.jsonStore);
    await backend.ensureInitialized(teamName);
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    const backend = await this.selector.select(this.sqliteStore, this.jsonStore);
    return backend.read(teamName);
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    const backend = await this.selector.select(this.sqliteStore, this.jsonStore);
    return backend.withEntries(teamName, fn);
  }
}
