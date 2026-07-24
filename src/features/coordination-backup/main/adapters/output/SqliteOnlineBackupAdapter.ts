import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from '@features/internal-storage/main';

import { parseSha256Digest, SQLITE_ONLINE_BACKUP_METHOD } from '../../../contracts';

import type {
  BackupManifestEntry,
  BackupRunId,
  OnlineBackupSnapshot,
  SqliteIntegrityEvidence,
} from '../../../contracts';
import type {
  OnlineBackupResult,
  SqliteIntegrityResult,
  SqliteOnlineBackupPort,
  SqliteSnapshotIntegrityPort,
} from '../../../core/application';
import type {
  BackupPublicationArtifactWriter,
  SqliteBackupArtifactPublisher,
} from '../../infrastructure';
import type { CoordinationDurabilityStorageGateway } from '@features/internal-storage/main';

export const INTERNAL_STORAGE_SQLITE_BACKUP_ENTRY_ID = 'sqlite/internal-storage.sqlite' as const;

export class SqliteOnlineBackupAdapter
  implements SqliteOnlineBackupPort, SqliteSnapshotIntegrityPort
{
  private readonly nowMs: () => number;
  private readonly deadlineMs: number;
  private readonly busyRetryMs: number;
  private readonly pagesPerStep: number;

  constructor(
    private readonly options: {
      readonly storage: CoordinationDurabilityStorageGateway;
      readonly snapshotPublisher: SqliteBackupArtifactPublisher;
      readonly artifactWriter: BackupPublicationArtifactWriter;
      readonly nowMs?: () => number;
      readonly deadlineMs?: number;
      readonly busyRetryMs?: number;
      readonly pagesPerStep?: number;
    }
  ) {
    if (!options.storage || !options.snapshotPublisher || !options.artifactWriter) {
      throw new TypeError('sqlite-online-backup-adapter-options-invalid');
    }
    this.nowMs = options.nowMs ?? Date.now;
    this.deadlineMs = options.deadlineMs ?? 30_000;
    this.busyRetryMs = options.busyRetryMs ?? 25;
    this.pagesPerStep = options.pagesPerStep ?? 128;
    for (const [name, value] of [
      ['deadlineMs', this.deadlineMs],
      ['busyRetryMs', this.busyRetryMs],
      ['pagesPerStep', this.pagesPerStep],
    ] as const) {
      if (!Number.isSafeInteger(value) || value <= 0) {
        throw new TypeError(`sqlite-online-backup-adapter-${name}-invalid`);
      }
    }
  }

  async createOnlineSnapshot(
    request: Parameters<SqliteOnlineBackupPort['createOnlineSnapshot']>[0]
  ): Promise<OnlineBackupResult> {
    requireSnapshotRequest(request.backupRunId, request.fence, request.coordinationBarrier);
    const result = await this.options.storage.coordinationBackupSqliteOnline({
      backupRunId: request.backupRunId,
      deadlineAtMs: this.nowMs() + this.deadlineMs,
      busyRetryMs: this.busyRetryMs,
      pagesPerStep: this.pagesPerStep,
    });
    if (result.status !== 'completed') {
      return Object.freeze({ status: 'failed' as const, reason: result.status });
    }
    if (
      result.applicationId !== INTERNAL_STORAGE_APPLICATION_ID ||
      result.userVersion !== INTERNAL_STORAGE_SCHEMA_VERSION ||
      typeof result.byteLength !== 'number' ||
      !Number.isSafeInteger(result.byteLength) ||
      result.byteLength <= 0 ||
      typeof result.mode !== 'number' ||
      !Number.isInteger(result.mode) ||
      result.mode < 0 ||
      result.mode > 0o777 ||
      typeof result.sha256 !== 'string'
    ) {
      throw new Error('sqlite-online-backup-worker-evidence-invalid');
    }
    const snapshotDigest = parseSha256Digest(result.sha256);
    const measured = await this.options.snapshotPublisher.publishSqliteSnapshot({
      backupRunId: request.backupRunId,
      entryId: INTERNAL_STORAGE_SQLITE_BACKUP_ENTRY_ID,
      byteLength: result.byteLength,
      sha256: snapshotDigest,
      readChunk: (offset) =>
        this.options.storage.coordinationBackupSqliteReadChunk({
          backupRunId: request.backupRunId,
          offset,
          maximumBytes: 1024 * 1024,
        }),
    });
    const entry: BackupManifestEntry & { readonly kind: 'sqlite_snapshot' } = Object.freeze({
      entryId: INTERNAL_STORAGE_SQLITE_BACKUP_ENTRY_ID,
      participantId: 'internal-storage',
      kind: 'sqlite_snapshot' as const,
      logicalOwner: 'internal-storage',
      logicalType: 'coordination-database',
      schemaVersion: INTERNAL_STORAGE_SCHEMA_VERSION,
      byteLength: measured.byteLength,
      mode: measured.mode,
      sha256: measured.sha256,
      sourceGeneration: sqliteSourceGeneration(request),
    });
    if (
      measured.byteLength !== result.byteLength ||
      measured.mode !== result.mode ||
      measured.sha256 !== snapshotDigest
    ) {
      throw new Error('sqlite-online-backup-staged-artifact-mismatch');
    }
    const snapshot: OnlineBackupSnapshot = Object.freeze({
      method: SQLITE_ONLINE_BACKUP_METHOD,
      entry,
      applicationId: result.applicationId,
      userVersion: result.userVersion,
      sourceRunId: request.backupRunId,
    });
    return Object.freeze({ status: 'completed' as const, snapshot });
  }

  async reopenAndCheck(
    request: Parameters<SqliteSnapshotIntegrityPort['reopenAndCheck']>[0]
  ): Promise<SqliteIntegrityResult> {
    if (
      request.snapshot.sourceRunId !== request.backupRunId ||
      request.snapshot.method !== SQLITE_ONLINE_BACKUP_METHOD ||
      request.snapshot.applicationId !== INTERNAL_STORAGE_APPLICATION_ID ||
      request.snapshot.userVersion !== INTERNAL_STORAGE_SCHEMA_VERSION ||
      request.snapshot.entry.entryId !== INTERNAL_STORAGE_SQLITE_BACKUP_ENTRY_ID
    ) {
      return { status: 'invalid', reason: 'schema_mismatch' };
    }
    const result = await this.options.storage.coordinationBackupSqliteVerify({
      backupRunId: request.backupRunId,
    });
    if (result.status === 'invalid') return result;
    if (
      result.applicationId !== request.snapshot.applicationId ||
      result.userVersion !== request.snapshot.userVersion ||
      !sameStrings(result.requiredTables, INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES)
    ) {
      return { status: 'invalid', reason: 'schema_mismatch' };
    }
    const measured = await this.options.artifactWriter.measureStagedArtifact({
      backupRunId: request.backupRunId,
      entryId: request.snapshot.entry.entryId,
    });
    if (
      measured.byteLength !== request.snapshot.entry.byteLength ||
      measured.mode !== request.snapshot.entry.mode ||
      measured.sha256 !== request.snapshot.entry.sha256
    ) {
      return { status: 'invalid', reason: 'integrity_check_failed' };
    }
    await this.options.storage.coordinationBackupSqliteDiscard(request.backupRunId);
    const requiredInvariants = Object.freeze(
      Object.fromEntries([
        ...INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES.map(
          (table) => [`table:${table}`, true] as const
        ),
        ['sourceBackupRun', true] as const,
      ])
    ) as SqliteIntegrityEvidence['requiredInvariants'];
    return Object.freeze({
      status: 'valid' as const,
      evidence: Object.freeze({
        integrityCheck: 'ok' as const,
        applicationId: result.applicationId,
        userVersion: result.userVersion,
        requiredInvariants,
      }),
    });
  }
}

function requireSnapshotRequest(
  backupRunId: BackupRunId,
  fence: Parameters<SqliteOnlineBackupPort['createOnlineSnapshot']>[0]['fence'],
  barrier: Parameters<SqliteOnlineBackupPort['createOnlineSnapshot']>[0]['coordinationBarrier']
): void {
  if (
    fence.admittedRunId !== backupRunId ||
    barrier.acceptedCommandDrain.admittedRunId !== backupRunId ||
    barrier.acceptedCommandDrain.fenceGeneration !== fence.generation
  ) {
    throw new Error('sqlite-online-backup-barrier-fence-mismatch');
  }
}

function sqliteSourceGeneration(
  request: Parameters<SqliteOnlineBackupPort['createOnlineSnapshot']>[0]
): string {
  return `internal-storage-v${INTERNAL_STORAGE_SCHEMA_VERSION}:fence-${request.fence.generation}:${request.coordinationBarrier.acceptedCommandDrain.durableBarrier}`;
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
