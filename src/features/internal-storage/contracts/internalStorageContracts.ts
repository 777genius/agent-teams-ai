export const INTERNAL_STORAGE_DIRNAME = 'storage';
export const INTERNAL_STORAGE_DATABASE_FILENAME = 'app.db';

export const STALL_JOURNAL_STORE_ID = 'stall-monitor-journal';
export const COMMENT_JOURNAL_STORE_ID = 'comment-notification-journal';

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

/** Wire-safe row shape for comment-notification journal entries. */
export interface CommentJournalEntryRecord {
  key: string;
  teamName: string;
  taskId: string;
  commentId: string;
  author: string;
  commentCreatedAt: string | null;
  messageId: string | null;
  state: string;
  createdAt: string;
  updatedAt: string;
  sentAt: string | null;
}

export interface InternalStorageBackendInfo {
  driver: 'better-sqlite3';
  databasePath: string;
  schemaVersion: number;
  /** 'recovered' means a corrupt database file was backed up and recreated. */
  integrity: 'ok' | 'recovered';
}
