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
import {
  areCommentJournalRecordSetsEquivalent,
  resolveCommentJournalRecordConflict,
} from '../adapters/output/commentJournalEntryRecordMapper';
import { CommentJournalLegacyJsonSource } from '../adapters/output/CommentJournalLegacyJsonSource';
import { SqliteTaskCommentNotificationJournalStore } from '../adapters/output/SqliteTaskCommentNotificationJournalStore';
import { SqliteTaskStallJournalStore } from '../adapters/output/SqliteTaskStallJournalStore';
import {
  areStallJournalRecordSetsEquivalent,
  resolveStallJournalRecordConflict,
} from '../adapters/output/stallJournalEntryRecordMapper';
import { StallJournalLegacyJsonSource } from '../adapters/output/StallJournalLegacyJsonSource';
import { InternalStorageWorkerClient } from '../infrastructure/InternalStorageWorkerClient';

import { BackendSelectingTaskCommentNotificationJournalStore } from './BackendSelectingTaskCommentNotificationJournalStore';
import { BackendSelectingTaskStallJournalStore } from './BackendSelectingTaskStallJournalStore';
import { InternalStorageBackendSelector } from './InternalStorageBackendSelector';

import type { InternalStorageBackendKind } from '../../contracts/internalStorageContracts';
import type { TeamIdentityReadGateway } from '../../contracts/teamIdentityStorageContracts';
import type { TeamRosterStorageGateway } from '../../contracts/teamRosterStorageContracts';
import type { MemberWorkSyncStorageGateway } from '../../core/application/ports';
import type { CoordinationDurabilityStorageGateway } from '../infrastructure/CoordinationDurabilityStorageGateway';
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
  fallbackRequiresReplica?: boolean;
}

export interface InternalStorageApplicationCommandLedgerBackend {
  gateway: ApplicationCommandLedgerStorageGateway;
  selector: InternalStorageBackendSelector;
}

export interface InternalStorageTeamIdentityReadBackend {
  gateway: TeamIdentityReadGateway;
}

export interface InternalStorageTeamRosterBackend {
  gateway: TeamRosterStorageGateway;
}

export interface InternalStorageCoordinationDurabilityBackend {
  gateway: CoordinationDurabilityStorageGateway;
  selector: InternalStorageBackendSelector;
}

export interface InternalStorageFeature {
  taskStallJournalStore: TaskStallJournalStore;
  taskCommentNotificationJournalStore: TaskCommentNotificationJournalStore;
  /**
   * Raw SQLite backend handle for the member-work-sync feature, which builds
   * its own store on top (its ports live in that feature). The selector may
   * force JSON fallback when the worker bundle is unavailable so compatibility
   * replicas are still hydrated instead of bypassing the backend wrapper.
   */
  memberWorkSyncBackend: InternalStorageMemberWorkSyncBackend | null;
  /**
   * SQLite gateway for the application-command-ledger feature. Null when the
   * worker bundle is unavailable, so callers must leave durable commands off.
   */
  applicationCommandLedgerBackend: InternalStorageApplicationCommandLedgerBackend | null;
  /** Durable identity reads never degrade to directory or JSON discovery. */
  teamIdentityReadBackend: InternalStorageTeamIdentityReadBackend | null;
  /** TeamRoster identity is SQLite-only and never falls back to name-keyed JSON. */
  teamRosterBackend: InternalStorageTeamRosterBackend | null;
  /** Critical coordination durability never degrades to a JSON fallback. */
  coordinationDurabilityBackend: InternalStorageCoordinationDurabilityBackend | null;
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
  // Replica ownership is per team/store. A missing replica means that store was
  // never touched through SQLite; a dirty replica fails closed on its own.
  // App-wide database existence cannot be used here because a healthy database
  // may contain other teams/stores while this one is legitimately fresh.
  const fallbackRequiresReplica = false;
  const client = new InternalStorageWorkerClient({ databasePath });
  const workerAvailable = client.isAvailable();
  const jsonStallStore = new JsonTaskStallJournalStore();
  const jsonCommentStore = new JsonTaskCommentNotificationJournalStore();

  if (!workerAvailable) {
    logger.warn(
      `internal-storage worker bundle not found; using JSON stores. expectedOneOf=${client
        .getWorkerPathCandidatesForDiagnostics()
        .join(',')}`
    );
  }

  const selector = new InternalStorageBackendSelector(() =>
    workerAvailable
      ? client.ping()
      : Promise.reject(new Error('internal-storage worker bundle is unavailable'))
  );

  const stallImporter = new ImportLegacyJsonStoreUseCase({
    storeId: STALL_JOURNAL_STORE_ID,
    source: new StallJournalLegacyJsonSource(),
    loadExisting: (teamName) => client.loadStallJournalEntries(teamName),
    replaceAll: (teamName, records) => client.replaceStallJournalEntries(teamName, records),
    recordIdentity: (record) => record.epochKey,
    resolveConflict: resolveStallJournalRecordConflict,
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
    resolveConflict: resolveCommentJournalRecordConflict,
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
      jsonStallStore,
      { fallbackRequiresReplica, logger }
    ),
    taskCommentNotificationJournalStore: new BackendSelectingTaskCommentNotificationJournalStore(
      selector,
      sqliteCommentStore,
      jsonCommentStore,
      { fallbackRequiresReplica, logger }
    ),
    memberWorkSyncBackend: { gateway: client, selector, fallbackRequiresReplica },
    applicationCommandLedgerBackend: workerAvailable ? { gateway: client, selector } : null,
    teamIdentityReadBackend: workerAvailable ? { gateway: client } : null,
    teamRosterBackend: workerAvailable ? { gateway: client } : null,
    coordinationDurabilityBackend: workerAvailable ? { gateway: client, selector } : null,
    probeBackend: () => selector.select('sqlite', 'json-fallback'),
    getBackendKind: () => selector.getBackendKind(),
    dispose: () => client.close(),
  };
}
