import { randomUUID } from 'node:crypto';

import { parseBackupRunId } from '../../../contracts';

import type {
  AcquireBackupWriterFenceRequest,
  AcquireBackupWriterFenceResult,
  BackupWriterFencePort,
  CompleteBackupWriterFenceRequest,
} from '../../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export class SqliteBackupWriterFence implements BackupWriterFencePort {
  private readonly nowIso: () => string;
  private readonly createLeaseId: () => string;

  constructor(
    private readonly options: {
      readonly storage: CoordinationDurabilityStorageGateway;
      readonly deploymentId: string;
      readonly nowIso?: () => string;
      readonly createLeaseId?: () => string;
    }
  ) {
    if (!options.storage || !options.deploymentId) {
      throw new TypeError('sqlite-backup-writer-fence-options-invalid');
    }
    this.nowIso = options.nowIso ?? (() => new Date().toISOString());
    this.createLeaseId = options.createLeaseId ?? randomUUID;
  }

  async acquire(request: AcquireBackupWriterFenceRequest): Promise<AcquireBackupWriterFenceResult> {
    const result = await this.options.storage.coordinationBackupFenceAcquire({
      deploymentId: this.options.deploymentId,
      backupRunId: request.backupRunId,
      expectedGeneration: request.expectedGeneration,
      leaseId: this.createLeaseId(),
      acquiredAt: this.nowIso(),
    });
    if (result.status === 'busy') {
      return Object.freeze({
        status: 'busy' as const,
        activeRunId: parseBackupRunId(result.activeRunId),
      });
    }
    return Object.freeze({
      status: 'acquired' as const,
      lease: Object.freeze({
        leaseId: result.leaseId,
        evidence: Object.freeze({
          generation: result.generation,
          admittedRunId: request.backupRunId,
        }),
      }),
    });
  }

  async complete(request: CompleteBackupWriterFenceRequest): Promise<void> {
    await this.options.storage.coordinationBackupFenceComplete({
      deploymentId: this.options.deploymentId,
      backupRunId: request.lease.evidence.admittedRunId,
      generation: request.lease.evidence.generation,
      leaseId: request.lease.leaseId,
      disposition: request.disposition,
      completedAt: this.nowIso(),
    });
  }
}
