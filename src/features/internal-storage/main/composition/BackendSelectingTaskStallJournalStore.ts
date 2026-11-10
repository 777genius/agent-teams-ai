import { getStallMonitorJournalPath } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { sanitizeTaskStallJournalEntries } from '@main/services/team/stallMonitor/TaskStallJournalStore';

import { KeyedMutex } from '../../core/application/KeyedMutex';
import { InternalStorageJsonReplica } from '../infrastructure/InternalStorageJsonReplica';

import type { InternalStorageBackendSelector } from './InternalStorageBackendSelector';
import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '@main/services/team/stallMonitor/TeamTaskStallTypes';

/** Routes stall-journal persistence through the session backend decision. */
export interface BackendSelectingTaskStallJournalStoreOptions {
  fallbackRequiresReplica: boolean;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

export class BackendSelectingTaskStallJournalStore implements TaskStallJournalStore {
  private readonly replica: InternalStorageJsonReplica<{ entries: TaskStallJournalEntry[] }> | null;
  private readonly mutex = new KeyedMutex();
  private readonly hydratedTeams = new Set<string>();
  private readonly sqlitePreparedTeams = new Set<string>();

  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: TaskStallJournalStore,
    private readonly jsonStore: TaskStallJournalStore,
    private readonly options?: BackendSelectingTaskStallJournalStoreOptions
  ) {
    this.replica = options
      ? new InternalStorageJsonReplica(
          (teamName) => `${getStallMonitorJournalPath(teamName)}.sqlite-fallback-replica`,
          (value, teamName): value is { entries: TaskStallJournalEntry[] } =>
            Boolean(
              value &&
              typeof value === 'object' &&
              Array.isArray((value as { entries?: unknown }).entries) &&
              sanitizeTaskStallJournalEntries((value as { entries: unknown[] }).entries).length ===
                (value as { entries: unknown[] }).entries.length &&
              (value as { entries: TaskStallJournalEntry[] }).entries.every(
                (entry) => normalizeTeam(entry.teamName) === normalizeTeam(teamName)
              )
            )
        )
      : null;
  }

  async update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    if (!this.replica || !this.options) {
      return (backend === 'sqlite' ? this.sqliteStore : this.jsonStore).update(teamName, mutate);
    }
    return this.mutex.run(teamName, async () => {
      if (backend === 'json') {
        if (!this.hydratedTeams.has(teamName)) {
          const snapshot = await this.replica!.readClean(
            teamName,
            this.options!.fallbackRequiresReplica
          );
          if (snapshot) {
            await this.jsonStore.update(teamName, (active) => ({
              entries: mergeStallEntries(snapshot.entries, active),
              result: undefined,
            }));
          }
          this.hydratedTeams.add(teamName);
        }
        return this.jsonStore.update(teamName, mutate);
      }

      if (!this.sqlitePreparedTeams.has(teamName)) {
        const snapshot = await this.replica!.readForPrimary(
          teamName,
          this.selector.getBackendInfo()?.integrity !== 'recovered'
        );
        // Preparation can lazily import and archive the legacy JSON store.
        // Fence fallback before any SQLite-side mutation begins.
        await this.replica!.markDirty(teamName);
        if (snapshot) {
          await this.sqliteStore.update(teamName, (active) => ({
            entries: mergeStallEntries(snapshot.entries, active),
            result: undefined,
          }));
        }
      } else {
        await this.replica!.markDirty(teamName);
      }
      const result = await this.sqliteStore.update(teamName, mutate);
      try {
        const persistedEntries = await this.sqliteStore.update(teamName, (entries) => ({
          entries,
          result: structuredClone(entries),
          changed: false,
        }));
        await this.replica!.writeClean(teamName, { entries: persistedEntries });
        this.sqlitePreparedTeams.add(teamName);
      } catch (error) {
        this.options!.logger?.warn('stall journal fallback replica publication failed', {
          teamName,
          error: String(error),
        });
      }
      return result;
    });
  }
}

function normalizeTeam(teamName: string): string {
  return teamName.trim().toLowerCase();
}

function mergeStallEntries(
  canonical: readonly TaskStallJournalEntry[],
  incoming: readonly TaskStallJournalEntry[]
): TaskStallJournalEntry[] {
  const merged = new Map(canonical.map((entry) => [entry.epochKey, entry]));
  const rank = (state: TaskStallJournalEntry['state']): number =>
    state === 'alerted' ? 2 : state === 'alert_ready' ? 1 : 0;
  for (const entry of incoming) {
    const current = merged.get(entry.epochKey);
    if (!current) {
      merged.set(entry.epochKey, entry);
      continue;
    }
    if (rank(entry.state) > rank(current.state)) merged.set(entry.epochKey, entry);
    else if (
      rank(entry.state) === rank(current.state) &&
      (entry.consecutiveScans > current.consecutiveScans ||
        (entry.consecutiveScans === current.consecutiveScans &&
          Date.parse(entry.updatedAt) > Date.parse(current.updatedAt)))
    ) {
      merged.set(entry.epochKey, entry);
    }
  }
  return [...merged.values()];
}
