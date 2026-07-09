import type {
  CommentJournalEntryRecord,
  InternalStorageBackendInfo,
  MemberWorkSyncMetricEventRecord,
  MemberWorkSyncOutboxEnsureRecordInput,
  MemberWorkSyncOutboxEnsureRecordResult,
  MemberWorkSyncOutboxItemRecord,
  MemberWorkSyncReportIntentRecord,
  MemberWorkSyncStatusRecord,
  MemberWorkSyncTeamSnapshotRecords,
  StallJournalEntryRecord,
} from '../../contracts/internalStorageContracts';
import type {
  ApplicationCommandLedgerBeginRequest,
  ApplicationCommandLedgerBeginResult,
  ApplicationCommandLedgerCompleteRequest,
  ApplicationCommandLedgerFailRequest,
  ApplicationCommandLedgerListScopeRequest,
  ApplicationCommandLedgerReadByCommandIdRequest,
  ApplicationCommandLedgerReadByIdempotencyKeyRequest,
  ApplicationCommandLedgerRecord,
} from '@features/application-command-ledger/contracts';

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
  loadCommentJournalEntries(teamName: string): Promise<CommentJournalEntryRecord[]>;
  /**
   * Atomically replaces the team's journal rows and marks the team as
   * initialized in the same transaction (exists() must become true even for
   * an empty journal — see TaskCommentNotificationJournalStore semantics).
   */
  replaceCommentJournalEntries(
    teamName: string,
    entries: CommentJournalEntryRecord[]
  ): Promise<void>;
  commentJournalExists(teamName: string): Promise<boolean>;
  ensureCommentJournalInitialized(teamName: string): Promise<void>;
  /** Audit trail: records a completed legacy-JSON import. */
  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void>;
  /** WAL checkpoint + close; the worker is terminated afterwards. */
  close(): Promise<void>;
}

/**
 * Member-work-sync persistence over the SQLite worker. This is message
 * delivery state: every mutating call is a single worker-side transaction
 * with the JSON store's exact semantics (terminal statuses are immutable,
 * attemptGeneration is an optimistic lock, stale claims become claimable).
 */
export interface MemberWorkSyncStorageGateway {
  ping(): Promise<InternalStorageBackendInfo>;
  statusRead(teamName: string, memberKey: string): Promise<MemberWorkSyncStatusRecord | null>;
  statusWrite(
    record: MemberWorkSyncStatusRecord,
    events: MemberWorkSyncMetricEventRecord[]
  ): Promise<void>;
  statusList(teamName: string): Promise<MemberWorkSyncStatusRecord[]>;
  metricEventsList(teamName: string): Promise<MemberWorkSyncMetricEventRecord[]>;
  reportsAppend(record: MemberWorkSyncReportIntentRecord): Promise<void>;
  reportsListPending(teamName: string): Promise<MemberWorkSyncReportIntentRecord[]>;
  reportsMarkProcessed(
    teamName: string,
    id: string,
    result: { status: string; resultCode: string; processedAt: string }
  ): Promise<void>;
  outboxEnsurePending(
    input: MemberWorkSyncOutboxEnsureRecordInput
  ): Promise<MemberWorkSyncOutboxEnsureRecordResult>;
  outboxClaimDue(input: {
    teamName: string;
    claimedBy: string;
    nowIso: string;
    limit: number;
  }): Promise<MemberWorkSyncOutboxItemRecord[]>;
  outboxMarkDelivered(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    deliveredMessageId: string;
    deliveryState: string | null;
    deliveryDiagnosticsJson: string | null;
    nowIso: string;
  }): Promise<void>;
  outboxMarkSuperseded(input: {
    teamName: string;
    id: string;
    reason: string;
    nowIso: string;
  }): Promise<void>;
  outboxMarkFailed(input: {
    teamName: string;
    id: string;
    attemptGeneration: number;
    error: string;
    retryable: boolean;
    nextAttemptAt: string | null;
    nowIso: string;
  }): Promise<void>;
  outboxCountRecentDelivered(input: {
    teamName: string;
    memberKey: string;
    sinceIso: string;
    workSyncIntentKeyPrefix: string | null;
  }): Promise<number>;
  outboxCountDeliveredForAgenda(input: {
    teamName: string;
    memberKey: string;
    agendaFingerprint: string;
    sinceIso: string | null;
  }): Promise<number>;
  outboxFindDeliveredReviewPickupEventIds(input: {
    teamName: string;
    memberKey: string;
    reviewRequestEventIds: string[];
  }): Promise<string[]>;
  outboxFindRecentRecoveryByIntent(input: {
    teamName: string;
    memberKey: string;
    intentKey: string;
    sinceIso: string;
  }): Promise<MemberWorkSyncOutboxItemRecord | null>;
  listTeamSnapshot(teamName: string): Promise<MemberWorkSyncTeamSnapshotRecords>;
  importTeam(teamName: string, snapshot: MemberWorkSyncTeamSnapshotRecords): Promise<void>;
  recordStoreImport(storeId: string, teamName: string, entryCount: number): Promise<void>;
}

/**
 * Universal application-command persistence over the same internal SQLite
 * worker. The semantic runner lives in application-command-ledger; this port
 * only exposes atomic storage transitions.
 */
export interface ApplicationCommandLedgerStorageGateway {
  ping(): Promise<InternalStorageBackendInfo>;
  applicationCommandLedgerBegin<TOperation extends string>(
    request: ApplicationCommandLedgerBeginRequest<TOperation>
  ): Promise<ApplicationCommandLedgerBeginResult<TOperation>>;
  applicationCommandLedgerMarkCompleted(
    request: ApplicationCommandLedgerCompleteRequest
  ): Promise<void>;
  applicationCommandLedgerMarkFailed(request: ApplicationCommandLedgerFailRequest): Promise<void>;
  applicationCommandLedgerGetByCommandId<TOperation extends string>(
    request: ApplicationCommandLedgerReadByCommandIdRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  applicationCommandLedgerGetByIdempotencyKey<TOperation extends string>(
    request: ApplicationCommandLedgerReadByIdempotencyKeyRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation> | null>;
  applicationCommandLedgerListByScope<TOperation extends string>(
    request: ApplicationCommandLedgerListScopeRequest
  ): Promise<ApplicationCommandLedgerRecord<TOperation>[]>;
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
