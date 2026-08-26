import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);
const SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX = '.lock.sqlite3';
const SQLITE_TRANSACTION_LOCK_SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal'] as const;

export interface SqliteTransactionLockOptions {
  acquireTimeoutMs: number;
  retryIntervalMs: number;
  timeoutMessage: string;
  ownershipLostMessage: string;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OpenLock {
  database: DatabaseSync;
  databasePath: string;
  databaseIdentity: FileIdentity;
  parentIdentity: FileIdentity;
}

export interface RetainedSqliteTransactionLock {
  readonly databasePath: string;
  assertOwned(): void;
  release(): void;
}

export function getSqliteTransactionLockDatabasePath(lockTargetPath: string): string {
  return `${lockTargetPath}${SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX}`;
}

export function isSqliteTransactionLockArtifactName(fileName: string): boolean {
  if (path.basename(fileName) !== fileName) return false;

  const databaseSuffixIndex = fileName.lastIndexOf(SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX);
  if (databaseSuffixIndex <= 0) return false;

  const artifactSuffix = fileName.slice(
    databaseSuffixIndex + SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX.length
  );
  return (
    artifactSuffix === '' ||
    SQLITE_TRANSACTION_LOCK_SIDECAR_SUFFIXES.some((suffix) => suffix === artifactSuffix)
  );
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function identity(stats: fs.BigIntStats): FileIdentity {
  return { dev: stats.dev, ino: stats.ino };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function syncDirectory(directoryPath: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = fs.openSync(directoryPath, 'r');
    fs.fsyncSync(descriptor);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (
      process.platform !== 'win32' ||
      code === undefined ||
      !WINDOWS_DIRECTORY_SYNC_UNSUPPORTED.has(code)
    ) {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function ensureDirectoryHierarchy(directoryPath: string): void {
  const missing: string[] = [];
  let cursor = path.resolve(directoryPath);
  for (;;) {
    try {
      const stats = fs.lstatSync(cursor);
      if (stats.isSymbolicLink() || !stats.isDirectory()) {
        throw new Error(`Unsafe lock directory: ${cursor}`);
      }
      break;
    } catch (error) {
      if (!isMissing(error)) throw error;
      missing.push(cursor);
      const parent = path.dirname(cursor);
      if (parent === cursor) throw error;
      cursor = parent;
    }
  }
  for (const directory of missing.reverse()) {
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = fs.lstatSync(directory);
    if (stats.isSymbolicLink() || !stats.isDirectory()) {
      throw new Error(`Unsafe lock directory: ${directory}`);
    }
    syncDirectory(path.dirname(directory));
  }
}

function assertRegularDatabase(databasePath: string): FileIdentity | null {
  try {
    const stats = fs.lstatSync(databasePath, { bigint: true });
    if (stats.isSymbolicLink() || !stats.isFile()) {
      throw new Error(`Unsafe lock database: ${databasePath}`);
    }
    return identity(stats);
  } catch (error) {
    if (isMissing(error)) return null;
    throw error;
  }
}

function assertPathOwnership(lock: OpenLock, ownershipLostMessage: string): void {
  try {
    const parentStats = fs.lstatSync(path.dirname(lock.databasePath), { bigint: true });
    const databaseStats = fs.lstatSync(lock.databasePath, { bigint: true });
    if (
      !parentStats.isSymbolicLink() &&
      parentStats.isDirectory() &&
      !databaseStats.isSymbolicLink() &&
      databaseStats.isFile() &&
      sameIdentity(lock.parentIdentity, identity(parentStats)) &&
      sameIdentity(lock.databaseIdentity, identity(databaseStats))
    ) {
      return;
    }
  } catch {
    // Missing or unreadable paths cannot prove ownership of the acquired inode.
  }
  throw new Error(ownershipLostMessage);
}

function openLock(databasePath: string): OpenLock {
  ensureDirectoryHierarchy(path.dirname(databasePath));
  const canonicalParent = fs.realpathSync.native(path.dirname(databasePath));
  const canonicalPath = path.join(canonicalParent, path.basename(databasePath));
  const existingIdentity = assertRegularDatabase(canonicalPath);
  const parentIdentity = identity(fs.lstatSync(canonicalParent, { bigint: true }));
  const database = new DatabaseSync(canonicalPath);
  try {
    database.exec('PRAGMA busy_timeout = 0');
    const databaseIdentity = assertRegularDatabase(canonicalPath);
    if (
      !databaseIdentity ||
      (existingIdentity && !sameIdentity(existingIdentity, databaseIdentity))
    ) {
      throw new Error(`Lock database identity changed while opening: ${canonicalPath}`);
    }
    try {
      fs.chmodSync(canonicalPath, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    return { database, databasePath: canonicalPath, databaseIdentity, parentIdentity };
  } catch (error) {
    database.close();
    throw error;
  }
}

function isBusy(error: unknown): boolean {
  return /(?:database|database table) is (?:busy|locked)/i.test(
    error instanceof Error ? error.message : String(error)
  );
}

function rollbackAndClose(lock: OpenLock): void {
  try {
    lock.database.exec('ROLLBACK');
  } catch {
    // BEGIN may not have succeeded, or SQLite may already have rolled back.
  }
  lock.database.close();
}

function tryAcquire(databasePath: string, ownershipLostMessage: string): OpenLock | null {
  let lock: OpenLock;
  try {
    lock = openLock(databasePath);
  } catch (error) {
    if (isBusy(error)) return null;
    throw error;
  }
  try {
    // SQLite's OS-backed RESERVED lock is the generation/CAS operation. There
    // is no reclaim rename or unlink: a crashed connection releases the exact
    // kernel lock, while a delayed contender can only begin a later transaction.
    lock.database.exec('BEGIN IMMEDIATE');
    assertPathOwnership(lock, ownershipLostMessage);
    return lock;
  } catch (error) {
    rollbackAndClose(lock);
    if (isBusy(error)) return null;
    throw error;
  }
}

function commitLock(lock: OpenLock, ownershipLostMessage: string): void {
  assertPathOwnership(lock, ownershipLostMessage);
  lock.database.exec('COMMIT');
}

/**
 * Attempts one non-blocking acquisition and retains SQLite's OS-backed RESERVED lock until
 * release. The returned object owns the exact opened database inode; it never unlinks or
 * reclaims a contender's lock, and a crashed process is released by the kernel.
 */
export function tryRetainSqliteTransactionLock(
  databasePath: string,
  ownershipLostMessage: string
): RetainedSqliteTransactionLock | null {
  const lock = tryAcquire(databasePath, ownershipLostMessage);
  if (!lock) return null;
  let retained: OpenLock | null = lock;
  return {
    databasePath: lock.databasePath,
    assertOwned(): void {
      if (retained !== lock) throw new Error(ownershipLostMessage);
      assertPathOwnership(lock, ownershipLostMessage);
    },
    release(): void {
      if (retained !== lock) return;
      retained = null;
      try {
        commitLock(lock, ownershipLostMessage);
      } catch (error) {
        rollbackAndClose(lock);
        throw error;
      }
      lock.database.close();
    },
  };
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous callers require the same bounded cross-process protocol.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function withSqliteTransactionLockSync<T>(
  databasePath: string,
  operation: () => T,
  options: SqliteTransactionLockOptions
): T {
  const deadline = Date.now() + options.acquireTimeoutMs;
  let lock = tryAcquire(databasePath, options.ownershipLostMessage);
  while (!lock) {
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage);
    sleepSync(Math.min(options.retryIntervalMs, Math.max(1, deadline - Date.now())));
    lock = tryAcquire(databasePath, options.ownershipLostMessage);
  }
  let result: T;
  try {
    result = operation();
    commitLock(lock, options.ownershipLostMessage);
  } catch (error) {
    rollbackAndClose(lock);
    throw error;
  }
  lock.database.close();
  return result;
}

export async function withSqliteTransactionLock<T>(
  databasePath: string,
  operation: () => Promise<T>,
  options: SqliteTransactionLockOptions
): Promise<T> {
  const deadline = Date.now() + options.acquireTimeoutMs;
  let lock = tryAcquire(databasePath, options.ownershipLostMessage);
  while (!lock) {
    if (Date.now() >= deadline) throw new Error(options.timeoutMessage);
    await delay(Math.min(options.retryIntervalMs, Math.max(1, deadline - Date.now())));
    lock = tryAcquire(databasePath, options.ownershipLostMessage);
  }
  let result: T;
  try {
    result = await operation();
    commitLock(lock, options.ownershipLostMessage);
  } catch (error) {
    rollbackAndClose(lock);
    throw error;
  }
  lock.database.close();
  return result;
}
