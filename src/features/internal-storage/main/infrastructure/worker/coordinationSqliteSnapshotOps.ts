import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import {
  assertIdentifier,
  assertNonNegativeInteger,
  assertPositiveInteger,
  readBlockingWriterFence,
  requireBackupRunRow,
} from './coordinationDurabilityState';
import {
  INTERNAL_STORAGE_APPLICATION_ID,
  INTERNAL_STORAGE_REQUIRED_BACKUP_TABLES,
  INTERNAL_STORAGE_SCHEMA_VERSION,
} from './internalStorageMigrations';

import type {
  CoordinationDurabilityWorkerPayloadByOp,
  SqliteBackupChunkStorageResult,
  SqliteOnlineBackupStorageResult,
  SqliteSnapshotVerificationStorageResult,
} from './internalStorageWorkerProtocol';
import type DatabaseConstructor from 'better-sqlite3';

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;
type CreateDatabase = (
  databasePath: string,
  options?: { readonly?: boolean; fileMustExist?: boolean }
) => SqliteDatabase;

const MAX_BACKUP_CHUNK_BYTES = 1024 * 1024;
const BACKUP_SCRATCH_DIRECTORY_SUFFIX = '.coordination-backup-staging';
const REQUIRED_IDENTITY_COMPONENT = 'team-identity';

export class CoordinationSqliteSnapshotOps {
  private readonly backupScratchRoot: string;

  constructor(
    private readonly getDb: () => SqliteDatabase,
    private readonly createDatabase: CreateDatabase,
    databasePath: string
  ) {
    validateSnapshotPath(databasePath);
    this.backupScratchRoot = `${databasePath}${BACKUP_SCRATCH_DIRECTORY_SUFFIX}`;
  }

  async discard(
    input: CoordinationDurabilityWorkerPayloadByOp['coordinationBackup.sqlite.discard']
  ): Promise<null> {
    assertIdentifier(input.backupRunId, 'backupRunId');
    await removePartialSnapshot(this.snapshotScratchPath(input.backupRunId));
    return null;
  }

  async createOnlineBackup(
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

  verifySqliteSnapshot(
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

  readSqliteSnapshotChunk(
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
  createDatabase: CreateDatabase
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
  createDatabase: CreateDatabase
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
