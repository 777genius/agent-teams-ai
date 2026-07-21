import * as fs from 'node:fs';
import * as path from 'node:path';

import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import {
  ApplicationCommandLedgerWorkerOps,
  handleApplicationCommandLedgerOp,
} from './applicationCommandLedgerWorkerOps';
import {
  assertInternalStorageMutationAdmissionOpen,
  CoordinationDurabilityWorkerOps,
} from './coordinationDurabilityWorkerOps';
import {
  INTERNAL_STORAGE_SCHEMA_VERSION,
  readSchemaVersion,
  runInternalStorageMigrations,
} from './internalStorageMigrations';
import {
  commentJournalEntries,
  commentJournalTeams,
  stallJournalEntries,
  storeImports,
} from './internalStorageSchema';
import { parseJournalReplacePayload } from './internalStorageWorkerProtocol';
import { handleMemberWorkSyncOp, MemberWorkSyncWorkerOps } from './memberWorkSyncWorkerOps';
import { TeamIdentityStorageOps } from './teamIdentityStorageOps';

import type {
  CommentJournalEntryRecord,
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '../../../contracts/internalStorageContracts';
import type {
  InternalStorageWorkerOp,
  InternalStorageWorkerRequest,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';
import type { BetterSQLite3Database } from 'drizzle-orm/better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

// Keep row-count * column-count safely below SQLite's bound-variable limit.
const INSERT_CHUNK_SIZE = 400;

const INTEGRITY_CHECK_ERROR_PREFIX = 'integrity_check failed';

/**
 * Only confirmed corruption may trigger the backup-and-recreate path;
 * transient startup failures (mkdir, driver init, migration bugs) must
 * propagate instead of discarding a healthy database file.
 */
function isLikelyCorruptionError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }
  if (error.message.startsWith(INTEGRITY_CHECK_ERROR_PREFIX)) {
    return true;
  }
  const code = (error as { code?: unknown }).code;
  return (
    typeof code === 'string' && (code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB')
  );
}

export interface InternalStorageWorkerCoreOptions {
  databasePath: string;
  /** Injected so tests can pass a Node-ABI build of better-sqlite3. */
  createDatabase(
    databasePath: string,
    options?: { readonly?: boolean; fileMustExist?: boolean }
  ): SqliteDatabase;
  now?(): Date;
}

interface OpenState {
  db: SqliteDatabase;
  orm: BetterSQLite3Database;
  integrity: 'ok' | 'recovered';
}

/**
 * Synchronous op handlers around a single better-sqlite3 connection. Runs
 * inside the worker thread; the client serializes calls, so no re-entrancy.
 */
export class InternalStorageWorkerCore {
  private state: OpenState | null = null;
  private readonly applicationCommandLedgerOps = new ApplicationCommandLedgerWorkerOps(
    () => this.open().orm,
    () => this.open().db
  );
  private readonly coordinationDurabilityOps: CoordinationDurabilityWorkerOps;
  private readonly memberWorkSyncOps = new MemberWorkSyncWorkerOps(() => this.open().orm);
  private readonly teamIdentityOps = new TeamIdentityStorageOps(() => this.open().db);

  constructor(private readonly options: InternalStorageWorkerCoreOptions) {
    this.coordinationDurabilityOps = new CoordinationDurabilityWorkerOps(
      () => this.open().db,
      (databasePath, databaseOptions) => this.options.createDatabase(databasePath, databaseOptions),
      this.options.databasePath
    );
  }

  handle(op: InternalStorageWorkerOp, payload: InternalStorageWorkerRequest['payload']): unknown {
    if (op === 'stallJournal.replace' || op === 'commentJournal.replace') {
      parseJournalReplacePayload(op, payload);
    }
    this.assertMutationAdmission(op, payload);
    switch (op) {
      case 'ping':
        return this.ping();
      case 'stallJournal.load':
        return this.loadStallJournalEntries((payload as { teamName: string }).teamName);
      case 'stallJournal.replace': {
        const typed = parseJournalReplacePayload('stallJournal.replace', payload);
        this.replaceStallJournalEntries(typed.teamName, typed.entries);
        return null;
      }
      case 'commentJournal.load':
        return this.loadCommentJournalEntries((payload as { teamName: string }).teamName);
      case 'commentJournal.replace': {
        const typed = parseJournalReplacePayload('commentJournal.replace', payload);
        this.replaceCommentJournalEntries(typed.teamName, typed.entries);
        return null;
      }
      case 'commentJournal.exists':
        return this.commentJournalExists((payload as { teamName: string }).teamName);
      case 'commentJournal.ensureInitialized':
        this.ensureCommentJournalInitialized((payload as { teamName: string }).teamName);
        return null;
      case 'storeImports.record': {
        const typed = payload as { storeId: string; teamName: string; entryCount: number };
        this.recordStoreImport(typed.storeId, typed.teamName, typed.entryCount);
        return null;
      }
      case 'storeImports.has': {
        const typed = payload as { storeId: string; teamName: string };
        return this.hasStoreImport(typed.storeId, typed.teamName);
      }
      case 'teamIdentity.list':
        return this.teamIdentityOps.listIdentities();
      case 'teamIdentity.get':
        return this.teamIdentityOps.getIdentity(
          (payload as Extract<InternalStorageWorkerRequest, { op: 'teamIdentity.get' }>['payload'])
            .teamId
        );
      case 'close':
        this.close();
        return null;
      default: {
        if (typeof op === 'string' && op.startsWith('coordination')) {
          return this.coordinationDurabilityOps.handle(op as never, payload as never);
        }
        if (typeof op === 'string' && op.startsWith('appCommandLedger.')) {
          return handleApplicationCommandLedgerOp(this.applicationCommandLedgerOps, op, payload);
        }
        if (typeof op === 'string' && op.startsWith('mws.')) {
          return handleMemberWorkSyncOp(this.memberWorkSyncOps, op, payload);
        }
        throw new Error(`Unknown internal-storage op: ${String(op)}`);
      }
    }
  }

  /**
   * Async operations remain serialized by the worker client and are awaited
   * before a response is posted. In particular, Database#backup() must never
   * escape over the worker wire as an unresolved Promise.
   */
  async handleAsync(
    op: InternalStorageWorkerOp,
    payload: InternalStorageWorkerRequest['payload']
  ): Promise<unknown> {
    if (typeof op === 'string' && op.startsWith('coordination')) {
      this.assertMutationAdmission(op, payload);
      return this.coordinationDurabilityOps.handleAsync(op as never, payload as never);
    }
    return this.handle(op, payload);
  }

  private assertMutationAdmission(
    op: InternalStorageWorkerOp,
    payload: InternalStorageWorkerRequest['payload']
  ): void {
    if (!isInternalStorageMutation(op)) return;
    if (op === 'coordinationBackupFence.acquire' || op === 'coordinationBackupFence.complete') {
      // These two operations validate the full durable fence identity atomically.
      return;
    }
    const admittedBackupRunId = backupOwnedMutationRunId(op, payload);
    assertInternalStorageMutationAdmissionOpen(this.open().db, admittedBackupRunId);
  }

  private ping(): InternalStorageBackendInfo {
    const state = this.open();
    return {
      driver: 'better-sqlite3',
      databasePath: this.options.databasePath,
      schemaVersion: readSchemaVersion(state.db),
      integrity: state.integrity,
    };
  }

  private loadStallJournalEntries(teamName: string): StallJournalEntryRecord[] {
    const { orm } = this.open();
    return orm
      .select()
      .from(stallJournalEntries)
      .where(eq(stallJournalEntries.teamName, teamName))
      .all();
  }

  private replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): void {
    const { orm } = this.open();
    orm.transaction((tx) => {
      tx.delete(stallJournalEntries).where(eq(stallJournalEntries.teamName, teamName)).run();
      for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
        tx.insert(stallJournalEntries)
          .values(entries.slice(start, start + INSERT_CHUNK_SIZE))
          .run();
      }
    });
  }

  private loadCommentJournalEntries(teamName: string): CommentJournalEntryRecord[] {
    const { orm } = this.open();
    return orm
      .select()
      .from(commentJournalEntries)
      .where(eq(commentJournalEntries.teamName, teamName))
      .all();
  }

  /**
   * Replaces the team's journal rows AND marks the team as initialized in the
   * same transaction — a journal that was written (even with zero entries)
   * must report exists()=true, otherwise the seeding baseline re-runs and the
   * lead gets re-notified about historical comments.
   */
  private replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): void {
    const { orm } = this.open();
    const initializedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm.transaction((tx) => {
      tx.delete(commentJournalEntries).where(eq(commentJournalEntries.teamName, teamName)).run();
      for (let start = 0; start < entries.length; start += INSERT_CHUNK_SIZE) {
        tx.insert(commentJournalEntries)
          .values(entries.slice(start, start + INSERT_CHUNK_SIZE))
          .run();
      }
      tx.insert(commentJournalTeams)
        .values({ teamName, initializedAt })
        .onConflictDoNothing()
        .run();
    });
  }

  private commentJournalExists(teamName: string): boolean {
    const { orm } = this.open();
    const rows = orm
      .select({ teamName: commentJournalTeams.teamName })
      .from(commentJournalTeams)
      .where(eq(commentJournalTeams.teamName, teamName))
      .all();
    return rows.length > 0;
  }

  private ensureCommentJournalInitialized(teamName: string): void {
    const { orm } = this.open();
    const initializedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm.insert(commentJournalTeams).values({ teamName, initializedAt }).onConflictDoNothing().run();
  }

  private recordStoreImport(storeId: string, teamName: string, entryCount: number): void {
    const { orm } = this.open();
    const importedAt = (this.options.now?.() ?? new Date()).toISOString();
    orm
      .insert(storeImports)
      .values({ storeId, teamName, importedAt, entryCount })
      .onConflictDoUpdate({
        target: [storeImports.storeId, storeImports.teamName],
        set: { importedAt, entryCount },
      })
      .run();
  }

  private hasStoreImport(storeId: string, teamName: string): boolean {
    const { orm } = this.open();
    return (
      orm
        .select({ storeId: storeImports.storeId })
        .from(storeImports)
        .where(and(eq(storeImports.storeId, storeId), eq(storeImports.teamName, teamName)))
        .all().length > 0
    );
  }

  close(): void {
    if (!this.state) {
      return;
    }
    const { db } = this.state;
    this.state = null;
    try {
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
  }

  private open(): OpenState {
    if (this.state) {
      return this.state;
    }

    let integrity: 'ok' | 'recovered' = 'ok';
    let db: SqliteDatabase;
    try {
      db = this.openOnce();
    } catch (initialError) {
      if (!isLikelyCorruptionError(initialError)) {
        throw initialError;
      }
      // A corrupt database is backed up (never deleted) and recreated; the
      // journals can be re-imported from *.pre-sqlite JSON archives.
      this.backupCorruptDatabaseFiles();
      integrity = 'recovered';
      try {
        db = this.openOnce();
      } catch (retryError) {
        const retryMessage = retryError instanceof Error ? retryError.message : String(retryError);
        const initialMessage =
          initialError instanceof Error ? initialError.message : String(initialError);
        throw new Error(
          `Failed to open internal storage after corruption recovery: ${retryMessage} (initial error: ${initialMessage})`
        );
      }
    }

    this.state = { db, orm: drizzle(db), integrity };
    return this.state;
  }

  private openOnce(): SqliteDatabase {
    fs.mkdirSync(path.dirname(this.options.databasePath), { recursive: true });
    const db = this.options.createDatabase(this.options.databasePath);
    try {
      db.pragma('foreign_keys = ON');
      if (db.pragma('foreign_keys', { simple: true }) !== 1) {
        throw new Error('SQLite foreign key enforcement could not be enabled');
      }
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      const integrityResult = db.pragma('integrity_check', { simple: true });
      if (integrityResult !== 'ok') {
        throw new Error(`integrity_check failed: ${String(integrityResult)}`);
      }
      const schemaBefore = readSchemaVersion(db);
      if (schemaBefore > INTERNAL_STORAGE_SCHEMA_VERSION) {
        throw new Error(
          `Unsupported future internal storage schema version: ${schemaBefore} > ${INTERNAL_STORAGE_SCHEMA_VERSION}`
        );
      }
      runInternalStorageMigrations(db);
      return db;
    } catch (error) {
      try {
        db.close();
      } catch {
        // preserve the original error
      }
      throw error;
    }
  }

  private backupCorruptDatabaseFiles(): void {
    const stamp = (this.options.now?.() ?? new Date()).toISOString().replace(/[:.]/g, '-');
    for (const suffix of ['', '-wal', '-shm']) {
      const filePath = `${this.options.databasePath}${suffix}`;
      try {
        if (fs.existsSync(filePath)) {
          fs.renameSync(filePath, `${this.options.databasePath}.corrupt-${stamp}${suffix}`);
        }
      } catch {
        // Backup is best-effort; the retry open will surface real failures.
      }
    }
  }
}

