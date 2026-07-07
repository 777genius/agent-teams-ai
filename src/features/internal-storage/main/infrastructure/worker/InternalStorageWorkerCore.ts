import * as fs from 'node:fs';
import * as path from 'node:path';

import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/better-sqlite3';

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
import { handleMemberWorkSyncOp, MemberWorkSyncWorkerOps } from './memberWorkSyncWorkerOps';

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

export interface InternalStorageWorkerCoreOptions {
  databasePath: string;
  /** Injected so tests can pass a Node-ABI build of better-sqlite3. */
  createDatabase(databasePath: string): SqliteDatabase;
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
  private readonly memberWorkSyncOps = new MemberWorkSyncWorkerOps(() => this.open().orm);

  constructor(private readonly options: InternalStorageWorkerCoreOptions) {}

  handle(op: InternalStorageWorkerOp, payload: InternalStorageWorkerRequest['payload']): unknown {
    switch (op) {
      case 'ping':
        return this.ping();
      case 'stallJournal.load':
        return this.loadStallJournalEntries((payload as { teamName: string }).teamName);
      case 'stallJournal.replace': {
        const typed = payload as { teamName: string; entries: StallJournalEntryRecord[] };
        this.replaceStallJournalEntries(typed.teamName, typed.entries);
        return null;
      }
      case 'commentJournal.load':
        return this.loadCommentJournalEntries((payload as { teamName: string }).teamName);
      case 'commentJournal.replace': {
        const typed = payload as { teamName: string; entries: CommentJournalEntryRecord[] };
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
      case 'close':
        this.close();
        return null;
      default: {
        if (typeof op === 'string' && op.startsWith('mws.')) {
          return handleMemberWorkSyncOp(this.memberWorkSyncOps, op, payload);
        }
        throw new Error(`Unknown internal-storage op: ${String(op)}`);
      }
    }
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
      // A corrupt database is backed up (never deleted) and recreated; the
      // stall journal can be re-imported from *.pre-sqlite JSON archives.
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
      db.pragma('journal_mode = WAL');
      db.pragma('busy_timeout = 5000');
      db.pragma('synchronous = NORMAL');
      const integrityResult = db.pragma('integrity_check', { simple: true });
      if (integrityResult !== 'ok') {
        throw new Error(`integrity_check failed: ${String(integrityResult)}`);
      }
      const schemaBefore = readSchemaVersion(db);
      if (schemaBefore > INTERNAL_STORAGE_SCHEMA_VERSION) {
        // A newer app version already migrated this database. Schema v1+ is
        // append-only, so reading known tables is safe; never migrate down.
        return db;
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
