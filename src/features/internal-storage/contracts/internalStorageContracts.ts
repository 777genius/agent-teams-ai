export const INTERNAL_STORAGE_DIRNAME = 'storage';
export const INTERNAL_STORAGE_DATABASE_FILENAME = 'app.db';

export const STALL_JOURNAL_STORE_ID = 'stall-monitor-journal';
export const COMMENT_JOURNAL_STORE_ID = 'comment-notification-journal';
export const MEMBER_WORK_SYNC_STORE_ID = 'member-work-sync';

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

/**
 * Wire-safe member-work-sync rows. Domain payloads travel as JSON strings;
 * queryable fields are flattened into columns. memberKey/teamName follow the
 * JSON store's normalization (trimmed, lowercased keys) so lookups match.
 */
export interface MemberWorkSyncStatusRecord {
  teamName: string;
  memberKey: string;
  memberName: string;
  state: string;
  evaluatedAt: string;
  providerId: string | null;
  statusJson: string;
}

export interface MemberWorkSyncReportIntentRecord {
  teamName: string;
  id: string;
  memberKey: string;
  memberName: string;
  status: string;
  reason: string;
  recordedAt: string;
  processedAt: string | null;
  resultCode: string | null;
  requestJson: string;
}

export interface MemberWorkSyncOutboxItemRecord {
  teamName: string;
  id: string;
  memberKey: string;
  memberName: string;
  agendaFingerprint: string;
  payloadHash: string;
  status: string;
  attemptGeneration: number;
  claimedBy: string | null;
  claimedAt: string | null;
  deliveredMessageId: string | null;
  deliveryState: string | null;
  lastError: string | null;
  nextAttemptAt: string | null;
  createdAt: string;
  updatedAt: string;
  workSyncIntent: string;
  workSyncIntentKey: string | null;
  reviewRequestEventIdsJson: string | null;
  deliveryDiagnosticsJson: string | null;
  payloadJson: string;
}

export interface MemberWorkSyncMetricEventRecord {
  teamName: string;
  id: string;
  memberKey: string;
  memberName: string;
  kind: string;
  recordedAt: string;
  eventJson: string;
}

export interface MemberWorkSyncOutboxEnsureRecordInput {
  record: MemberWorkSyncOutboxItemRecord;
  nowIso: string;
  nextAttemptAt: string | null;
}

export type MemberWorkSyncOutboxEnsureRecordResult =
  | { ok: true; outcome: 'created' | 'existing'; item: MemberWorkSyncOutboxItemRecord }
  | {
      ok: false;
      outcome: 'payload_conflict';
      item: MemberWorkSyncOutboxItemRecord;
      existingPayloadHash: string;
      requestedPayloadHash: string;
    };

export interface MemberWorkSyncTeamSnapshotRecords {
  statuses: MemberWorkSyncStatusRecord[];
  reportIntents: MemberWorkSyncReportIntentRecord[];
  outboxItems: MemberWorkSyncOutboxItemRecord[];
  metricEvents: MemberWorkSyncMetricEventRecord[];
}

export interface InternalStorageBackendInfo {
  driver: 'better-sqlite3';
  databasePath: string;
  schemaVersion: number;
  /** 'recovered' means a corrupt database file was backed up and recreated. */
  integrity: 'ok' | 'recovered';
}
