import type { InternalStorageBackendSelector } from './InternalStorageBackendSelector';
import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '@main/services/team/stallMonitor/TeamTaskStallTypes';

/** Routes stall-journal persistence through the session backend decision. */
export class BackendSelectingTaskStallJournalStore implements TaskStallJournalStore {
  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: TaskStallJournalStore,
    private readonly jsonStore: TaskStallJournalStore
  ) {}

  async update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    const backend = await this.selector.select(this.sqliteStore, this.jsonStore);
    return backend.update(teamName, mutate);
  }
}
