import * as path from 'node:path';

import { JsonTaskCommentNotificationJournalStore } from '@main/services/team/JsonTaskCommentNotificationJournalStore';
import { JsonTaskStallJournalStore } from '@main/services/team/stallMonitor/JsonTaskStallJournalStore';
import { createLogger } from '@shared/utils/logger';

import {
  COMMENT_JOURNAL_STORE_ID,
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
  STALL_JOURNAL_STORE_ID,
} from '../../contracts/internalStorageContracts';
import { ImportLegacyJsonStoreUseCase } from '../../core/application/ImportLegacyJsonStoreUseCase';
import { KeyedMutex } from '../../core/application/KeyedMutex';
import { areCommentJournalRecordSetsEquivalent } from '../adapters/output/commentJournalEntryRecordMapper';
import { CommentJournalLegacyJsonSource } from '../adapters/output/CommentJournalLegacyJsonSource';
import { SqliteTaskCommentNotificationJournalStore } from '../adapters/output/SqliteTaskCommentNotificationJournalStore';
import { SqliteTaskStallJournalStore } from '../adapters/output/SqliteTaskStallJournalStore';
import { areStallJournalRecordSetsEquivalent } from '../adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '../adapters/output/StallJournalLegacyJsonSource';
import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import { BackendSelectingTaskCommentNotificationJournalStore } from './BackendSelectingTaskCommentNotificationJournalStore';
import { BackendSelectingTaskStallJournalStore } from './BackendSelectingTaskStallJournalStore';
import { InternalStorageBackendSelector } from './InternalStorageBackendSelector';

import type { InternalStorageBackendKind } from '../../contracts/internalStorageContracts';
import type { MemberWorkSyncStorageGateway } from '../../core/application/ports';
import type { ApplicationCommandLedgerStorageGateway } from '@features/application-command-ledger';
import type { TaskStallJournalStore } from '@main/services/team/stallMonitor/TaskStallJournalStore';
import type { TaskCommentNotificationJournalStore } from '@main/services/team/TaskCommentNotificationJournalStore';

const logger = createLogger('Feature:InternalStorage');

export interface InternalStorageFeatureDeps {
  /** Usually app.getPath('userData'); the SQLite file lives in a subfolder. */
  userDataPath: string;
}

export interface InternalStorageMemberWorkSyncBackend {
  gateway: MemberWorkSyncStorageGateway;
  selector: InternalStorageBackendSelector;
}

export interface InternalStorageApplicationCommandLedgerBackend {
  gateway: ApplicationCommandLedgerStorageGateway;
  selector: InternalStorageBackendSelector;
}

export interface InternalStorageFeature {
  taskStallJournalStore: TaskStallJournalStore;
  taskCommentNotificationJournalStore: TaskCommentNotificationJournalStore;
  /**
   * Raw SQLite backend handle for the member-work-sync feature, which builds
   * its own store on top (its ports live in that feature). Null when the
   * worker bundle is unavailable — the caller stays on its JSON store.
   */
  memberWorkSyncBackend: InternalStorageMemberWorkSyncBackend | null;
  /**
   * SQLite gateway for the application-command-ledger feature. Null when the
   * worker bundle is unavailable, so callers must leave durable commands off.
   */
  applicationCommandLedgerBackend: InternalStorageApplicationCommandLedgerBackend | null;
  /** Forces the lazy backend decision for startup diagnostics and packaged smoke checks. */
  probeBackend(): Promise<InternalStorageBackendKind>;
  getBackendKind(): InternalStorageBackendKind;
  dispose(): Promise<void>;
}

export function getInternalStorageDatabasePath(userDataPath: string): string {
  return path.join(userDataPath, INTERNAL_STORAGE_DIRNAME, INTERNAL_STORAGE_DATABASE_FILENAME);
}

export function createInternalStorageFeature(
  deps: InternalStorageFeatureDeps
): InternalStorageFeature {
  const databasePath = getInternalStorageDatabasePath(deps.userDataPath);
  const client = new InternalStorageWorkerClient({ databasePath });
  const jsonStallStore = new JsonTaskStallJournalStore();
  const jsonCommentStore = new JsonTaskCommentNotificationJournalStore();

  if (!client.isAvailable()) {
    logger.warn(
      `internal-storage worker bundle not found; using JSON stores. expectedOneOf=${client
        .getWorkerPathCandidatesForDiagnostics()
        .join(',')}`
    );
    return {
      taskStallJournalStore: jsonStallStore,
      taskCommentNotificationJournalStore: jsonCommentStore,
      memberWorkSyncBackend: null,
      applicationCommandLedgerBackend: null,
      probeBackend: async () => 'json-fallback',
      getBackendKind: () => 'json-fallback',
      dispose: async () => undefined,
    };
  }

  const selector = new InternalStorageBackendSelector(() => client.ping());

  const stallImporter = new ImportLegacyJsonStoreUseCase({
    storeId: STALL_JOURNAL_STORE_ID,
    source: new StallJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadStallJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceStallJournalEntries(teamName, records),
    recordIdentity: (record) => record.epochKey,
    areEquivalent: areStallJournalRecordSetsEquivalent,
    recordImport: (teamName, entryCount) =>
      client.recordStoreImport(STALL_JOURNAL_STORE_ID, teamName, entryCount),
    hasRecordedImport: (teamName) => client.hasStoreImport(STALL_JOURNAL_STORE_ID, teamName),
  });
  const sqliteStallStore = new SqliteTaskStallJournalStore({
    gateway: client,
    importer: stallImporter,
    mutex: new KeyedMutex(),
  });

  const commentImporter = new ImportLegacyJsonStoreUseCase({
    storeId: COMMENT_JOURNAL_STORE_ID,
    source: new CommentJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadCommentJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceCommentJournalEntries(teamName, records),
    recordIdentity: (record) => record.key,
    areEquivalent: areCommentJournalRecordSetsEquivalent,
    recordImport: (teamName, entryCount) =>
      client.recordStoreImport(COMMENT_JOURNAL_STORE_ID, teamName, entryCount),
    hasRecordedImport: (teamName) => client.hasStoreImport(COMMENT_JOURNAL_STORE_ID, teamName),
  });
  const sqliteCommentStore = new SqliteTaskCommentNotificationJournalStore({
    gateway: client,
    importer: commentImporter,
    mutex: new KeyedMutex(),
  });

  return {
    taskStallJournalStore: new BackendSelectingTaskStallJournalStore(
      selector,
      sqliteStallStore,
      jsonStallStore
    ),
    taskCommentNotificationJournalStore: new BackendSelectingTaskCommentNotificationJournalStore(
      selector,
      sqliteCommentStore,
      jsonCommentStore
    ),
    memberWorkSyncBackend: { gateway: client, selector },
    applicationCommandLedgerBackend: { gateway: client, selector },
    probeBackend: () => selector.select('sqlite', 'json-fallback'),
    getBackendKind: () => selector.getBackendKind(),
    dispose: () => client.close(),
  };
}
