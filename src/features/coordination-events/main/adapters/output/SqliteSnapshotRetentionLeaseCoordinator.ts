import { randomUUID } from 'node:crypto';

import { EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION } from '../../../contracts';
import { materializeEventJournalWatermark } from '../../../core/domain';

import type {
  SnapshotRetentionLease,
  SnapshotRetentionLeaseCoordinator,
  SnapshotRetentionLeaseReleaseContext,
  SnapshotRetentionLeaseStatus,
} from '../../../core/application';
import type { CoordinationSnapshotRequest } from '../../../core/application';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export class SqliteSnapshotRetentionLeaseCoordinator implements SnapshotRetentionLeaseCoordinator {
  constructor(
    private readonly options: {
      readonly storage: CoordinationDurabilityStorageGateway;
      readonly deploymentId: string;
      readonly nowMs?: () => number;
      readonly createId?: () => string;
    }
  ) {
    if (!options.storage || !options.deploymentId) {
      throw new TypeError('sqlite-snapshot-retention-options-invalid');
    }
  }

  async acquireSnapshotLease(input: {
    readonly request: CoordinationSnapshotRequest;
    readonly ttlMs: number;
    readonly deadlineAtMs: number;
    readonly signal: AbortSignal;
  }): Promise<SnapshotRetentionLease> {
    if (input.signal.aborted) throw input.signal.reason;
    const nowMs = (this.options.nowMs ?? Date.now)();
    const maximumDeadline = nowMs + input.ttlMs;
    if (input.deadlineAtMs > maximumDeadline) {
      throw new Error('snapshot-retention-lease-deadline-exceeds-ttl');
    }
    const stored = await this.options.storage.coordinationEventAcquireLease({
      deploymentId: this.options.deploymentId,
      leaseId: (this.options.createId ?? randomUUID)(),
      request: input.request,
      nowMs,
      deadlineAtMs: input.deadlineAtMs,
    });
    return Object.freeze({
      leaseId: stored.leaseId,
      watermark: materializeEventJournalWatermark({
        schemaVersion: EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
        ...stored.watermark,
      }),
      deadlineAtMs: stored.deadlineAtMs,
    });
  }

  async runWithSnapshotLease<TResult>(input: {
    readonly leaseId: string;
    readonly run: (status: SnapshotRetentionLeaseStatus) => Promise<TResult>;
  }): Promise<TResult> {
    const useToken = (this.options.createId ?? randomUUID)();
    const stored = await this.options.storage.coordinationEventBeginLeaseUse({
      leaseId: input.leaseId,
      useToken,
      nowMs: (this.options.nowMs ?? Date.now)(),
    });
    const status = Object.freeze({
      active: stored.active,
      watermark: materializeEventJournalWatermark({
        schemaVersion: EVENT_JOURNAL_WATERMARK_SCHEMA_VERSION,
        ...stored.watermark,
      }),
    });
    try {
      return await input.run(status);
    } finally {
      if (stored.active) {
        await this.options.storage.coordinationEventEndLeaseUse({
          leaseId: input.leaseId,
          useToken,
        });
      }
    }
  }

  async releaseSnapshotLease(
    leaseId: string,
    _context: SnapshotRetentionLeaseReleaseContext
  ): Promise<void> {
    // Release is intentionally started even after cooperative cancellation;
    // core may stop awaiting it, but durable invalidation must still finish.
    await this.options.storage.coordinationEventReleaseLease(leaseId);
  }
}
