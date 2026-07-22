import {
  stallJournalEntryToRecord,
  stallJournalRecordsToEntries,
} from './stallJournalEntryRecordMapper';

import type { StallJournalEntryRecord } from '../../../contracts/internalStorageContracts';
import type { ImportLegacyJsonStoreUseCase } from '../../../core/application/ImportLegacyJsonStoreUseCase';
import type { KeyedMutex } from '../../../core/application/KeyedMutex';
import type { InternalStorageGateway } from '../../../core/application/ports';
import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '@main/services/team/stallMonitor/TeamTaskStallTypes';

export interface SqliteTaskStallJournalStoreDeps {
  gateway: InternalStorageGateway;
  importer: ImportLegacyJsonStoreUseCase<StallJournalEntryRecord>;
  mutex: KeyedMutex;
}

/**
 * SQLite-backed stall journal persistence. The per-team mutex spans lazy
 * legacy-JSON import plus the read-mutate-write cycle, giving the same
 * exclusivity guarantees the JSON store gets from its file lock.
 */
export class SqliteTaskStallJournalStore implements TaskStallJournalStore {
  constructor(private readonly deps: SqliteTaskStallJournalStoreDeps) {}

  async update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    return this.deps.mutex.run(teamName, async () => {
      await this.deps.importer.ensureImported(teamName);

      const records = await this.deps.gateway.loadStallJournalEntries(teamName);
      const entries = stallJournalRecordsToEntries(records);
      const { entries: nextEntries, result, changed = true } = mutate(entries);
      if (changed) {
        await this.deps.gateway.replaceStallJournalEntries(
          teamName,
          nextEntries.map(stallJournalEntryToRecord)
        );
      }
      return result;
    });
  }
}