const READ_ONLY_APPLICATION_COMMAND_OPS = new Set<InternalStorageWorkerOp>([
  'appCommandLedger.getByCommandId',
  'appCommandLedger.getByIdempotencyKey',
  'appCommandLedger.listByScope',
  'appCommandLedger.durable.getStatus',
  'appCommandLedger.durable.getByClaim',
  'appCommandLedger.durable.listOutbox',
  'appCommandLedger.durable.getConsumerProjection',
]);

const READ_ONLY_MEMBER_WORK_SYNC_OPS = new Set<InternalStorageWorkerOp>([
  'mws.status.read',
  'mws.status.list',
  'mws.metricEvents.list',
  'mws.reports.listPending',
  'mws.outbox.countRecentDelivered',
  'mws.outbox.countDeliveredForAgenda',
  'mws.outbox.findDeliveredReviewPickupEventIds',
  'mws.outbox.findRecentRecoveryByIntent',
  'mws.snapshot.list',
]);

const READ_ONLY_COORDINATION_OPS = new Set<InternalStorageWorkerOp>([
  // Initialization performs its own admission check only when metadata is absent.
  'coordinationEvents.initialize',
  'coordinationEvents.getWatermark',
  'coordinationEvents.read',
  'coordinationBackupRuns.get',
  'coordinationBackupRuns.listRecoverable',
  'coordinationBackup.sqlite.verify',
  'coordinationBackup.sqlite.readChunk',
]);

