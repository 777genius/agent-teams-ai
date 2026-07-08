import type {
  InternalStorageBackendInfo,
  StallJournalEntryRecord,
} from '../../contracts/internalStorageContracts';

/**
 * Async gateway to the SQLite database that lives in a dedicated worker
 * thread. Every method is a single worker round-trip; multi-step invariants
 * (read-modify-write, import-verify-archive) are the caller's responsibility
 * and must be guarded by per-team mutual exclusion.
 */
export interface InternalStorageGateway {
  /** Opens the database, runs integrity check and migrations. Idempotent. */
  ping(): Promise<InternalStorageBackendInfo>;
  loadStallJournalEntries(teamName: string): Promise<StallJournalEntryRecord[]>;
  /** Atomically replaces all journal rows of the team in one transaction. */
  replaceStallJournalEntries(teamName: string, entries: StallJournalEntryRecord[]): Promise<void>;
  /** Audit trail: records a completed legacy-JSON import. */
  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void>;
  /** WAL checkpoint + close; the worker is terminated afterwards. */
  close(): Promise<void>;
}

/**
 * Legacy JSON file source for the one-time import into SQLite. The file is
 * never deleted — archive() renames it to a *.pre-sqlite copy that stays on
 * disk for several releases as a downgrade/recovery escape hatch.
 */
export interface LegacyJsonStoreSource<TRecord> {
  /** Returns null when no legacy file exists (nothing to import). */
  read(teamName: string): Promise<TRecord[] | null>;
  archive(teamName: string): Promise<void>;
}
