import { getCommentNotificationJournalPath } from '@main/services/team/JsonTaskCommentNotificationJournalStore';
import { sanitizeTaskCommentNotificationJournalEntries } from '@main/services/team/TaskCommentNotificationJournalStore';

import { KeyedMutex } from '../../core/application/KeyedMutex';
import { InternalStorageJsonReplica } from '../infrastructure/InternalStorageJsonReplica';

import type { InternalStorageBackendSelector } from './InternalStorageBackendSelector';
import type {
  TaskCommentNotificationJournalEntry,
  TaskCommentNotificationJournalMutation,
  TaskCommentNotificationJournalStore,
} from '@main/services/team/TaskCommentNotificationJournalStore';

/** Routes comment-journal persistence through the session backend decision. */
export interface BackendSelectingTaskCommentNotificationJournalStoreOptions {
  fallbackRequiresReplica: boolean;
  logger?: { warn(message: string, metadata?: Record<string, unknown>): void };
}

export class BackendSelectingTaskCommentNotificationJournalStore implements TaskCommentNotificationJournalStore {
  private readonly replica: InternalStorageJsonReplica<{
    initialized: boolean;
    entries: TaskCommentNotificationJournalEntry[];
  }> | null;
  private readonly mutex = new KeyedMutex();
  private readonly sqlitePreparedTeams = new Set<string>();
  private readonly jsonHydratedTeams = new Set<string>();

  constructor(
    private readonly selector: InternalStorageBackendSelector,
    private readonly sqliteStore: TaskCommentNotificationJournalStore,
    private readonly jsonStore: TaskCommentNotificationJournalStore,
    private readonly options?: BackendSelectingTaskCommentNotificationJournalStoreOptions
  ) {
    this.replica = options
      ? new InternalStorageJsonReplica(
          (teamName) => `${getCommentNotificationJournalPath(teamName)}.sqlite-fallback-replica`,
          (
            value
          ): value is {
            initialized: boolean;
            entries: TaskCommentNotificationJournalEntry[];
          } =>
            Boolean(
              value &&
              typeof value === 'object' &&
              typeof (value as { initialized?: unknown }).initialized === 'boolean' &&
              Array.isArray((value as { entries?: unknown }).entries) &&
              ((value as { initialized: boolean }).initialized ||
                (value as { entries: unknown[] }).entries.length === 0) &&
              sanitizeTaskCommentNotificationJournalEntries(
                (value as { entries: unknown[] }).entries
              ).length === (value as { entries: unknown[] }).entries.length
            )
        )
      : null;
  }

  private async run<T>(
    teamName: string,
    mutation: boolean,
    sqliteAction: () => Promise<T>,
    jsonAction: () => Promise<T>
  ): Promise<T> {
    const backend = await this.selector.select<'sqlite' | 'json'>('sqlite', 'json');
    if (!this.replica || !this.options) return backend === 'sqlite' ? sqliteAction() : jsonAction();
    return this.mutex.run(teamName, async () => {
      if (backend === 'json') {
        if (!this.jsonHydratedTeams.has(teamName)) {
          const snapshot = await this.replica!.readClean(
            teamName,
            this.options!.fallbackRequiresReplica
          );
          if (snapshot) {
            if (snapshot.initialized) await this.jsonStore.ensureInitialized(teamName);
            if (snapshot.initialized || snapshot.entries.length > 0) {
              await this.jsonStore.withEntries(teamName, async (active) => {
                const merged = mergeCommentEntries(snapshot.entries, active);
                active.splice(0, active.length, ...merged);
                return { result: undefined, changed: true };
              });
            }
          }
          this.jsonHydratedTeams.add(teamName);
        }
        return jsonAction();
      }

      const publishReplica = mutation || !this.sqlitePreparedTeams.has(teamName);
      if (!this.sqlitePreparedTeams.has(teamName)) {
        const snapshot = await this.replica!.readForPrimary(
          teamName,
          this.selector.getBackendInfo()?.integrity !== 'recovered'
        );
        // Preparation can lazily import and archive the legacy JSON store.
        // Fence fallback before any SQLite-side mutation begins.
        await this.replica!.markDirty(teamName);
        if (snapshot) {
          if (snapshot.initialized) await this.sqliteStore.ensureInitialized(teamName);
          if (snapshot.entries.length > 0) {
            await this.sqliteStore.withEntries(teamName, async (active) => {
              const merged = mergeCommentEntries(snapshot.entries, active);
              active.splice(0, active.length, ...merged);
              return { result: undefined, changed: true };
            });
          }
        }
      } else if (publishReplica) {
        await this.replica!.markDirty(teamName);
      }
      const result = await sqliteAction();
      if (publishReplica) {
        try {
          const [initialized, entries] = await Promise.all([
            this.sqliteStore.exists(teamName),
            this.sqliteStore.read(teamName),
          ]);
          await this.replica!.writeClean(teamName, { initialized, entries });
          this.sqlitePreparedTeams.add(teamName);
        } catch (error) {
          this.options!.logger?.warn('comment journal fallback replica publication failed', {
            teamName,
            error: String(error),
          });
        }
      }
      return result;
    });
  }

  async exists(teamName: string): Promise<boolean> {
    return this.run(
      teamName,
      false,
      () => this.sqliteStore.exists(teamName),
      () => this.jsonStore.exists(teamName)
    );
  }

  async ensureInitialized(teamName: string): Promise<void> {
    await this.run(
      teamName,
      true,
      () => this.sqliteStore.ensureInitialized(teamName),
      () => this.jsonStore.ensureInitialized(teamName)
    );
  }

  async read(teamName: string): Promise<TaskCommentNotificationJournalEntry[]> {
    return this.run(
      teamName,
      false,
      () => this.sqliteStore.read(teamName),
      () => this.jsonStore.read(teamName)
    );
  }

  async withEntries<T>(
    teamName: string,
    fn: (
      entries: TaskCommentNotificationJournalEntry[]
    ) =>
      | Promise<TaskCommentNotificationJournalMutation<T>>
      | TaskCommentNotificationJournalMutation<T>
  ): Promise<T> {
    return this.run(
      teamName,
      true,
      () => this.sqliteStore.withEntries(teamName, fn),
      () => this.jsonStore.withEntries(teamName, fn)
    );
  }
}

function mergeCommentEntries(
  canonical: readonly TaskCommentNotificationJournalEntry[],
  incoming: readonly TaskCommentNotificationJournalEntry[]
): TaskCommentNotificationJournalEntry[] {
  const merged = new Map(canonical.map((entry) => [entry.key, entry]));
  const rank = (state: TaskCommentNotificationJournalEntry['state']): number =>
    state === 'sent' ? 2 : state === 'pending_send' ? 1 : 0;
  for (const entry of incoming) {
    const current = merged.get(entry.key);
    if (
      !current ||
      rank(entry.state) > rank(current.state) ||
      (rank(entry.state) === rank(current.state) &&
        Date.parse(entry.updatedAt) > Date.parse(current.updatedAt))
    ) {
      merged.set(entry.key, entry);
    }
  }
  return [...merged.values()];
}
