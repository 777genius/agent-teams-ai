import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { assertBackupRunRecord, BACKUP_RUN_STATES } from '@features/coordination-backup';
import {
  assertCoordinationEventDraft,
  COORDINATION_EVENT_SCOPE_KINDS,
  type CoordinationEventDraft,
  type CoordinationJsonValue,
} from '@features/coordination-events';

import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from './internalStorageMigrations';

import type {
  CoordinationDrainStorageEvidence,
  CoordinationDurabilityWorkerPayloadByOp,
  SqliteBackupChunkStorageResult,
  SqliteOnlineBackupStorageResult,
  SqliteSnapshotVerificationStorageResult,
  StoredCommandCoordinationAttribution,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
  StoredSnapshotRetentionLease,
  StoredSnapshotRetentionLeaseUse,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

interface EventMetadataRow {
  deployment_id: string;
  event_epoch: string;
  retention_floor_sequence: number;
  high_watermark_sequence: number;
}

interface EventRow {
  deployment_id: string;
  event_epoch: string;
  event_sequence: number;
  event_id: string;
  body_json: string;
}

interface LeaseRow {
  lease_id: string;
  deployment_id: string;
  event_epoch: string;
  retention_floor_sequence: number;
  high_watermark_sequence: number;
  expires_at_ms: number;
  use_token: string | null;
  use_deadline_at_ms: number | null;
  release_requested: number;
  scope_kind: string;
  scope_id: string;
}

interface BackupRunRow {
  backup_run_id: string;
  deployment_id: string;
  state: string;
  revision: number;
  record_json: string;
}

interface WriterFenceRow {
  deployment_id: string;
  generation: number;
  admitted_run_id: string;
  lease_id: string;
  status: 'active' | 'released' | 'operator_required';
  disposition: 'committed' | 'aborted' | 'operator_required' | null;
  acquired_at: string;
  completed_at: string | null;
}

const MAX_EVENT_PAGE_SIZE = 10_000;
const EVENT_EPOCH_PREFIX = 'epoch-initial-v1-';
const ACTIVE_COMMAND_STATES = Object.freeze(['prepared', 'running', 'recovering'] as const);
const BACKUP_RUN_STATE_VALUES = new Set<string>(BACKUP_RUN_STATES);
const REQUIRED_IDENTITY_COMPONENT = 'team-identity';
const MAX_BACKUP_CHUNK_BYTES = 1024 * 1024;
const BACKUP_SCRATCH_DIRECTORY_SUFFIX = '.coordination-backup-staging';

export class CoordinationDurabilityWorkerOps {
  /**
   * A durable use token survives long enough to fail closed after a worker
   * crash, while this process-local set distinguishes a live callback from an
   * abandoned token. Pruning may expire the latter after restart, but must
   * never overtake the former while its callback is still running.
   */
  private readonly activeSnapshotLeaseUses = new Map<string, string>();

  constructor(
    private readonly getDb: () => SqliteDatabase,
    private readonly createDatabase: (
      databasePath: string,
      options?: { readonly?: boolean; fileMustExist?: boolean }
    ) => SqliteDatabase,
    databasePath: string
  ) {
    validateSnapshotPath(databasePath);
    this.backupScratchRoot = `${databasePath}${BACKUP_SCRATCH_DIRECTORY_SUFFIX}`;
  }

  private readonly backupScratchRoot: string;

  handle<TOp extends keyof CoordinationDurabilityWorkerPayloadByOp>(
    op: TOp,
    payload: CoordinationDurabilityWorkerPayloadByOp[TOp]
  ): unknown {
    switch (op) {
      case 'coordinationEvents.initialize':
        return this.initializeEventJournal(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.initialize']
        );
      case 'coordinationEvents.getWatermark':
        return this.getEventWatermark(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.getWatermark']
        );
      case 'coordinationEvents.read':
        return this.readEvents(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.read']
        );
      case 'coordinationEvents.append':
        return this.appendEvent(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.append']
        );
      case 'coordinationEvents.prune':
        return this.pruneEvents(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.prune']
        );
      case 'coordinationEvents.lease.acquire':
        return this.acquireSnapshotLease(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.acquire']
        );
      case 'coordinationEvents.lease.beginUse':
        return this.beginSnapshotLeaseUse(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.beginUse']
        );
      case 'coordinationEvents.lease.endUse':
        return this.endSnapshotLeaseUse(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.endUse']
        );
      case 'coordinationEvents.lease.release':
        return this.releaseSnapshotLease(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.release']
        );
      case 'coordinationBackupRuns.create':
        return this.createBackupRun(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.create']
        );
      case 'coordinationBackupRuns.get':
        return this.getBackupRun(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.get']
        );
      case 'coordinationBackupRuns.listRecoverable':
        return this.listRecoverableBackupRuns();
      case 'coordinationBackupRuns.compareAndSet':
        return this.compareAndSetBackupRun(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.compareAndSet']
        );
      case 'coordinationBackupFence.acquire':
        return this.acquireWriterFence(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFence.acquire']
        );
      case 'coordinationBackupFence.complete':
        return this.completeWriterFence(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFence.complete']
        );
      case 'coordinationBackupFlush.drain':
        return this.drainAcceptedCommands(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFlush.drain']
        );
      case 'coordinationBackupFlush.capture':
        return this.captureCoordinationBarrier(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFlush.capture']
        );
      case 'coordinationBackup.sqlite.verify':
        return this.verifySqliteSnapshot(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.verify']
        );
      case 'coordinationBackup.sqlite.readChunk':
        return this.readSqliteSnapshotChunk(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.readChunk']
        );
      case 'coordinationBackup.sqlite.online':
        throw new Error('SQLite Online Backup must be awaited through handleAsync');
      case 'coordinationBackup.sqlite.discard':
        throw new Error('SQLite backup scratch discard must be awaited through handleAsync');
      default:
        throw new Error(`Unknown coordination durability op: ${String(op)}`);
    }
  }

  async handleAsync<TOp extends keyof CoordinationDurabilityWorkerPayloadByOp>(
    op: TOp,
    payload: CoordinationDurabilityWorkerPayloadByOp[TOp]
  ): Promise<unknown> {
    if (op === 'coordinationBackup.sqlite.online') {
      return this.createOnlineBackup(
        payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.online']
      );
    }
    if (op === 'coordinationBackup.sqlite.discard') {
      const input =
        payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.discard'];
      assertIdentifier(input.backupRunId, 'backupRunId');
      await removePartialSnapshot(this.snapshotScratchPath(input.backupRunId));
      return null;
    }
    return this.handle(op, payload);
  }

  private initializeEventJournal(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.initialize']
  ): StoredEventJournalMetadata {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIsoTimestamp(input.nowIso, 'nowIso');
    if (input.eventEpoch !== undefined) assertIdentifier(input.eventEpoch, 'eventEpoch');
    const db = this.getDb();
    return db
      .transaction(() => {
        if (!readEventMetadata(db, input.deploymentId)) {
          assertInternalStorageMutationAdmissionOpen(db, null);
        }
        const metadata = ensureEventMetadata(
          db,
          input.deploymentId,
          input.eventEpoch,
          input.nowIso
        );
        assertJournalContinuity(db, metadata);
        return mapMetadata(metadata);
      })
      .immediate();
  }

  private getEventWatermark(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.getWatermark']
  ): StoredEventJournalMetadata {
    assertIdentifier(input.deploymentId, 'deploymentId');
    const db = this.getDb();
    return db.transaction(() => {
      const metadata = requireEventMetadata(db, input.deploymentId);
      assertJournalContinuity(db, metadata);
      return mapMetadata(metadata);
    })();
  }

  private readEvents(input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.read']): {
    readonly rows: readonly StoredCoordinationEventRow[];
    readonly watermark: StoredEventJournalMetadata;
  } {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertNonNegativeInteger(input.afterSequence, 'afterSequence');
    assertNonNegativeInteger(input.throughSequence, 'throughSequence');
    if (
      !Number.isSafeInteger(input.limit) ||
      input.limit <= 0 ||
      input.limit > MAX_EVENT_PAGE_SIZE
    ) {
      throw new Error('coordination-event-journal-limit-invalid');
    }
    const db = this.getDb();
    return db.transaction(() => {
      const metadata = requireEventMetadata(db, input.deploymentId);
      assertJournalContinuity(db, metadata);
      if (input.afterSequence < metadata.retention_floor_sequence) {
        throw new Error('coordination-event-journal-cursor-stale');
      }
      if (input.afterSequence > metadata.high_watermark_sequence) {
        throw new Error('coordination-event-journal-cursor-ahead');
      }
      const target = Math.min(input.throughSequence, metadata.high_watermark_sequence);
      if (target < input.afterSequence) {
        throw new Error('coordination-event-journal-range-invalid');
      }
      const rows = db
        .prepare(
          `SELECT deployment_id, event_epoch, event_sequence, event_id, body_json
           FROM coordination_event_journal
           WHERE deployment_id = ? AND event_epoch = ?
             AND event_sequence > ? AND event_sequence <= ?
           ORDER BY event_sequence ASC
           LIMIT ?`
        )
        .all(
          input.deploymentId,
          metadata.event_epoch,
          input.afterSequence,
          target,
          input.limit
        ) as EventRow[];
      const expectedCount = Math.min(input.limit, target - input.afterSequence);
      assertContiguousEventRows(rows, input.afterSequence + 1, expectedCount);
      return Object.freeze({
        rows: Object.freeze(rows.map(mapEventRow)),
        watermark: mapMetadata(metadata),
      });
    })();
  }

  private appendEvent(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.append']
  ): { readonly row: StoredCoordinationEventRow; readonly watermark: StoredEventJournalMetadata } {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.eventEpoch, 'eventEpoch');
    assertIsoTimestamp(input.nowIso, 'nowIso');
    assertCoordinationEventDraft(input.draft);
    const canonicalBody = canonicalJson(input.draft);
    if (input.bodyJson !== canonicalBody) {
      throw new Error('coordination-event-journal-body-not-canonical');
    }
    const db = this.getDb();
    return db
      .transaction(() => {
        assertCoordinationMutationAdmissionOpen(db, input.deploymentId);
        return appendEventJournalRow(
          db,
          input.deploymentId,
          input.eventEpoch,
          input.draft,
          canonicalBody,
          null,
          input.nowIso
        );
      })
      .immediate();
  }

  private pruneEvents(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.prune']
  ): StoredEventJournalMetadata {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.eventEpoch, 'eventEpoch');
    assertNonNegativeInteger(input.throughSequence, 'throughSequence');
    assertPositiveInteger(input.nowMs, 'nowMs');
    assertIsoTimestamp(input.nowIso, 'nowIso');
    const db = this.getDb();
    return db
      .transaction(() => {
        const metadata = requireEventMetadata(db, input.deploymentId);
        requireEpoch(metadata, input.eventEpoch);
        assertJournalContinuity(db, metadata);
        const leaseRows = db
          .prepare(
            `SELECT *
             FROM snapshot_retention_leases
             WHERE deployment_id = ? AND event_epoch = ?`
          )
          .all(input.deploymentId, input.eventEpoch) as LeaseRow[];
        let pinnedSequence: number | null = null;
        for (const lease of leaseRows) {
          const activeUseToken = this.activeSnapshotLeaseUses.get(lease.lease_id);
          const liveUse =
            lease.use_token !== null &&
            activeUseToken !== undefined &&
            activeUseToken === lease.use_token;
          const retained =
            liveUse || (lease.release_requested === 0 && lease.expires_at_ms > input.nowMs);
          if (retained) {
            pinnedSequence = Math.min(
              pinnedSequence ?? lease.high_watermark_sequence,
              lease.high_watermark_sequence
            );
          } else {
            db.prepare('DELETE FROM snapshot_retention_leases WHERE lease_id = ?').run(
              lease.lease_id
            );
          }
        }
        const requestedFloor = Math.min(input.throughSequence, metadata.high_watermark_sequence);
        const nextFloor = Math.max(
          metadata.retention_floor_sequence,
          Math.min(requestedFloor, pinnedSequence ?? requestedFloor)
        );
        db.prepare(
          `DELETE FROM coordination_event_journal
           WHERE deployment_id = ? AND event_epoch = ? AND event_sequence <= ?`
        ).run(input.deploymentId, input.eventEpoch, nextFloor);
        db.prepare(
          `UPDATE coordination_event_journal_metadata
           SET retention_floor_sequence = ?, updated_at = ?
           WHERE deployment_id = ? AND event_epoch = ?`
        ).run(nextFloor, input.nowIso, input.deploymentId, input.eventEpoch);
        const updated = requireEventMetadata(db, input.deploymentId);
        assertJournalContinuity(db, updated);
        return mapMetadata(updated);
      })
      .immediate();
  }

  private acquireSnapshotLease(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.acquire']
  ): StoredSnapshotRetentionLease {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.leaseId, 'leaseId');
    assertIdentifier(input.request.scopeKind, 'scopeKind');
    assertIdentifier(input.request.scopeId, 'scopeId');
    if (!COORDINATION_EVENT_SCOPE_KINDS.includes(input.request.scopeKind)) {
      throw new Error('snapshot-retention-lease-scope-kind-invalid');
    }
    assertPositiveInteger(input.nowMs, 'nowMs');
    assertPositiveInteger(input.deadlineAtMs, 'deadlineAtMs');
    if (input.deadlineAtMs <= input.nowMs) throw new Error('snapshot-retention-lease-expired');
    const db = this.getDb();
    return db
      .transaction(() => {
        const existing = readLease(db, input.leaseId);
        if (existing) {
          if (
            existing.deployment_id !== input.deploymentId ||
            existing.scope_kind !== input.request.scopeKind ||
            existing.scope_id !== input.request.scopeId ||
            existing.expires_at_ms !== input.deadlineAtMs
          ) {
            throw new Error('snapshot-retention-lease-id-conflict');
          }
          return mapLease(existing);
        }
        const metadata = requireEventMetadata(db, input.deploymentId);
        assertJournalContinuity(db, metadata);
        db.prepare(
          `INSERT INTO snapshot_retention_leases (
             lease_id, deployment_id, event_epoch, scope_kind, scope_id,
             retention_floor_sequence, high_watermark_sequence, expires_at_ms,
             use_token, use_deadline_at_ms, release_requested, created_at_ms
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, 0, ?)`
        ).run(
          input.leaseId,
          input.deploymentId,
          metadata.event_epoch,
          input.request.scopeKind,
          input.request.scopeId,
          metadata.retention_floor_sequence,
          metadata.high_watermark_sequence,
          input.deadlineAtMs,
          input.nowMs
        );
        return mapLease(requireLease(db, input.leaseId));
      })
      .immediate();
  }

  private beginSnapshotLeaseUse(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.beginUse']
  ): StoredSnapshotRetentionLeaseUse {
    assertIdentifier(input.leaseId, 'leaseId');
    assertIdentifier(input.useToken, 'useToken');
    assertPositiveInteger(input.nowMs, 'nowMs');
    const db = this.getDb();
    const result = db
      .transaction(() => {
        const lease = readLease(db, input.leaseId);
        if (!lease) throw new Error('snapshot-retention-lease-not-found');
        const metadata = requireEventMetadata(db, lease.deployment_id);
        assertJournalContinuity(db, metadata);
        const active = lease.release_requested === 0 && input.nowMs < lease.expires_at_ms;
        if (!active) {
          return Object.freeze({ active: false, watermark: mapMetadata(metadata) });
        }
        if (
          metadata.event_epoch !== lease.event_epoch ||
          metadata.retention_floor_sequence > lease.high_watermark_sequence
        ) {
          throw new Error('snapshot-retention-lease-overtaken');
        }
        if (lease.use_token !== null && lease.use_token !== input.useToken) {
          throw new Error('snapshot-retention-lease-already-in-use');
        }
        db.prepare(
          `UPDATE snapshot_retention_leases
           SET use_token = ?, use_deadline_at_ms = ?
           WHERE lease_id = ?`
        ).run(input.useToken, lease.expires_at_ms, input.leaseId);
        return Object.freeze({ active: true, watermark: mapMetadata(lease) });
      })
      .immediate();
    if (result.active) this.activeSnapshotLeaseUses.set(input.leaseId, input.useToken);
    return result;
  }

  private endSnapshotLeaseUse(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.endUse']
  ): null {
    assertIdentifier(input.leaseId, 'leaseId');
    assertIdentifier(input.useToken, 'useToken');
    const db = this.getDb();
    try {
      db.transaction(() => {
        const lease = readLease(db, input.leaseId);
        if (!lease) return;
        if (lease.use_token !== input.useToken) {
          throw new Error('snapshot-retention-lease-use-fence-mismatch');
        }
        if (lease.release_requested === 1) {
          db.prepare('DELETE FROM snapshot_retention_leases WHERE lease_id = ?').run(input.leaseId);
        } else {
          db.prepare(
            `UPDATE snapshot_retention_leases
               SET use_token = NULL, use_deadline_at_ms = NULL
               WHERE lease_id = ?`
          ).run(input.leaseId);
        }
      }).immediate();
    } finally {
      if (this.activeSnapshotLeaseUses.get(input.leaseId) === input.useToken) {
        this.activeSnapshotLeaseUses.delete(input.leaseId);
      }
    }
    return null;
  }

  private releaseSnapshotLease(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationEvents.lease.release']
  ): null {
    assertIdentifier(input.leaseId, 'leaseId');
    const db = this.getDb();
    db.transaction(() => {
      const lease = readLease(db, input.leaseId);
      if (!lease) return;
      if (lease.use_token === null) {
        db.prepare('DELETE FROM snapshot_retention_leases WHERE lease_id = ?').run(input.leaseId);
      } else {
        db.prepare(
          'UPDATE snapshot_retention_leases SET release_requested = 1 WHERE lease_id = ?'
        ).run(input.leaseId);
      }
    }).immediate();
    return null;
  }

  private createBackupRun(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.create']
  ): unknown {
    const record = input.record;
    validateBackupRunStorageRecord(record);
    const recordJson = canonicalJson(record);
    const db = this.getDb();
    return db
      .transaction(() => {
        const existing = readBackupRunRow(db, record.backupRunId);
        if (existing) {
          if (existing.record_json !== recordJson) throw new Error('backup-run-create-conflict');
          return parseBackupRun(existing);
        }
        db.prepare(
          `INSERT INTO coordination_backup_runs (
             backup_run_id, deployment_id, state, revision, fence_completion_status,
             record_json, requested_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          record.backupRunId,
          record.deploymentId,
          record.state,
          record.revision,
          record.fenceCompletion?.status ?? null,
          recordJson,
          record.requestedAt,
          record.updatedAt
        );
        return parseBackupRun(requireBackupRunRow(db, record.backupRunId));
      })
      .immediate();
  }

  private getBackupRun(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.get']
  ): unknown {
    assertIdentifier(input.backupRunId, 'backupRunId');
    const row = readBackupRunRow(this.getDb(), input.backupRunId);
    return row ? parseBackupRun(row) : null;
  }

  private listRecoverableBackupRuns(): readonly unknown[] {
    const rows = this.getDb()
      .prepare(
        `SELECT backup_run_id, deployment_id, state, revision, record_json
         FROM coordination_backup_runs
         WHERE state NOT IN ('committed', 'failed', 'operator_required', 'artifact_source')
            OR fence_completion_status = 'pending'
         ORDER BY requested_at ASC, backup_run_id ASC`
      )
      .all() as BackupRunRow[];
    return Object.freeze(rows.map(parseBackupRun));
  }

  private compareAndSetBackupRun(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupRuns.compareAndSet']
  ): unknown {
    assertIdentifier(input.backupRunId, 'backupRunId');
    assertPositiveInteger(input.expectedRevision, 'expectedRevision');
    const record = input.record;
    validateBackupRunStorageRecord(record);
    if (
      record.backupRunId !== input.backupRunId ||
      record.revision !== input.expectedRevision + 1
    ) {
      throw new Error('backup-run-compare-and-set-record-invalid');
    }
    const db = this.getDb();
    return db
      .transaction(() => {
        const result = db
          .prepare(
            `UPDATE coordination_backup_runs
             SET state = ?, revision = ?, fence_completion_status = ?, record_json = ?, updated_at = ?
             WHERE backup_run_id = ? AND state = ? AND revision = ?`
          )
          .run(
            record.state,
            record.revision,
            record.fenceCompletion?.status ?? null,
            canonicalJson(record),
            record.updatedAt,
            input.backupRunId,
            input.expectedState,
            input.expectedRevision
          );
        if (result.changes !== 1) {
          const observed = requireBackupRunRow(db, input.backupRunId);
          if (observed.record_json === canonicalJson(record)) return parseBackupRun(observed);
          throw new Error('backup-run-compare-and-set-failed');
        }
        return parseBackupRun(requireBackupRunRow(db, input.backupRunId));
      })
      .immediate();
  }

  private acquireWriterFence(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFence.acquire']
  ): unknown {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.backupRunId, 'backupRunId');
    assertIdentifier(input.leaseId, 'leaseId');
    assertIsoTimestamp(input.acquiredAt, 'acquiredAt');
    if (input.expectedGeneration !== null) {
      assertPositiveInteger(input.expectedGeneration, 'expectedGeneration');
    }
    const db = this.getDb();
    return db
      .transaction(() => {
        const run = requireBackupRunRow(db, input.backupRunId);
        if (run.deployment_id !== input.deploymentId) throw new Error('backup-fence-run-mismatch');
        const activeFence = readBlockingWriterFence(db);
        if (activeFence && activeFence.deployment_id !== input.deploymentId) {
          return Object.freeze({
            status: 'busy' as const,
            activeRunId: activeFence.admitted_run_id,
          });
        }
        const current = readWriterFence(db, input.deploymentId);
        if (current?.status === 'active') {
          if (
            current.admitted_run_id === input.backupRunId &&
            (input.expectedGeneration === null || input.expectedGeneration === current.generation)
          ) {
            return Object.freeze({
              status: 'acquired' as const,
              generation: current.generation,
              leaseId: current.lease_id,
            });
          }
          return Object.freeze({
            status: 'busy' as const,
            activeRunId: current.admitted_run_id,
          });
        }
        if (current?.status === 'operator_required') {
          return Object.freeze({
            status: 'busy' as const,
            activeRunId: current.admitted_run_id,
          });
        }
        if (input.expectedGeneration !== null && input.expectedGeneration !== current?.generation) {
          throw new Error('backup-fence-generation-stale');
        }
        assertAcceptedCommandsDrained(db);
        const generation = (current?.generation ?? 0) + 1;
        db.prepare(
          `INSERT INTO coordination_backup_writer_fences (
             deployment_id, generation, admitted_run_id, lease_id, status,
             disposition, acquired_at, completed_at
           ) VALUES (?, ?, ?, ?, 'active', NULL, ?, NULL)
           ON CONFLICT(deployment_id) DO UPDATE SET
             generation = excluded.generation,
             admitted_run_id = excluded.admitted_run_id,
             lease_id = excluded.lease_id,
             status = 'active',
             disposition = NULL,
             acquired_at = excluded.acquired_at,
             completed_at = NULL`
        ).run(input.deploymentId, generation, input.backupRunId, input.leaseId, input.acquiredAt);
        return Object.freeze({ status: 'acquired' as const, generation, leaseId: input.leaseId });
      })
      .immediate();
  }

  private completeWriterFence(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFence.complete']
  ): null {
    assertIdentifier(input.deploymentId, 'deploymentId');
    assertIdentifier(input.backupRunId, 'backupRunId');
    assertIdentifier(input.leaseId, 'leaseId');
    assertPositiveInteger(input.generation, 'generation');
    assertIsoTimestamp(input.completedAt, 'completedAt');
    const db = this.getDb();
    db.transaction(() => {
      const current = readWriterFence(db, input.deploymentId);
      if (!current) throw new Error('backup-fence-not-found');
      if (
        current.generation !== input.generation ||
        current.admitted_run_id !== input.backupRunId ||
        current.lease_id !== input.leaseId
      ) {
        throw new Error('backup-fence-completion-fence-mismatch');
      }
      const nextStatus =
        input.disposition === 'operator_required' ? 'operator_required' : 'released';
      if (current.status !== 'active') {
        if (current.status === nextStatus && current.disposition === input.disposition) return;
        throw new Error('backup-fence-completion-conflict');
      }
      db.prepare(
        `UPDATE coordination_backup_writer_fences
           SET status = ?, disposition = ?, completed_at = ?
           WHERE deployment_id = ? AND generation = ? AND lease_id = ? AND status = 'active'`
      ).run(
        nextStatus,
        input.disposition,
        input.completedAt,
        input.deploymentId,
        input.generation,
        input.leaseId
      );
    }).immediate();
    return null;
  }

  private drainAcceptedCommands(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFlush.drain']
  ): CoordinationDrainStorageEvidence {
    const db = this.getDb();
    return db.transaction(() => captureDrainEvidence(db, input)).immediate();
  }

  private captureCoordinationBarrier(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackupFlush.capture']
  ): CoordinationDrainStorageEvidence {
    const db = this.getDb();
    return db
      .transaction(() => {
        const current = captureDrainEvidence(db, {
          deploymentId: input.deploymentId,
          backupRunId: input.evidence.backupRunId,
          fenceGeneration: input.evidence.fenceGeneration,
        });
        if (canonicalJson(current) !== canonicalJson(input.evidence)) {
          throw new Error('coordination-backup-drain-overtaken');
        }
        return current;
      })
      .immediate();
  }

  private async createOnlineBackup(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.online']
  ): Promise<SqliteOnlineBackupStorageResult> {
    validateOnlineBackupInput(input);
    const source = this.getDb();
    const fence = readBlockingWriterFence(source);
    if (
      fence?.status !== 'active' ||
      fence.admitted_run_id !== input.backupRunId ||
      requireBackupRunRow(source, input.backupRunId).state !== 'sqlite_snapshot'
    ) {
      throw new Error('coordination-backup-online-fence-mismatch');
    }
    await ensurePrivateScratchRoot(this.backupScratchRoot);
    const snapshotPath = this.snapshotScratchPath(input.backupRunId);
    const existing = await inspectExistingSnapshot(
      snapshotPath,
      input.backupRunId,
      this.createDatabase
    );
    if (existing) return existing;

    for (;;) {
      if (Date.now() >= input.deadlineAtMs) {
        await removePartialSnapshot(snapshotPath);
        return { status: 'deadline_exceeded' };
      }
      await removePartialSnapshot(snapshotPath);
      try {
        await source.backup(snapshotPath, {
          progress: () => {
            if (Date.now() >= input.deadlineAtMs) throw new OnlineBackupDeadlineError();
            return input.pagesPerStep;
          },
        });
        await fs.promises.chmod(snapshotPath, 0o600);
        const verification = verifySnapshotFile(
          snapshotPath,
          input.backupRunId,
          INTERNAL_STORAGE_APPLICATION_ID,
          INTERNAL_STORAGE_SCHEMA_VERSION,
          requiredInternalStorageTables(),
          this.createDatabase
        );
        if (verification.status !== 'valid') {
          await removePartialSnapshot(snapshotPath);
          return { status: 'source_corrupt' };
        }
        return measureCompletedSnapshot(snapshotPath, verification);
      } catch (error) {
        await removePartialSnapshot(snapshotPath);
        if (error instanceof OnlineBackupDeadlineError || Date.now() >= input.deadlineAtMs) {
          return { status: 'deadline_exceeded' };
        }
        if (isSqliteCorruption(error)) return { status: 'source_corrupt' };
        if (!isSqliteBusy(error)) throw error;
        const remaining = input.deadlineAtMs - Date.now();
        if (remaining <= input.busyRetryMs) return { status: 'busy_timeout' };
        await delay(Math.min(input.busyRetryMs, remaining), undefined, { ref: false });
      }
    }
  }

  private verifySqliteSnapshot(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.verify']
  ): SqliteSnapshotVerificationStorageResult {
    assertIdentifier(input.backupRunId, 'backupRunId');
    return verifySnapshotFile(
      this.snapshotScratchPath(input.backupRunId),
      input.backupRunId,
      INTERNAL_STORAGE_APPLICATION_ID,
      INTERNAL_STORAGE_SCHEMA_VERSION,
      requiredInternalStorageTables(),
      this.createDatabase
    );
  }

  private readSqliteSnapshotChunk(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.readChunk']
  ): SqliteBackupChunkStorageResult {
    assertIdentifier(input.backupRunId, 'backupRunId');
    assertNonNegativeInteger(input.offset, 'offset');
    if (
      !Number.isSafeInteger(input.maximumBytes) ||
      input.maximumBytes <= 0 ||
      input.maximumBytes > MAX_BACKUP_CHUNK_BYTES
    ) {
      throw new Error('coordination-backup-chunk-size-invalid');
    }
    return readSnapshotChunk(
      this.snapshotScratchPath(input.backupRunId),
      input.offset,
      input.maximumBytes
    );
  }

  private snapshotScratchPath(backupRunId: string): string {
    const name = `${createHash('sha256')
      .update('coordination-backup-scratch-v1\0')
      .update(backupRunId)
      .digest('hex')}.sqlite`;
    return path.join(this.backupScratchRoot, name);
  }
}

export function assertCoordinationMutationAdmissionOpen(
  db: SqliteDatabase,
  deploymentId: string
): void {
  const fence = readWriterFence(db, deploymentId);
  if (fence?.status === 'active' || fence?.status === 'operator_required') {
    throw new Error('coordination-mutation-admission-fenced');
  }
}

/**
 * Central source-database fence used by InternalStorageWorkerCore before every
 * mutating operation. A backup-owned write may proceed only for the run that
 * owns the one durable database-wide fence.
 */
export function assertInternalStorageMutationAdmissionOpen(
  db: SqliteDatabase,
  admittedBackupRunId: string | null
): void {
  const fence = readBlockingWriterFence(db);
  if (!fence) return;
  if (admittedBackupRunId !== null && fence.admitted_run_id === admittedBackupRunId) return;
  throw new Error('internal-storage-mutation-admission-fenced');
}

export function appendCommandOutboxEventToJournal(
  db: SqliteDatabase,
  input: {
    readonly commandId: string;
    readonly deploymentId: string;
    readonly attribution: StoredCommandCoordinationAttribution;
    readonly outbox: {
      readonly eventId: string;
      readonly eventType: string;
      readonly scopeKind: string;
      readonly scopeId: string;
      readonly schemaVersion: number;
      readonly payloadJson: string;
      readonly createdAtIso: string;
    };
  }
): void {
  if (!COORDINATION_EVENT_SCOPE_KINDS.includes(input.outbox.scopeKind as never)) {
    throw new Error('durable-command-outbox-scope-kind-invalid');
  }
  if (input.outbox.schemaVersion !== 1) {
    throw new Error('durable-command-outbox-schema-version-invalid');
  }
  let payload: CoordinationJsonValue;
  try {
    payload = JSON.parse(input.outbox.payloadJson) as CoordinationJsonValue;
  } catch {
    throw new Error('durable-command-outbox-payload-json-invalid');
  }
  const attribution = materializeCommandCoordinationAttribution(input.attribution);
  const runId =
    attribution.runId ?? (input.outbox.scopeKind === 'run' ? input.outbox.scopeId : undefined);
  const draft: CoordinationEventDraft = {
    schemaVersion: 1,
    eventId: input.outbox.eventId,
    scope: {
      kind: input.outbox.scopeKind as CoordinationEventDraft['scope']['kind'],
      scopeId: input.outbox.scopeId,
    },
    ...(input.outbox.scopeKind === 'workspace' ? { workspaceId: input.outbox.scopeId } : {}),
    ...(input.outbox.scopeKind === 'team' ? { teamId: input.outbox.scopeId } : {}),
    ...(runId === undefined ? {} : { runId }),
    actor: attribution.actor,
    eventType: input.outbox.eventType,
    emittedAt: input.outbox.createdAtIso,
    payload,
  };
  assertCoordinationEventDraft(draft);
  const metadata = ensureEventMetadata(
    db,
    input.deploymentId,
    undefined,
    input.outbox.createdAtIso
  );
  appendEventJournalRow(
    db,
    input.deploymentId,
    metadata.event_epoch,
    draft,
    canonicalJson(draft),
    input.commandId,
    input.outbox.createdAtIso
  );
}

export function createLegacyCommandCoordinationAttribution(
  stableActorId: string
): StoredCommandCoordinationAttribution {
  assertIdentifier(stableActorId, 'stableActorId');
  return Object.freeze({
    actor: Object.freeze({
      kind: 'recovery' as const,
      actorRef: `legacy-command:${stableActorId}`,
    }),
    provenance: 'legacy_recovery_v1' as const,
  });
}

export function materializeCommandCoordinationAttribution(
  input: StoredCommandCoordinationAttribution
): StoredCommandCoordinationAttribution {
  if (!input || typeof input !== 'object' || !input.actor || typeof input.actor !== 'object') {
    throw new Error('durable-command-coordination-attribution-invalid');
  }
  if (input.provenance !== 'trusted_context_v1' && input.provenance !== 'legacy_recovery_v1') {
    throw new Error('durable-command-coordination-attribution-provenance-invalid');
  }
  const actor = Object.freeze({ ...input.actor });
  const materialized = Object.freeze({
    actor,
    ...(input.runId === undefined ? {} : { runId: input.runId }),
    provenance: input.provenance,
  }) as StoredCommandCoordinationAttribution;
  const validationDraft: CoordinationEventDraft = {
    schemaVersion: 1,
    eventId: 'coordination-attribution-validation',
    scope: { kind: 'instance', scopeId: 'coordination-attribution-validation' },
    ...(materialized.runId === undefined ? {} : { runId: materialized.runId }),
    actor: materialized.actor,
    eventType: 'coordination.attribution.validated',
    emittedAt: new Date(0).toISOString(),
    payload: null,
  };
  assertCoordinationEventDraft(validationDraft);
  if (
    materialized.provenance === 'legacy_recovery_v1' &&
    (materialized.actor.kind !== 'recovery' ||
      !materialized.actor.actorRef.startsWith('legacy-command:') ||
      materialized.runId !== undefined)
  ) {
    throw new Error('durable-command-legacy-attribution-invalid');
  }
  return materialized;
}

export function canonicalCoordinationStorageJson(value: unknown): string {
  return canonicalJson(value);
}

function appendEventJournalRow(
  db: SqliteDatabase,
  deploymentId: string,
  eventEpoch: string,
  draft: CoordinationEventDraft,
  bodyJson: string,
  originCommandId: string | null,
  nowIso: string
): { readonly row: StoredCoordinationEventRow; readonly watermark: StoredEventJournalMetadata } {
  const metadata = requireEventMetadata(db, deploymentId);
  requireEpoch(metadata, eventEpoch);
  assertJournalContinuity(db, metadata);
  const existing = db
    .prepare(
      `SELECT deployment_id, event_epoch, event_sequence, event_id, body_json
       FROM coordination_event_journal WHERE event_id = ?`
    )
    .get(draft.eventId) as EventRow | undefined;
  if (existing) {
    if (
      existing.deployment_id !== deploymentId ||
      existing.event_epoch !== eventEpoch ||
      existing.body_json !== bodyJson
    ) {
      throw new Error('coordination-event-journal-event-id-conflict');
    }
    return Object.freeze({ row: mapEventRow(existing), watermark: mapMetadata(metadata) });
  }
  const eventSequence = metadata.high_watermark_sequence + 1;
  db.prepare(
    `INSERT INTO coordination_event_journal (
       deployment_id, event_epoch, event_sequence, event_id, body_json,
       emitted_at, origin_command_id, created_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    deploymentId,
    eventEpoch,
    eventSequence,
    draft.eventId,
    bodyJson,
    draft.emittedAt,
    originCommandId,
    nowIso
  );
  const update = db
    .prepare(
      `UPDATE coordination_event_journal_metadata
     SET high_watermark_sequence = ?, updated_at = ?
     WHERE deployment_id = ? AND event_epoch = ? AND high_watermark_sequence = ?`
    )
    .run(eventSequence, nowIso, deploymentId, eventEpoch, metadata.high_watermark_sequence);
  if (update.changes !== 1) throw new Error('coordination-event-journal-watermark-cas-failed');
  const updated = requireEventMetadata(db, deploymentId);
  assertJournalContinuity(db, updated);
  const row = db
    .prepare(
      `SELECT deployment_id, event_epoch, event_sequence, event_id, body_json
       FROM coordination_event_journal
       WHERE deployment_id = ? AND event_epoch = ? AND event_sequence = ?`
    )
    .get(deploymentId, eventEpoch, eventSequence) as EventRow;
  return Object.freeze({ row: mapEventRow(row), watermark: mapMetadata(updated) });
}

function captureDrainEvidence(
  db: SqliteDatabase,
  input: {
    readonly deploymentId: string;
    readonly backupRunId: string;
    readonly fenceGeneration: number;
  }
): CoordinationDrainStorageEvidence {
  assertIdentifier(input.deploymentId, 'deploymentId');
  assertIdentifier(input.backupRunId, 'backupRunId');
  assertPositiveInteger(input.fenceGeneration, 'fenceGeneration');
  const fence = readWriterFence(db, input.deploymentId);
  if (
    fence?.status !== 'active' ||
    fence.admitted_run_id !== input.backupRunId ||
    fence.generation !== input.fenceGeneration
  ) {
    throw new Error('coordination-backup-drain-fence-mismatch');
  }
  assertAcceptedCommandsDrained(db);
  const outbox = db
    .prepare(
      `SELECT COALESCE(MAX(sequence), 0) AS sequence
       FROM durable_application_command_outbox WHERE deployment_id = ?`
    )
    .get(input.deploymentId) as { sequence: number };
  const metadata = ensureEventMetadata(
    db,
    input.deploymentId,
    undefined,
    new Date(0).toISOString()
  );
  assertJournalContinuity(db, metadata);
  const raw = Object.freeze({
    backupRunId: input.backupRunId,
    fenceGeneration: input.fenceGeneration,
    throughCommandSequence: outbox.sequence,
    throughEventSequence: metadata.high_watermark_sequence,
    eventEpoch: metadata.event_epoch,
  });
  return Object.freeze({ ...raw, durableBarrier: encodeDrainEvidence(raw) });
}

function ensureEventMetadata(
  db: SqliteDatabase,
  deploymentId: string,
  requestedEpoch: string | undefined,
  nowIso: string
): EventMetadataRow {
  const current = readEventMetadata(db, deploymentId);
  if (current) {
    if (requestedEpoch !== undefined && requestedEpoch !== current.event_epoch) {
      throw new Error('coordination-event-journal-epoch-mismatch');
    }
    return current;
  }
  const eventEpoch = requestedEpoch ?? deterministicEventEpoch(deploymentId);
  db.prepare(
    `INSERT INTO coordination_event_journal_metadata (
       deployment_id, event_epoch, retention_floor_sequence,
       high_watermark_sequence, created_at, updated_at
     ) VALUES (?, ?, 0, 0, ?, ?)`
  ).run(deploymentId, eventEpoch, nowIso, nowIso);
  return requireEventMetadata(db, deploymentId);
}

function deterministicEventEpoch(deploymentId: string): string {
  return `${EVENT_EPOCH_PREFIX}${createHash('sha256').update(deploymentId).digest('hex').slice(0, 24)}`;
}

function readEventMetadata(db: SqliteDatabase, deploymentId: string): EventMetadataRow | undefined {
  return db
    .prepare(
      `SELECT deployment_id, event_epoch, retention_floor_sequence, high_watermark_sequence
       FROM coordination_event_journal_metadata WHERE deployment_id = ?`
    )
    .get(deploymentId) as EventMetadataRow | undefined;
}

function requireEventMetadata(db: SqliteDatabase, deploymentId: string): EventMetadataRow {
  const row = readEventMetadata(db, deploymentId);
  if (!row) throw new Error('coordination-event-journal-not-initialized');
  return row;
}

function assertJournalContinuity(db: SqliteDatabase, metadata: EventMetadataRow): void {
  if (
    !Number.isSafeInteger(metadata.retention_floor_sequence) ||
    !Number.isSafeInteger(metadata.high_watermark_sequence) ||
    metadata.retention_floor_sequence < 0 ||
    metadata.high_watermark_sequence < metadata.retention_floor_sequence
  ) {
    throw new Error('coordination-event-journal-watermark-corrupt');
  }
  const observed = db
    .prepare(
      `SELECT COUNT(*) AS count, MIN(event_sequence) AS minimum, MAX(event_sequence) AS maximum
       FROM coordination_event_journal
       WHERE deployment_id = ? AND event_epoch = ?`
    )
    .get(metadata.deployment_id, metadata.event_epoch) as {
    count: number;
    minimum: number | null;
    maximum: number | null;
  };
  const expected = metadata.high_watermark_sequence - metadata.retention_floor_sequence;
  if (
    observed.count !== expected ||
    (expected === 0 && (observed.minimum !== null || observed.maximum !== null)) ||
    (expected > 0 &&
      (observed.minimum !== metadata.retention_floor_sequence + 1 ||
        observed.maximum !== metadata.high_watermark_sequence))
  ) {
    throw new Error('coordination-event-journal-gap-detected');
  }
}

function assertContiguousEventRows(
  rows: readonly EventRow[],
  firstSequence: number,
  expectedCount: number
): void {
  if (
    rows.length !== expectedCount ||
    rows.some((row, index) => row.event_sequence !== firstSequence + index)
  ) {
    throw new Error('coordination-event-journal-gap-detected');
  }
}

function mapMetadata(row: EventMetadataRow): StoredEventJournalMetadata {
  return Object.freeze({
    deploymentId: row.deployment_id,
    eventEpoch: row.event_epoch,
    retentionFloorSequence: row.retention_floor_sequence,
    highWatermarkSequence: row.high_watermark_sequence,
  });
}

function mapEventRow(row: EventRow): StoredCoordinationEventRow {
  return Object.freeze({
    deploymentId: row.deployment_id,
    eventEpoch: row.event_epoch,
    eventSequence: row.event_sequence,
    eventId: row.event_id,
    bodyJson: row.body_json,
  });
}

function mapLease(row: LeaseRow): StoredSnapshotRetentionLease {
  return Object.freeze({
    leaseId: row.lease_id,
    watermark: mapMetadata(row),
    deadlineAtMs: row.expires_at_ms,
  });
}

function readLease(db: SqliteDatabase, leaseId: string): LeaseRow | undefined {
  return db.prepare('SELECT * FROM snapshot_retention_leases WHERE lease_id = ?').get(leaseId) as
    | LeaseRow
    | undefined;
}

function requireLease(db: SqliteDatabase, leaseId: string): LeaseRow {
  const row = readLease(db, leaseId);
  if (!row) throw new Error('snapshot-retention-lease-not-found');
  return row;
}

function readBackupRunRow(db: SqliteDatabase, backupRunId: string): BackupRunRow | undefined {
  return db
    .prepare(
      `SELECT backup_run_id, deployment_id, state, revision, record_json
       FROM coordination_backup_runs WHERE backup_run_id = ?`
    )
    .get(backupRunId) as BackupRunRow | undefined;
}

function requireBackupRunRow(db: SqliteDatabase, backupRunId: string): BackupRunRow {
  const row = readBackupRunRow(db, backupRunId);
  if (!row) throw new Error('backup-run-not-found');
  return row;
}

function parseBackupRun(row: BackupRunRow): unknown {
  const record = JSON.parse(row.record_json) as {
    backupRunId?: unknown;
    deploymentId?: unknown;
    state?: unknown;
    revision?: unknown;
  };
  if (
    record.backupRunId !== row.backup_run_id ||
    record.deploymentId !== row.deployment_id ||
    record.state !== row.state ||
    record.revision !== row.revision
  ) {
    throw new Error('backup-run-record-corrupt');
  }
  assertBackupRunRecord(record as never);
  return record;
}

function validateBackupRunStorageRecord(record: {
  readonly backupRunId: string;
  readonly deploymentId: string;
  readonly state: string;
  readonly revision: number;
  readonly requestedAt: string;
  readonly updatedAt: string;
}): void {
  assertIdentifier(record.backupRunId, 'backupRunId');
  assertIdentifier(record.deploymentId, 'deploymentId');
  if (!BACKUP_RUN_STATE_VALUES.has(record.state)) {
    throw new Error('coordination-storage-state-invalid');
  }
  assertPositiveInteger(record.revision, 'revision');
  assertIsoTimestamp(record.requestedAt, 'requestedAt');
  assertIsoTimestamp(record.updatedAt, 'updatedAt');
  assertBackupRunRecord(record as never);
}

function readWriterFence(db: SqliteDatabase, deploymentId: string): WriterFenceRow | undefined {
  return db
    .prepare('SELECT * FROM coordination_backup_writer_fences WHERE deployment_id = ?')
    .get(deploymentId) as WriterFenceRow | undefined;
}

function readBlockingWriterFence(db: SqliteDatabase): WriterFenceRow | undefined {
  const rows = db
    .prepare(
      `SELECT * FROM coordination_backup_writer_fences
       WHERE status IN ('active', 'operator_required')
       ORDER BY generation ASC, deployment_id ASC
       LIMIT 2`
    )
    .all() as WriterFenceRow[];
  if (rows.length > 1) throw new Error('coordination-backup-multiple-writer-fences');
  return rows[0];
}

function assertAcceptedCommandsDrained(db: SqliteDatabase): void {
  const placeholders = ACTIVE_COMMAND_STATES.map(() => '?').join(', ');
  const active = db
    .prepare(
      `SELECT command_id
       FROM durable_application_commands
       WHERE state IN (${placeholders})
       ORDER BY created_at ASC LIMIT 1`
    )
    .get(...ACTIVE_COMMAND_STATES) as { command_id: string } | undefined;
  if (active) throw new Error('coordination-backup-command-drain-pending');
}

function requireEpoch(metadata: EventMetadataRow, eventEpoch: string): void {
  if (metadata.event_epoch !== eventEpoch) {
    throw new Error('coordination-event-journal-epoch-mismatch');
  }
}

function encodeDrainEvidence(input: {
  readonly backupRunId: string;
  readonly fenceGeneration: number;
  readonly throughCommandSequence: number;
  readonly throughEventSequence: number;
  readonly eventEpoch: string;
}): string {
  return `coordination-drain-v1.${Buffer.from(canonicalJson(input), 'utf8').toString('base64url')}`;
}

function validateOnlineBackupInput(
  input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.online']
): void {
  assertIdentifier(input.backupRunId, 'backupRunId');
  assertPositiveInteger(input.deadlineAtMs, 'deadlineAtMs');
  assertPositiveInteger(input.busyRetryMs, 'busyRetryMs');
  assertPositiveInteger(input.pagesPerStep, 'pagesPerStep');
}

function validateSnapshotPath(snapshotPath: string): void {
  if (
    typeof snapshotPath !== 'string' ||
    snapshotPath.length === 0 ||
    snapshotPath.length > 4_096 ||
    !path.isAbsolute(snapshotPath) ||
    path.resolve(snapshotPath) === path.parse(path.resolve(snapshotPath)).root
  ) {
    throw new Error('coordination-backup-snapshot-path-invalid');
  }
}

async function inspectExistingSnapshot(
  snapshotPath: string,
  backupRunId: string,
  createDatabase: CoordinationDurabilityWorkerOps['createDatabase']
): Promise<SqliteOnlineBackupStorageResult | null> {
  let stat: fs.Stats;
  try {
    stat = await fs.promises.lstat(snapshotPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('coordination-backup-snapshot-target-not-regular');
  }
  const verification = verifySnapshotFile(
    snapshotPath,
    backupRunId,
    INTERNAL_STORAGE_APPLICATION_ID,
    INTERNAL_STORAGE_SCHEMA_VERSION,
    requiredInternalStorageTables(),
    createDatabase
  );
  return verification.status === 'valid'
    ? measureCompletedSnapshot(snapshotPath, verification)
    : null;
}

function verifySnapshotFile(
  snapshotPath: string,
  backupRunId: string,
  expectedApplicationId: number,
  expectedUserVersion: number,
  requiredTables: readonly string[],
  createDatabase: CoordinationDurabilityWorkerOps['createDatabase']
): SqliteSnapshotVerificationStorageResult {
  let before: fs.Stats;
  try {
    before = fs.lstatSync(snapshotPath);
    if (!before.isFile() || before.isSymbolicLink()) {
      return { status: 'invalid', reason: 'integrity_check_failed' };
    }
  } catch {
    return { status: 'invalid', reason: 'integrity_check_failed' };
  }
  let db: SqliteDatabase;
  try {
    db = createDatabase(snapshotPath, { readonly: true, fileMustExist: true });
  } catch {
    return { status: 'invalid', reason: 'integrity_check_failed' };
  }
  let verification: SqliteSnapshotVerificationStorageResult;
  try {
    verification = inspectSnapshotDatabase(
      db,
      backupRunId,
      expectedApplicationId,
      expectedUserVersion,
      requiredTables
    );
  } catch {
    verification = { status: 'invalid', reason: 'integrity_check_failed' };
  } finally {
    db.close();
    removeSnapshotSidecarsSync(snapshotPath);
  }
  let after: fs.Stats;
  try {
    after = fs.lstatSync(snapshotPath);
  } catch (error) {
    throw new Error('coordination-backup-snapshot-identity-race', { cause: error });
  }
  if (!sameFileIdentity(before, after) || after.isSymbolicLink() || !after.isFile()) {
    throw new Error('coordination-backup-snapshot-identity-race');
  }
  return verification;
}

function inspectSnapshotDatabase(
  db: SqliteDatabase,
  backupRunId: string,
  expectedApplicationId: number,
  expectedUserVersion: number,
  requiredTables: readonly string[]
): SqliteSnapshotVerificationStorageResult {
  db.pragma('query_only = ON');
  const integrity = db.pragma('integrity_check', { simple: true });
  if (integrity !== 'ok') return { status: 'invalid', reason: 'integrity_check_failed' };
  const applicationId = db.pragma('application_id', { simple: true });
  if (applicationId !== expectedApplicationId) {
    return { status: 'invalid', reason: 'application_id_mismatch' };
  }
  const userVersion = db.pragma('user_version', { simple: true });
  if (userVersion !== expectedUserVersion) {
    return {
      status: 'invalid',
      reason:
        typeof userVersion === 'number' && userVersion < expectedUserVersion
          ? 'migration_incomplete'
          : 'schema_mismatch',
    };
  }
  const tables = db
    .prepare(`SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name ASC`)
    .all() as { name: string }[];
  const names = new Set(tables.map((table) => table.name));
  if (requiredTables.some((table) => !names.has(table))) {
    return { status: 'invalid', reason: 'migration_incomplete' };
  }
  const identity = db
    .prepare(`SELECT schema_version FROM team_identity_storage_metadata WHERE component = ?`)
    .get(REQUIRED_IDENTITY_COMPONENT) as { schema_version: number } | undefined;
  if (identity?.schema_version !== 1) {
    return { status: 'invalid', reason: 'required_identity_missing' };
  }
  const sourceRun = db
    .prepare(`SELECT state, record_json FROM coordination_backup_runs WHERE backup_run_id = ?`)
    .get(backupRunId) as { state: string; record_json: string } | undefined;
  if (sourceRun?.state !== 'sqlite_snapshot') {
    return { status: 'invalid', reason: 'required_identity_missing' };
  }
  const record = JSON.parse(sourceRun.record_json) as { backupRunId?: unknown; state?: unknown };
  if (record.backupRunId !== backupRunId || record.state !== 'sqlite_snapshot') {
    return { status: 'invalid', reason: 'required_identity_missing' };
  }
  return Object.freeze({
    status: 'valid' as const,
    applicationId,
    userVersion,
    requiredTables: Object.freeze([...requiredTables]),
  });
}

async function measureCompletedSnapshot(
  snapshotPath: string,
  verification: Extract<SqliteSnapshotVerificationStorageResult, { status: 'valid' }>
): Promise<SqliteOnlineBackupStorageResult> {
  const stat = await fs.promises.lstat(snapshotPath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error('coordination-backup-snapshot-target-not-regular');
  }
  const hash = createHash('sha256');
  const handle = await fs.promises.open(
    snapshotPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    for await (const chunk of handle.readableWebStream()) hash.update(Buffer.from(chunk));
  } finally {
    await handle.close();
  }
  return Object.freeze({
    status: 'completed' as const,
    applicationId: verification.applicationId,
    userVersion: verification.userVersion,
    byteLength: stat.size,
    mode: stat.mode & 0o777,
    sha256: hash.digest('hex'),
  });
}

async function removePartialSnapshot(snapshotPath: string): Promise<void> {
  for (const candidate of [snapshotPath, `${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
    try {
      const stat = await fs.promises.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('coordination-backup-partial-target-not-regular');
      }
      await fs.promises.unlink(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

function removeSnapshotSidecarsSync(snapshotPath: string): void {
  for (const candidate of [`${snapshotPath}-wal`, `${snapshotPath}-shm`]) {
    try {
      const stat = fs.lstatSync(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) {
        throw new Error('coordination-backup-snapshot-sidecar-invalid');
      }
      fs.unlinkSync(candidate);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
}

async function ensurePrivateScratchRoot(scratchRoot: string): Promise<void> {
  const created = await fs.promises.mkdir(scratchRoot, { recursive: true, mode: 0o700 });
  if (created !== undefined) await fs.promises.chmod(scratchRoot, 0o700);
  const before = await fs.promises.lstat(scratchRoot);
  if (!before.isDirectory() || before.isSymbolicLink() || (before.mode & 0o777) !== 0o700) {
    throw new Error('coordination-backup-scratch-root-invalid');
  }
  const realRoot = await fs.promises.realpath(scratchRoot);
  const realParent = await fs.promises.realpath(path.dirname(scratchRoot));
  if (path.dirname(realRoot) !== realParent) {
    throw new Error('coordination-backup-scratch-root-escape');
  }
  const after = await fs.promises.lstat(scratchRoot);
  if (!sameFileIdentity(before, after) || after.isSymbolicLink()) {
    throw new Error('coordination-backup-scratch-root-race');
  }
}

function readSnapshotChunk(
  snapshotPath: string,
  offset: number,
  maximumBytes: number
): SqliteBackupChunkStorageResult {
  const before = fs.lstatSync(snapshotPath);
  if (!before.isFile() || before.isSymbolicLink()) {
    throw new Error('coordination-backup-snapshot-target-not-regular');
  }
  const descriptor = fs.openSync(
    snapshotPath,
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0)
  );
  try {
    const opened = fs.fstatSync(descriptor);
    if (!opened.isFile() || !sameFileIdentity(before, opened)) {
      throw new Error('coordination-backup-snapshot-identity-race');
    }
    if (offset > opened.size) throw new Error('coordination-backup-chunk-offset-invalid');
    const bytesToRead = Math.min(maximumBytes, opened.size - offset);
    const buffer = Buffer.alloc(bytesToRead);
    const bytesRead =
      bytesToRead === 0 ? 0 : fs.readSync(descriptor, buffer, 0, bytesToRead, offset);
    if (bytesRead !== bytesToRead) throw new Error('coordination-backup-snapshot-short-read');
    const afterDescriptor = fs.fstatSync(descriptor);
    const afterPath = fs.lstatSync(snapshotPath);
    if (
      !sameFileIdentity(opened, afterDescriptor) ||
      opened.size !== afterDescriptor.size ||
      !sameFileIdentity(afterDescriptor, afterPath) ||
      afterPath.isSymbolicLink()
    ) {
      throw new Error('coordination-backup-snapshot-changed-during-read');
    }
    return Object.freeze({
      offset,
      totalByteLength: opened.size,
      bytes: Uint8Array.from(buffer),
      eof: offset + bytesRead === opened.size,
    });
  } finally {
    fs.closeSync(descriptor);
  }
}

function sameFileIdentity(left: fs.Stats, right: fs.Stats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function requiredInternalStorageTables(): readonly string[] {
  return INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES;
}

function isSqliteBusy(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return code === 'SQLITE_BUSY' || code === 'SQLITE_LOCKED';
}

function isSqliteCorruption(error: unknown): boolean {
  const code = error instanceof Error ? (error as Error & { code?: unknown }).code : undefined;
  return (
    code === 'SQLITE_NOTADB' || (typeof code === 'string' && code.startsWith('SQLITE_CORRUPT'))
  );
}

class OnlineBackupDeadlineError extends Error {}

function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

function normalizeCanonicalValue(value: unknown): unknown {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('coordination-storage-json-number-invalid');
    return value;
  }
  if (Array.isArray(value)) return value.map(normalizeCanonicalValue);
  if (typeof value !== 'object') {
    throw new Error('coordination-storage-json-value-invalid');
  }
  const record = value as Readonly<Record<string, unknown>>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort((left, right) => left.localeCompare(right))) {
    if (record[key] === undefined) continue;
    normalized[key] = normalizeCanonicalValue(record[key]);
  }
  return normalized;
}

function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}

function assertIsoTimestamp(value: string, field: string): void {
  assertIdentifier(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`coordination-storage-${field}-invalid`);
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}