function isInternalStorageMutation(op: InternalStorageWorkerOp): boolean {
  switch (op) {
    case 'ping':
    case 'stallJournal.load':
    case 'commentJournal.load':
    case 'commentJournal.exists':
    case 'storeImports.has':
    case 'teamIdentity.list':
    case 'teamIdentity.get':
    case 'close':
      return false;
    default:
      if (op.startsWith('appCommandLedger.')) return !READ_ONLY_APPLICATION_COMMAND_OPS.has(op);
      if (op.startsWith('mws.')) return !READ_ONLY_MEMBER_WORK_SYNC_OPS.has(op);
      if (op.startsWith('coordination')) return !READ_ONLY_COORDINATION_OPS.has(op);
      return true;
  }
}

function backupOwnedMutationRunId(
  op: InternalStorageWorkerOp,
  payload: InternalStorageWorkerRequest['payload']
): string | null {
  if (
    op === 'coordinationBackupRuns.compareAndSet' ||
    op === 'coordinationBackupFlush.drain' ||
    op === 'coordinationBackup.sqlite.online' ||
    op === 'coordinationBackup.sqlite.discard'
  ) {
    return (payload as { readonly backupRunId?: string }).backupRunId ?? null;
  }
  if (op === 'coordinationBackupFlush.capture') {
    return (
      (payload as { readonly evidence?: { readonly backupRunId?: string } }).evidence
        ?.backupRunId ?? null
    );
  }
  return null;
}
