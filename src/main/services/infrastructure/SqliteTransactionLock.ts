import * as fs from 'node:fs';
import * as path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);
const SQLITE_TRANSACTION_LOCK_DATABASE_SUFFIX = '.lock.sqlite3';
const SQLITE_TRANSACTION_LOCK_SIDECAR_SUFFIXES = ['-journal', '-shm', '-wal'] as const;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
const MAX_IDENTITY_PREPARATION_ATTEMPTS = 8;

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

interface DatabaseIdentityGuard {
  created: boolean;
  descriptor: number;
  identity: FileIdentity;
}

interface Failure {
  error: unknown;
  context: string;
}

export interface SqliteTransactionLockTestHooks {
  afterAbsentFilePrecreated?(databasePath: string): void;
  beforeDatabaseOpen?(databasePath: string): void;
  afterDatabaseOpen?(databasePath: string): void;
}

let testHooks: SqliteTransactionLockTestHooks | undefined;

/** Test-only race injection seam. Production callers must not configure it. */
export function setSqliteTransactionLockTestHooksForTests(
  hooks: SqliteTransactionLockTestHooks | undefined
): void {
  if (process.env.NODE_ENV !== 'test') {
    throw new Error('SQLite transaction lock test hooks are only available in tests');
  }
  testHooks = hooks;
}

