export const INTERNAL_STORAGE_DIRNAME = 'storage';
export const INTERNAL_STORAGE_DATABASE_FILENAME = 'app.db';

export const STALL_JOURNAL_STORE_ID = 'stall-monitor-journal';

export type InternalStorageBackendKind = 'sqlite' | 'json-fallback';

/**
 * Wire-safe row shape for stall journal entries. Only primitives cross the
 * worker boundary; domain validation happens on the main side when mapping
 * back to TaskStallJournalEntry.
 */
export interface StallJournalEntryRecord {
  epochKey: string;
  teamName: string;
  taskId: string;
  memberName: string | null;
  branch: string;
  signal: string;
  state: string;
  consecutiveScans: number;
  createdAt: string;
  updatedAt: string;
  alertedAt: string | null;
}

export interface InternalStorageBackendInfo {
  driver: 'better-sqlite3';
  databasePath: string;
  schemaVersion: number;
  /** 'recovered' means a corrupt database file was backed up and recreated. */
  integrity: 'ok' | 'recovered';
}
