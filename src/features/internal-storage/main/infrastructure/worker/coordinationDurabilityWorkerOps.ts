import {
  appendEventJournalRow,
  assertAcceptedCommandsDrained,
  assertContiguousEventRows,
  assertCoordinationMutationAdmissionOpen,
  assertIdentifier,
  assertInternalStorageMutationAdmissionOpen,
  assertIsoTimestamp,
  assertJournalContinuity,
  assertNonNegativeInteger,
  assertPositiveInteger,
  canonicalJson,
  captureDrainEvidence,
  ensureEventMetadata,
  mapEventRow,
  mapMetadata,
  parseBackupRun,
  readBackupRunRow,
  readBlockingWriterFence,
  readEventMetadata,
  readWriterFence,
  requireBackupRunRow,
  requireEpoch,
  requireEventMetadata,
  validateBackupRunStorageRecord,
} from './coordinationDurabilityState';
import { CoordinationSqliteSnapshotOps } from './coordinationSqliteSnapshotOps';

export {
  appendCommandOutboxEventToJournal,
  assertCoordinationMutationAdmissionOpen,
  assertInternalStorageMutationAdmissionOpen,
  canonicalCoordinationStorageJson,
  createLegacyCommandCoordinationAttribution,
  materializeCommandCoordinationAttribution,
} from './coordinationDurabilityState';

import { assertCoordinationEventDraft } from '@features/coordination-events';

import type { BackupRunRow, EventRow } from './coordinationDurabilityState';
import type {
  CoordinationDrainStorageEvidence,
  CoordinationDurabilityWorkerPayloadByOp,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
const MAX_EVENT_PAGE_SIZE = 10_000;

export class CoordinationDurabilityWorkerOps {
  private readonly snapshotOps: CoordinationSqliteSnapshotOps;

  constructor(
    private readonly getDb: () => SqliteDatabase,
    createDatabase: (
      databasePath: string,
      options?: { readonly?: boolean; fileMustExist?: boolean }
    ) => SqliteDatabase,
    databasePath: string
  ) {
    this.snapshotOps = new CoordinationSqliteSnapshotOps(this.getDb, createDatabase, databasePath);
  }

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
        return this.snapshotOps.verifySqliteSnapshot(
          payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.verify']
        );
      case 'coordinationBackup.sqlite.readChunk':
        return this.snapshotOps.readSqliteSnapshotChunk(
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
      return this.snapshotOps.createOnlineBackup(
        payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.online']
      );
    }
    if (op === 'coordinationBackup.sqlite.discard') {
      const input =
        payload as CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.discard'];
      return this.snapshotOps.discard(input);
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
    assertIsoTimestamp(input.nowIso, 'nowIso');
    const db = this.getDb();
    return db
      .transaction(() => {
        const metadata = requireEventMetadata(db, input.deploymentId);
        requireEpoch(metadata, input.eventEpoch);
        assertJournalContinuity(db, metadata);
        const requestedFloor = Math.min(input.throughSequence, metadata.high_watermark_sequence);
        const nextFloor = Math.max(metadata.retention_floor_sequence, requestedFloor);
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
}
