import { ProcessOwnershipStorageGatewayClient } from './ProcessOwnershipStorageGateway';

import type { CoordinationDurabilityStorageGateway } from '../application/coordinationDurabilityStorage';
import type {
  InternalStorageWorkerCallOptions,
  InternalStorageWorkerPayloadFor,
} from './InternalStorageWorkerTransport';
import type {
  CoordinationDrainStorageEvidence,
  InternalStorageWorkerRequest,
  SqliteBackupChunkStorageResult,
  SqliteOnlineBackupStorageResult,
  SqliteSnapshotVerificationStorageResult,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
} from './worker/internalStorageWorkerProtocol';
import type {
  BackupFenceCompletionDisposition,
  BackupRunRecord,
  BackupRunState,
} from '@features/coordination-backup/contracts';
import type {
  CoordinationEventDraft,
  CoordinationJsonValue,
} from '@features/coordination-events/contracts';

/** Typed coordination facade shared by internal-storage worker clients. */
export abstract class CoordinationDurabilityStorageGatewayClient
  extends ProcessOwnershipStorageGatewayClient
  implements CoordinationDurabilityStorageGateway
{
  protected abstract callCoordinationWorker<TOp extends InternalStorageWorkerRequest['op']>(
    op: TOp,
    payload: InternalStorageWorkerPayloadFor<TOp>,
    options?: InternalStorageWorkerCallOptions
  ): Promise<unknown>;

  async coordinationEventInitialize(input: {
    readonly deploymentId: string;
    readonly eventEpoch?: string;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata> {
    return (await this.callCoordinationWorker(
      'coordinationEvents.initialize',
      input
    )) as StoredEventJournalMetadata;
  }

  async coordinationEventGetWatermark(deploymentId: string): Promise<StoredEventJournalMetadata> {
    return (await this.callCoordinationWorker('coordinationEvents.getWatermark', {
      deploymentId,
    })) as StoredEventJournalMetadata;
  }

  async coordinationEventRead(input: {
    readonly deploymentId: string;
    readonly afterSequence: number;
    readonly throughSequence: number;
    readonly limit: number;
  }): Promise<{
    readonly rows: readonly StoredCoordinationEventRow[];
    readonly watermark: StoredEventJournalMetadata;
  }> {
    return (await this.callCoordinationWorker('coordinationEvents.read', input)) as {
      readonly rows: readonly StoredCoordinationEventRow[];
      readonly watermark: StoredEventJournalMetadata;
    };
  }

  async coordinationEventAppend(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly draft: CoordinationEventDraft<CoordinationJsonValue>;
    readonly bodyJson: string;
    readonly nowIso: string;
  }): Promise<{
    readonly row: StoredCoordinationEventRow;
    readonly watermark: StoredEventJournalMetadata;
  }> {
    return (await this.callCoordinationWorker('coordinationEvents.append', input)) as {
      readonly row: StoredCoordinationEventRow;
      readonly watermark: StoredEventJournalMetadata;
    };
  }

  async coordinationEventPrune(input: {
    readonly deploymentId: string;
    readonly eventEpoch: string;
    readonly throughSequence: number;
    readonly nowIso: string;
  }): Promise<StoredEventJournalMetadata> {
    return (await this.callCoordinationWorker(
      'coordinationEvents.prune',
      input
    )) as StoredEventJournalMetadata;
  }

  async coordinationBackupRunCreate(record: BackupRunRecord): Promise<BackupRunRecord> {
    return (await this.callCoordinationWorker('coordinationBackupRuns.create', {
      record,
    })) as BackupRunRecord;
  }

  async coordinationBackupRunGet(backupRunId: string): Promise<BackupRunRecord | null> {
    return (await this.callCoordinationWorker('coordinationBackupRuns.get', {
      backupRunId,
    })) as BackupRunRecord | null;
  }

  async coordinationBackupRunListRecoverable(): Promise<readonly BackupRunRecord[]> {
    return (await this.callCoordinationWorker(
      'coordinationBackupRuns.listRecoverable',
      {}
    )) as readonly BackupRunRecord[];
  }

  async coordinationBackupRunCompareAndSet(input: {
    readonly backupRunId: string;
    readonly expectedRevision: number;
    readonly expectedState: BackupRunState;
    readonly record: BackupRunRecord;
  }): Promise<BackupRunRecord> {
    return (await this.callCoordinationWorker(
      'coordinationBackupRuns.compareAndSet',
      input
    )) as BackupRunRecord;
  }

  async coordinationBackupFenceAcquire(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly expectedGeneration: number | null;
    readonly leaseId: string;
    readonly acquiredAt: string;
  }): Promise<
    | { readonly status: 'acquired'; readonly generation: number; readonly leaseId: string }
    | { readonly status: 'busy'; readonly activeRunId: string }
  > {
    return (await this.callCoordinationWorker('coordinationBackupFence.acquire', input)) as
      | { readonly status: 'acquired'; readonly generation: number; readonly leaseId: string }
      | { readonly status: 'busy'; readonly activeRunId: string };
  }

  async coordinationBackupFenceComplete(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly generation: number;
    readonly leaseId: string;
    readonly disposition: BackupFenceCompletionDisposition;
    readonly completedAt: string;
  }): Promise<void> {
    await this.callCoordinationWorker('coordinationBackupFence.complete', input);
  }

  async coordinationBackupDrain(input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }): Promise<CoordinationDrainStorageEvidence> {
    return (await this.callCoordinationWorker(
      'coordinationBackupFlush.drain',
      input
    )) as CoordinationDrainStorageEvidence;
  }

  async coordinationBackupCapture(input: {
    readonly deploymentId: string;
    readonly evidence: CoordinationDrainStorageEvidence;
  }): Promise<CoordinationDrainStorageEvidence> {
    return (await this.callCoordinationWorker(
      'coordinationBackupFlush.capture',
      input
    )) as CoordinationDrainStorageEvidence;
  }

  async coordinationBackupSqliteOnline(input: {
    readonly backupRunId: string;
    readonly deadlineAtMs: number;
    readonly busyRetryMs: number;
    readonly pagesPerStep: number;
  }): Promise<SqliteOnlineBackupStorageResult> {
    return (await this.callCoordinationWorker('coordinationBackup.sqlite.online', input, {
      timeoutAtMs: input.deadlineAtMs + 2_000,
    })) as SqliteOnlineBackupStorageResult;
  }

  async coordinationBackupSqliteVerify(input: {
    readonly backupRunId: string;
  }): Promise<SqliteSnapshotVerificationStorageResult> {
    return (await this.callCoordinationWorker(
      'coordinationBackup.sqlite.verify',
      input
    )) as SqliteSnapshotVerificationStorageResult;
  }

  async coordinationBackupSqliteReadChunk(input: {
    readonly backupRunId: string;
    readonly offset: number;
    readonly maximumBytes: number;
  }): Promise<SqliteBackupChunkStorageResult> {
    return (await this.callCoordinationWorker(
      'coordinationBackup.sqlite.readChunk',
      input
    )) as SqliteBackupChunkStorageResult;
  }

  async coordinationBackupSqliteDiscard(backupRunId: string): Promise<void> {
    await this.callCoordinationWorker('coordinationBackup.sqlite.discard', { backupRunId });
  }
}
