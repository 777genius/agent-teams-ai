import * as path from 'node:path';

import { JsonTaskStallJournalStore } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { createLogger } from '@shared/utils/logger';

import {
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
  STALL_JOURNAL_STORE_ID,
} from '../../contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '../../core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '../../core/application/KeyedMutex';
import { SqliteTaskStallJournalStore } from '../adapters/output/SqliteTaskStallJournalStore';
import { areStallJournalRecordSetsEquivalent } from '../adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '../adapters/output/StallJournalLegacyJsonSource';
import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import type { InternalStorageBackendKind } from '../../contracts/internalStorageContracts';
import type {
  TaskStallJournalMutation,
  TaskStallJournalStore,
} from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskStallJournalEntry } from '@main/services/team/stallMonitor/TeamTaskStallTypes';

const logger = createLogger('Feature:InternalStorage');

export interface InternalStorageFeatureDeps {
  /** Usually app.getPath('userData'); the SQLite file lives in a subfolder. */
  userDataPath: string;
}

export interface InternalStorageFeature {
  taskStallJournalStore: TaskStallJournalStore;
  getBackendKind(): InternalStorageBackendKind;
  dispose(): Promise<void>;
}

export function getInternalStorageDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, INTERNAL_STORAGE_DIRNAME, INTERNAL_STORAGE_DATABASE_FILENAME);
}

/**
 * Picks the SQLite backend once per session, on first store access. If the
 * initial ping fails (worker bundle missing, native module ABI mismatch,
 * unrecoverable database corruption) the session permanently falls back to
 * the legacy JSON store, so the app keeps working with degraded storage.
 * After a successful ping there is no mid-session switch: a later error
 * propagates to the caller instead of silently splitting state between
 * backends.
 */
export class BackendSelectingTaskStallJournalStore implements TaskStallJournalStore {
  private backendPromise: Promise<TaskStallJournalStore> | null = null;
  private backendKind: InternalStorageBackendKind = 'sqlite';

  constructor(
    private readonly client: Pick<InternalStorageWorkerClient, 'ping'>,
    private readonly sqliteStore: TaskStallJournalStore,
    private readonly jsonStore: TaskStallJournalStore
  ) {}

  getBackendKind(): InternalStorageBackendKind {
    return this.backendKind;
  }

  async update<T>(
    teamName: string,
    mutate: (entries: TaskStallJournalEntry[]) => TaskStallJournalMutation<T>
  ): Promise<T> {
    const backend = await this.resolveBackend();
    return backend.update(teamName, mutate);
  }

  private resolveBackend(): Promise<TaskStallJournalStore> {
    if (!this.backendPromise) {
      this.backendPromise = this.client
        .ping()
        .then((info) => {
          const message = `internal-storage backend=sqlite schemaVersion=${info.schemaVersion} integrity=${info.integrity} db=${info.databasePath}`;
          if (info.integrity === 'recovered') {
            logger.warn(message);
          } else {
            logger.info(message);
          }
          return this.sqliteStore;
        })
        .catch((error: unknown) => {
          this.backendKind = 'json-fallback';
          logger.error(
            'internal-storage sqlite backend unavailable; falling back to JSON store for this session',
            error
          );
          return this.jsonStore;
        });
    }
    return this.backendPromise;
  }
}

export function createInternalStorageFeature(
  deps: InternalStorageFeatureDeps
): InternalStorageFeature {
  const databasePath = getInternalStorageDatabasePath(deps.userDataPath);
  const client = new InternalStorageWorkerClient({ databasePath });
  const jsonStore = new JsonTaskStallJournalStore();

  if (!client.isAvailable()) {
    logger.warn(
      `internal-storage worker bundle not found; using JSON store. expectedOneOf=${client
        .getWorkerPathCandidatesForDiagnostics()
        .join(',')}`
    );
    return {
      taskStallJournalStore: jsonStore,
      getBackendKind: () => 'json-fallback',
      dispose: async () => undefined,
    };
  }

  const importer = new ImportLegacyJsonStoreUseCase({
    storeId: STALL_JOURNAL_STORE_ID,
    source: new StallJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadStallJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceStallJournalEntries(teamName, records),
    areEquivalent: areStallJournalRecordSetsEquivalent,
    recordImport: (teamName, entryCount) =>
      client.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, entryCount),
  });

  const sqliteStore = new SqliteTaskStallJournalStore({
    gateway: client,
    importer,
    mutex: new KeyedMutex(),
  });

  const store = new BackendSelectingTaskStallJournalStore(client, sqliteStore, jsonStore);

  return {
    taskStallJournalStore: store,
    getBackendKind: () => store.getBackendKind(),
    dispose: () => client.close(),
  };
}
