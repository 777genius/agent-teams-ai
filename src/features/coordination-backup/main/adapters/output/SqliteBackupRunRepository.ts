import { assertBackupRunRecord } from '../../../core/domain';

import type { BackupRunId, BackupRunRecord, BackupRunTransitionRequest } from '../../../contracts';
import type {
  BackupRunRepository,
  CreateBackupRunRequest,
  MarkBackupFenceCompletedRequest,
  SaveBackupVerificationPlanRequest,
} from '../../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export class SqliteBackupRunRepository implements BackupRunRepository {
  constructor(private readonly storage: CoordinationDurabilityStorageGateway) {
    if (!storage) throw new TypeError('sqlite-backup-run-repository-storage-required');
  }

  async create(request: CreateBackupRunRequest): Promise<BackupRunRecord> {
    const record: BackupRunRecord = Object.freeze({
      backupRunId: request.backupRunId,
      deploymentId: request.deploymentId,
      productKind: 'coordination_backup',
      purpose: request.purpose,
      state: 'requested',
      revision: 1,
      requestedAt: request.requestedAt,
      updatedAt: request.requestedAt,
      participantDescriptors: Object.freeze(
        request.participantDescriptors.map((descriptor) => Object.freeze({ ...descriptor }))
      ),
      fence: null,
      fenceLeaseId: null,
      fenceCompletion: null,
      preparedParticipants: null,
      flushedParticipants: null,
      coordinationBarrier: null,
      identityInventory: null,
      sqliteSnapshot: null,
      stagedEntries: null,
      exclusions: null,
      verificationPlan: null,
      publication: null,
      failure: null,
    });
    assertBackupRunRecord(record);
    return this.requireValid(await this.storage.coordinationBackupRunCreate(record));
  }

  async get(backupRunId: BackupRunId): Promise<BackupRunRecord | null> {
    const record = await this.storage.coordinationBackupRunGet(backupRunId);
    return record ? this.requireValid(record) : null;
  }

  async listRecoverable(): Promise<readonly BackupRunRecord[]> {
    const records = await this.storage.coordinationBackupRunListRecoverable();
    return Object.freeze(records.map((record) => this.requireValid(record)));
  }

  async transition(request: BackupRunTransitionRequest): Promise<BackupRunRecord> {
    const current = await this.requireCurrent(
      request.backupRunId,
      request.expectedRevision,
      request.from
    );
    const record = applyTransition(current, request);
    return this.compareAndSet(current, record);
  }

  async saveVerificationPlan(request: SaveBackupVerificationPlanRequest): Promise<BackupRunRecord> {
    const current = await this.requireCurrent(
      request.backupRunId,
      request.expectedRevision,
      'verifying'
    );
    if (current.verificationPlan !== null) {
      throw new Error('backup-run-verification-plan-already-saved');
    }
    const record = Object.freeze({
      ...current,
      revision: current.revision + 1,
      updatedAt: request.at,
      verificationPlan: Object.freeze({ ...request.plan }),
    });
    return this.compareAndSet(current, record);
  }

  async markFenceCompleted(request: MarkBackupFenceCompletedRequest): Promise<BackupRunRecord> {
    const current = await this.requireCurrent(
      request.backupRunId,
      request.expectedRevision,
      undefined
    );
    const pending = current.fenceCompletion;
    if (
      pending?.status !== 'pending' ||
      pending.generation !== request.generation ||
      pending.disposition !== request.disposition
    ) {
      throw new Error('backup-run-fence-completion-mismatch');
    }
    const record = Object.freeze({
      ...current,
      revision: current.revision + 1,
      updatedAt: request.completedAt,
      fenceCompletion: Object.freeze({
        ...pending,
        status: 'completed' as const,
        completedAt: request.completedAt,
      }),
    });
    return this.compareAndSet(current, record);
  }

  private async requireCurrent(
    backupRunId: BackupRunId,
    expectedRevision: number,
    expectedState: BackupRunRecord['state'] | undefined
  ): Promise<BackupRunRecord> {
    const current = await this.get(backupRunId);
    if (!current) throw new Error('backup-run-not-found');
    if (
      current.revision !== expectedRevision ||
      (expectedState !== undefined && current.state !== expectedState)
    ) {
      throw new Error('backup-run-compare-and-set-failed');
    }
    return current;
  }

  private async compareAndSet(
    current: BackupRunRecord,
    record: BackupRunRecord
  ): Promise<BackupRunRecord> {
    assertBackupRunRecord(record);
    const stored = await this.storage.coordinationBackupRunCompareAndSet({
      backupRunId: current.backupRunId,
      expectedRevision: current.revision,
      expectedState: current.state,
      record,
    });
    const valid = this.requireValid(stored);
    if (
      valid.backupRunId !== record.backupRunId ||
      valid.revision !== record.revision ||
      valid.state !== record.state
    ) {
      throw new Error('backup-run-compare-and-set-result-mismatch');
    }
    return valid;
  }

  private requireValid(record: BackupRunRecord): BackupRunRecord {
    assertBackupRunRecord(record);
    return record;
  }
}

function applyTransition(
  current: BackupRunRecord,
  request: BackupRunTransitionRequest
): BackupRunRecord {
  const base = {
    ...current,
    state: request.to,
    revision: current.revision + 1,
    updatedAt: request.at,
  };
  let record: BackupRunRecord;
  switch (request.to) {
    case 'fencing':
      record = base;
      break;
    case 'quiescing':
      record = Object.freeze({
        ...base,
        fence: Object.freeze({ ...request.fence }),
        fenceLeaseId: request.fenceLeaseId,
      });
      break;
    case 'sqlite_snapshot':
      record = Object.freeze({
        ...base,
        preparedParticipants: Object.freeze([...request.preparedParticipants]),
        flushedParticipants: Object.freeze([...request.flushedParticipants]),
        coordinationBarrier: Object.freeze({ ...request.coordinationBarrier }),
        identityInventory: Object.freeze({ ...request.identityInventory }),
      });
      break;
    case 'file_stage':
      record = Object.freeze({
        ...base,
        sqliteSnapshot: Object.freeze({ ...request.sqliteSnapshot }),
      });
      break;
    case 'verifying':
      record = Object.freeze({
        ...base,
        stagedEntries: Object.freeze([...request.stagedEntries]),
        exclusions: Object.freeze([...request.exclusions]),
      });
      break;
    case 'committed':
      record = Object.freeze({
        ...base,
        publication: Object.freeze({ ...request.publication }),
        fenceCompletion: Object.freeze({ ...request.fenceCompletion }),
      });
      break;
    case 'failed':
    case 'operator_required':
      record = Object.freeze({
        ...base,
        failure: Object.freeze({ ...request.failure }),
        fence: request.fence ? Object.freeze({ ...request.fence }) : null,
        fenceLeaseId: request.fenceLeaseId,
        fenceCompletion: request.fenceCompletion
          ? Object.freeze({ ...request.fenceCompletion })
          : null,
      });
      break;
  }
  assertBackupRunRecord(record);
  return record;
}
