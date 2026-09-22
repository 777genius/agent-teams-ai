import { JsonTaskCommentNotificationJournalStore } from './JsonTaskCommentNotificationJournalStore';

import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from './TaskCommentNotificationJournalStore';

export type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationState,
} from './TaskCommentNotificationJournalStore';

/**
 * Facade kept for existing consumers (TeamDataService). Persistence goes
 * through a TaskCommentNotificationJournalStore; the legacy per-team JSON
 * file store is the default and the fallback backend.
 */
export class TeamTaskCommentNotificationJournal {
  private store: TaskCommentNotificationJournalStore;

  constructor(
    store: TaskCommentNotificationJournalStore = new JsonTaskCommentNotificationJournalStore()
  ) {
    this.store = store;
  }

  /** Swaps the backend; must be called before first use (composition only). */
  setStore(store: TaskCommentNotificationJournalStore): void {
    this.store = store;
  }

  async exists(teamName: string): Promise<boolean> {
    return this.store.exists(teamName);
  }

  async ensureFile(teamName: string): Promise<void> {
    await this.store.ensureInitialized(teamName);
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    return this.store.read(teamName);
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    return this.store.withEntries(teamName, fn);
  }
}