interface OpenLock {
  database: DatabaseSync;
  databasePath: string;
  databaseIdentity: FileIdentity;
  identityDescriptor: number;
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

function captureFailure(context: string, operation: () => void): Failure | null {
  try {
    operation();
    return null;
  } catch (error) {
    return { context, error };
  }
}

function contextualizeFailure(failure: Failure): unknown {
  if (failure.error !== undefined) return failure.error;
  return new Error(`${failure.context} failed by throwing undefined`, { cause: failure.error });
}

function throwWithCleanupFailures(primary: Failure, cleanupFailures: Failure[]): never {
  if (cleanupFailures.length === 0) throw primary.error;
  const errors = [primary, ...cleanupFailures].map(contextualizeFailure);
  throw new AggregateError(errors, `${primary.context} and cleanup failed`, { cause: errors[0] });
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

function openDatabaseIdentityGuard(databasePath: string): DatabaseIdentityGuard {
  for (let attempt = 0; attempt < MAX_IDENTITY_PREPARATION_ATTEMPTS; attempt += 1) {
    const existingIdentity = assertRegularDatabase(databasePath);
    let descriptor: number;
    let created = false;
    try {
      if (existingIdentity) {
        descriptor = fs.openSync(databasePath, fs.constants.O_RDONLY | NO_FOLLOW);
      } else {
        descriptor = fs.openSync(
          databasePath,
          fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_RDWR | NO_FOLLOW,
          0o600
        );
        created = true;
      }
    } catch (error) {
      if (
        isMissing(error) ||
        (!existingIdentity && (error as NodeJS.ErrnoException).code === 'EEXIST')
      ) {
        continue;
      }
      throw error;
    }

    try {
      const descriptorStats = fs.fstatSync(descriptor, { bigint: true });
      const pathStats = fs.lstatSync(databasePath, { bigint: true });
      const descriptorIdentity = identity(descriptorStats);
      if (
        !descriptorStats.isFile() ||
        pathStats.isSymbolicLink() ||
        !pathStats.isFile() ||
        !sameIdentity(descriptorIdentity, identity(pathStats)) ||
        (existingIdentity && !sameIdentity(existingIdentity, descriptorIdentity))
      ) {
        throw new Error(`Lock database identity changed before opening: ${databasePath}`);
      }
      if (created) syncDirectory(path.dirname(databasePath));
      return { created, descriptor, identity: descriptorIdentity };
    } catch (error) {
      const primary = { context: 'SQLite lock identity preparation', error };
      const closeFailure = captureFailure('SQLite lock identity descriptor close', () =>
        fs.closeSync(descriptor)
      );
      throwWithCleanupFailures(primary, closeFailure ? [closeFailure] : []);
    }
  }
  throw new Error(`Lock database identity kept changing before opening: ${databasePath}`);
}

function validateDatabaseIdentity(
  databasePath: string,
  guard: DatabaseIdentityGuard,
  parentIdentity: FileIdentity
): void {
  const descriptorStats = fs.fstatSync(guard.descriptor, { bigint: true });
  const databaseStats = fs.lstatSync(databasePath, { bigint: true });
  const parentStats = fs.lstatSync(path.dirname(databasePath), { bigint: true });
  if (
    !descriptorStats.isFile() ||
    databaseStats.isSymbolicLink() ||
    !databaseStats.isFile() ||
    parentStats.isSymbolicLink() ||
    !parentStats.isDirectory() ||
    !sameIdentity(guard.identity, identity(descriptorStats)) ||
    !sameIdentity(guard.identity, identity(databaseStats)) ||
    !sameIdentity(parentIdentity, identity(parentStats))
  ) {
    throw new Error(`Lock database identity changed while opening: ${databasePath}`);
  }
}

function assertPathOwnership(lock: OpenLock, ownershipLostMessage: string): void {
  try {
    const parentStats = fs.lstatSync(path.dirname(lock.databasePath), { bigint: true });
    const databaseStats = fs.lstatSync(lock.databasePath, { bigint: true });
    const descriptorStats = fs.fstatSync(lock.identityDescriptor, { bigint: true });
    if (
      !parentStats.isSymbolicLink() &&
      parentStats.isDirectory() &&
      !databaseStats.isSymbolicLink() &&
      databaseStats.isFile() &&
      descriptorStats.isFile() &&
      sameIdentity(lock.parentIdentity, identity(parentStats)) &&
      sameIdentity(lock.databaseIdentity, identity(databaseStats)) &&
      sameIdentity(lock.databaseIdentity, identity(descriptorStats))
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
  const parentIdentity = identity(fs.lstatSync(canonicalParent, { bigint: true }));
  const guard = openDatabaseIdentityGuard(canonicalPath);
  let database: DatabaseSync | undefined;
  try {
    if (guard.created) testHooks?.afterAbsentFilePrecreated?.(canonicalPath);
    testHooks?.beforeDatabaseOpen?.(canonicalPath);
    database = new DatabaseSync(canonicalPath);
    testHooks?.afterDatabaseOpen?.(canonicalPath);
    database.exec('PRAGMA busy_timeout = 0');
    validateDatabaseIdentity(canonicalPath, guard, parentIdentity);
    try {
      fs.chmodSync(canonicalPath, 0o600);
    } catch (error) {
      if (process.platform !== 'win32') throw error;
    }
    return {
      database,
      databasePath: canonicalPath,
      databaseIdentity: guard.identity,
      identityDescriptor: guard.descriptor,
      parentIdentity,
    };
  } catch (error) {
    const cleanupFailures: Failure[] = [];
    if (database) {
      const openedDatabase = database;
      const closeFailure = captureFailure('SQLite lock database close', () =>
        openedDatabase.close()
      );
      if (closeFailure) cleanupFailures.push(closeFailure);
    }
    const descriptorCloseFailure = captureFailure('SQLite lock identity descriptor close', () =>
      fs.closeSync(guard.descriptor)
    );
    if (descriptorCloseFailure) cleanupFailures.push(descriptorCloseFailure);
    throwWithCleanupFailures({ context: 'SQLite lock open', error }, cleanupFailures);
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
  closeLockResources(lock);
}

function closeLockResources(lock: OpenLock): void {
  const databaseCloseFailure = captureFailure('SQLite lock database close', () =>
    lock.database.close()
  );
  const descriptorCloseFailure = captureFailure('SQLite lock identity descriptor close', () =>
    fs.closeSync(lock.identityDescriptor)
  );
  if (databaseCloseFailure && descriptorCloseFailure) {
    throwWithCleanupFailures(databaseCloseFailure, [descriptorCloseFailure]);
  }
  if (databaseCloseFailure) throw databaseCloseFailure.error;
  if (descriptorCloseFailure) throw descriptorCloseFailure.error;
}

function rollbackAndCloseAfterFailure(lock: OpenLock, context: string, error: unknown): never {
  const primary = { context, error };
  try {
    lock.database.exec('ROLLBACK');
  } catch {
    // BEGIN may not have succeeded, or SQLite may already have rolled back.
  }
  const closeFailure = captureFailure('SQLite lock resource close', () => closeLockResources(lock));
  throwWithCleanupFailures(primary, closeFailure ? [closeFailure] : []);
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
    const busy = isBusy(error);
    try {
      rollbackAndClose(lock);
    } catch (cleanupError) {
      throwWithCleanupFailures({ context: 'SQLite lock acquisition', error }, [
        { context: 'SQLite lock database close', error: cleanupError },
      ]);
    }
    if (busy) return null;
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
        rollbackAndCloseAfterFailure(lock, 'SQLite retained lock release', error);
      }
      closeLockResources(lock);
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
    rollbackAndCloseAfterFailure(lock, 'SQLite lock operation', error);
  }
  closeLockResources(lock);
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
    rollbackAndCloseAfterFailure(lock, 'SQLite lock operation', error);
  }
  closeLockResources(lock);
  return result;
}
