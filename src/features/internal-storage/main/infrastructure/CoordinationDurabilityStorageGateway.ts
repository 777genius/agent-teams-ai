import type {
  CoordinationDrainStorageEvidence,
  SqliteBackupChunkStorageResult,
  SqliteOnlineBackupStorageResult,
  SqliteSnapshotVerificationStorageResult,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
  StoredSnapshotRetentionLease,
  StoredSnapshotRetentionLeaseUse,
} from './worker/internalStorageWorkerProtocol';
import type {
  BackupFenceCompletionDisposition,
  BackupRunRecord,
  BackupRunState,
} from '@features/coordination-backup/contracts';
import type { CoordinationSnapshotRequest } from '@features/coordination-events';
import type {
  CoordinationEventDraft,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';

export type {
  CoordinationDrainStorageEvidence,
  SqliteBackupChunkStorageResult,
  SqliteOnlineBackupStorageResult,
  SqliteSnapshotVerificationStorageResult,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
  StoredSnapshotRetentionLease,
  StoredSnapshotRetentionLeaseUse,
} from './worker/internalStorageWorkerProtocol';

/**
 * Main-process capability over the one internal-storage worker. Snapshot
 * staging uses backup-run-bound chunks; no filesystem destination capability
 * crosses this interface or the worker protocol.
 */
export interface CoordinationDurabilityStorageGateway {
  coordinationEventInitialize(input: {
    readonly deploymentId: string;
    readonly eventEpoch?: string;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata>;
  coordinationEventGetWatermark(deploymentId: string): Promise<StoredEventJournalMetadata>;
  coordinationEventRead(input: {
    readonly deploymentId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<{
    readonly rows: readonly StoredCoordinationEventRow[];
    readonly watermark: StoredEventJournalMetadata;
  }>;
  coordinationEventAppend(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly draft: CoordinationEventDraft<CoordinationJsonValue>;
    readonly bodyJson: string;
    readonly nowIso: string;
  }): Promise<{
    readonly row: StoredCoordinationEventRow;
    readonly watermark: StoredEventJournalMetadata;
  }>;
  coordinationEventPrune(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly throughSequence: number;
    readonly nowMs: number;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata>;
  coordinationEventAcquireLease(input: {
    readonly deploymentId: string;
    readonly leaseId: string;
    readonly request: CoordinationSnapshotRequest;
    readonly nowMs: number;
    readonly deadlineAtMs: number;
  }): Promise<StoredSnapshotRetentionLease>;
  coordinationEventBeginLeaseUse(input: {
    readonly leaseId: string;
    readonly useToken: string;
    readonly nowMs: number;
  }): Promise<StoredSnapshotRetentionLeaseUse>;
  coordinationEventEndLeaseUse(input: {
    readonly leaseId: string;
    readonly useToken: string;
  }): Promise<void>;
  coordinationEventReleaseLease(leaseId: string): Promise<void>;
  coordinationBackupRunCreate(record: BackupRunRecord): Promise<BackupRunRecord>;
  coordinationBackupRunGet(backupRunId: string): Promise<BackupRunRecord | null>;
  coordinationBackupRunListRecoverable(): Promise<readonly BackupRunRecord[]>;
  coordinationBackupRunCompareAndSet(input: {
    readonly backupRunId: string;
    readonly expectedRevision: number;
    readonly expectedState: BackupRunState;
    readonly record: BackupRunRecord;
  }): Promise<BackupRunRecord>;
  coordinationBackupFenceAcquire(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly expectedGeneration: number | null;
    readonly leaseId: string;
    readonly acquiredAt: string;
  }): Promise<
    | { readonly status: 'acquired'; readonly generation: number; readonly leaseId: string }
    | { readonly status: 'busy'; readonly activeRunId: string }
  >;
  coordinationBackupFenceComplete(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly disposition: BackupFenceCompletionDisposition;
    readonly completedAt: string;
  }): Promise<void>;
  coordinationBackupDrain(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }): Promise<CoordinationDrainStorageEvidence>;
  coordinationBackupCapture(input: {
    readonly deploymentId: string;
    readonly evidence: CoordinationDrainStorageEvidence;
  }): Promise<CoordinationDrainStorageEvidence>;
  coordinationBackupSqliteOnline(input: {
    readonly backupRunId: string;
    readonly deadlineAtMs: number;
    readonly busyRetryMs: number;
    readonly pagesPerStep: number;
  }): Promise<SqliteOnlineBackupStorageResult>;
  coordinationBackupSqliteVerify(input: {
    readonly backupRunId: string;
  }): Promise<SqliteSnapshotVerificationStorageResult>;
  coordinationBackupSqliteReadChunk(input: {
    readonly backupRunId: string;
    readonly offset: number;
    readonly maximumBytes: number;
  }): Promise<SqliteBackupChunkStorageResult>;
  coordinationBackupSqliteDiscard(backupRunId: string): Promise<void>;
}
