import type { PersistedTaskChangeSummaryEntry } from './taskChangeSummaryCacheTypes';

export interface TaskChangeSummaryCacheRepository {
  load(teamName: string, taskId: string): Promise<PersistedTaskChangeSummaryEntry | null>;
  save(
    entry: PersistedTaskChangeSummaryEntry,
    options?: { generation?: number }
  ): Promise<{ written: boolean }>;
  delete(teamName: string, taskId: string): Promise<void>;
  prune(): Promise<number>;
}
