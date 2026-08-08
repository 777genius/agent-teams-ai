import { createHash } from 'node:crypto';

import { assertBackupRunRecord, BACKUP_RUN_STATES } from '@features/coordination-backup';
import {
  assertCoordinationEventDraft,
  COORDINATION_EVENT_SCOPE_KINDS,
  type CoordinationEventDraft,
  type CoordinationJsonValue,
} from '@features/coordination-events';

import type {
  CoordinationDrainStorageEvidence,
  StoredCommandCoordinationAttribution,
  StoredCoordinationEventRow,
  StoredEventJournalMetadata,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface EventMetadataRow {
  deployment_id: string;
  event_epoch: string;
  retention_floor_sequence: number;
  high_watermark_sequence: number;
}

export interface EventRow {
  deployment_id: string;
  event_epoch: string;
  event_sequence: number;
  event_id: string;
  body_json: string;
}

export interface BackupRunRow {
  backup_run_id: string;
  deployment_id: string;
  state: string;
  revision: number;
  record_json: string;
}

export interface WriterFenceRow {
  deployment_id: string;
  generation: number;
  admitted_run_id: string;
  lease_id: string;
  status: 'active' | 'released' | 'operator_required';
  disposition: 'committed' | 'aborted' | 'operator_required' | null;
  acquired_at: string;
  completed_at: string | null;
}

const EVENT_EPOCH_PREFIX = 'epoch-initial-v1-';
const ACTIVE_COMMAND_STATES = Object.freeze(['prepared', 'running', 'recovering'] as const);
const BACKUP_RUN_STATE_VALUES = new Set<string>(BACKUP_RUN_STATES);

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

export function appendEventJournalRow(
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

export function captureDrainEvidence(
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

export function ensureEventMetadata(
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

export function deterministicEventEpoch(deploymentId: string): string {
  return `${EVENT_EPOCH_PREFIX}${createHash('sha256').update(deploymentId).digest('hex').slice(0, 24)}`;
}

export function readEventMetadata(
  db: SqliteDatabase,
  deploymentId: string
): EventMetadataRow | undefined {
  return db
    .prepare(
      `SELECT deployment_id, event_epoch, retention_floor_sequence, high_watermark_sequence
       FROM coordination_event_journal_metadata WHERE deployment_id = ?`
    )
    .get(deploymentId) as EventMetadataRow | undefined;
}

export function requireEventMetadata(db: SqliteDatabase, deploymentId: string): EventMetadataRow {
  const row = readEventMetadata(db, deploymentId);
  if (!row) throw new Error('coordination-event-journal-not-initialized');
  return row;
}

export function assertJournalContinuity(db: SqliteDatabase, metadata: EventMetadataRow): void {
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

export function assertContiguousEventRows(
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

export function mapMetadata(row: EventMetadataRow): StoredEventJournalMetadata {
  return Object.freeze({
    deploymentId: row.deployment_id,
    eventEpoch: row.event_epoch,
    retentionFloorSequence: row.retention_floor_sequence,
    highWatermarkSequence: row.high_watermark_sequence,
  });
}

export function mapEventRow(row: EventRow): StoredCoordinationEventRow {
  return Object.freeze({
    deploymentId: row.deployment_id,
    eventEpoch: row.event_epoch,
    eventSequence: row.event_sequence,
    eventId: row.event_id,
    bodyJson: row.body_json,
  });
}

export function readBackupRunRow(
  db: SqliteDatabase,
  backupRunId: string
): BackupRunRow | undefined {
  return db
    .prepare(
      `SELECT backup_run_id, deployment_id, state, revision, record_json
       FROM coordination_backup_runs WHERE backup_run_id = ?`
    )
    .get(backupRunId) as BackupRunRow | undefined;
}

export function requireBackupRunRow(db: SqliteDatabase, backupRunId: string): BackupRunRow {
  const row = readBackupRunRow(db, backupRunId);
  if (!row) throw new Error('backup-run-not-found');
  return row;
}

export function parseBackupRun(row: BackupRunRow): unknown {
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

export function validateBackupRunStorageRecord(record: {
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

export function readWriterFence(
  db: SqliteDatabase,
  deploymentId: string
): WriterFenceRow | undefined {
  return db
    .prepare('SELECT * FROM coordination_backup_writer_fences WHERE deployment_id = ?')
    .get(deploymentId) as WriterFenceRow | undefined;
}

export function readBlockingWriterFence(db: SqliteDatabase): WriterFenceRow | undefined {
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

export function assertAcceptedCommandsDrained(db: SqliteDatabase): void {
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

export function requireEpoch(metadata: EventMetadataRow, eventEpoch: string): void {
  if (metadata.event_epoch !== eventEpoch) {
    throw new Error('coordination-event-journal-epoch-mismatch');
  }
}

export function encodeDrainEvidence(input: {
  readonly backupRunId: string;
  readonly fenceGeneration: number;
  readonly throughCommandSequence: number;
  readonly throughEventSequence: number;
  readonly eventEpoch: string;
}): string {
  return `coordination-drain-v1.${Buffer.from(canonicalJson(input), 'utf8').toString('base64url')}`;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(normalizeCanonicalValue(value));
}

export function normalizeCanonicalValue(value: unknown): unknown {
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

export function assertIdentifier(value: string, field: string): void {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > 512 ||
    value.trim() !== value
  ) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}

export function assertIsoTimestamp(value: string, field: string): void {
  assertIdentifier(value, field);
  if (!Number.isFinite(Date.parse(value))) throw new Error(`coordination-storage-${field}-invalid`);
}

export function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}

export function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`coordination-storage-${field}-invalid`);
  }
}
