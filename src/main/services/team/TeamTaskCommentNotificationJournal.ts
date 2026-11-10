import { unknownStoppedImportCommentFacts } from './stopped-import/commentFacts';
import { JsonTaskCommentNotificationJournalStore } from './JsonTaskCommentNotificationJournalStore';

import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from './TaskCommentNotificationJournalStore';
import type { LegacySourceWriteAdmissionPolicy } from '@agent-teams/legacy-agent-host/lifecycle';

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
  private sourceWriteAdmission?: LegacySourceWriteAdmissionPolicy;
  setLegacySourceWriteAdmission(policy: LegacySourceWriteAdmissionPolicy | undefined): void {
    this.sourceWriteAdmission = policy;
    this.store.setLegacySourceWriteAdmission?.(policy);
  }

  private publish<T>(teamName: string, operation: () => Promise<T>): Promise<T> {
    const admission = this.sourceWriteAdmission?.current(teamName);
    return admission ? admission.publish(operation) : operation();
  }

  constructor(
    store: TaskCommentNotificationJournalStore = new JsonTaskCommentNotificationJournalStore()
  ) {
    this.store = store;
  }

  /** Swaps the backend; must be called before first use (composition only). */
  setStore(store: TaskCommentNotificationJournalStore): void {
    this.store = store;
    store.setLegacySourceWriteAdmission?.(this.sourceWriteAdmission);
  }

  async inspectStoppedImport(teamName: string) {
    return this.store.inspectStoppedImport?.(teamName) ?? unknownStoppedImportCommentFacts();
  }

  async exists(teamName: string): Promise<boolean> {
    return this.publish(teamName, () => this.store.exists(teamName));
  }

  async ensureFile(teamName: string): Promise<void> {
    await this.publish(teamName, () => this.store.ensureInitialized(teamName));
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    return this.publish(teamName, () => this.store.read(teamName));
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    return this.publish(teamName, () => this.store.withEntries(teamName, fn));
  }
}
