import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;
const LEGACY_SAFE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const WINDOWS_DIRECTORY_SYNC_UNSUPPORTED = new Set(['EACCES', 'EPERM', 'EISDIR', 'EBADF']);

/**
 * Reserved cutover marker bytes. Publication is intentionally not performed by
 * this module: the desktop runtime has no authoritative proof that every
 * process capable of the old protocol is quiescent.
 */
export const FILE_LOCK_RETIREMENT_MARKER = '0\n9007199254740991\nagent-teams-sqlite-cutover-v1\n';

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  /** Retained for caller compatibility. Active locks are never reclaimed by age. */
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
}

interface FileIdentity {
  dev: bigint;
  ino: bigint;
}

interface OwnedLock {
  canonicalParent: string;
  content: string;
  descriptor: number;
  identity: FileIdentity;
  lockPath: string;
  ownerKey: string;
  parentIdentity: FileIdentity;
  token: symbol;
}

const sameProcessOwners = new Map<string, symbol>();

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

function ensureParent(lockPath: string): { canonicalLockPath: string; canonicalParent: string } {
  const parent = path.dirname(lockPath);
  fs.mkdirSync(parent, { recursive: true, mode: 0o700 });
  const canonicalParent = fs.realpathSync.native(parent);
  const stats = fs.lstatSync(canonicalParent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe file lock directory: ${parent}`);
  }
  return {
    canonicalLockPath: path.join(canonicalParent, path.basename(lockPath)),
    canonicalParent,
  };
}

function assertOwned(lock: OwnedLock, ownershipLostMessage: string): void {
  try {
    const descriptorStats = fs.fstatSync(lock.descriptor, { bigint: true });
    const parentStats = fs.lstatSync(lock.canonicalParent, { bigint: true });
    const pathStats = fs.lstatSync(lock.lockPath, { bigint: true });
    if (
      fs.realpathSync.native(path.dirname(lock.ownerKey)) === lock.canonicalParent &&
      !parentStats.isSymbolicLink() &&
      parentStats.isDirectory() &&
      descriptorStats.isFile() &&
      !pathStats.isSymbolicLink() &&
      pathStats.isFile() &&
      sameIdentity(lock.identity, identity(descriptorStats)) &&
      sameIdentity(lock.identity, identity(pathStats)) &&
      sameIdentity(lock.parentIdentity, identity(parentStats)) &&
      fs.readFileSync(lock.lockPath, 'utf8') === lock.content
    ) {
      return;
    }
  } catch {
    // Missing, replaced, or unreadable paths cannot prove ownership.
  }
  throw new Error(ownershipLostMessage);
}

function tryAcquire(filePath: string): OwnedLock | null {
  const requestedLockPath = path.resolve(`${filePath}.lock`);
  const { canonicalLockPath: lockPath, canonicalParent } = ensureParent(requestedLockPath);
  const token = Symbol(lockPath);
  const content = `${process.pid}\n${LEGACY_SAFE_TIMESTAMP}\nagent-teams-legacy-authoritative-v1\n${randomUUID()}\n`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST') return null;
    throw error;
  }

  try {
    fs.writeFileSync(descriptor, content, 'utf8');
    fs.fsyncSync(descriptor);
    const stats = fs.fstatSync(descriptor, { bigint: true });
    if (!stats.isFile()) throw new Error(`Unsafe file lock: ${lockPath}`);
    syncDirectory(path.dirname(lockPath));
    const lock: OwnedLock = {
      canonicalParent,
      content,
      descriptor,
      identity: identity(stats),
      lockPath,
      ownerKey: requestedLockPath,
      parentIdentity: identity(fs.lstatSync(canonicalParent, { bigint: true })),
      token,
    };
    assertOwned(lock, `File lock ownership was lost: ${filePath}`);
    sameProcessOwners.set(requestedLockPath, token);
    return lock;
  } catch (error) {
    fs.closeSync(descriptor);
    // The path was created by this attempt, but publication did not complete.
    // Leave it in place: deleting by pathname here would reintroduce ABA.
    throw error;
  }
}

function release(lock: OwnedLock, ownershipLostMessage: string): void {
  try {
    assertOwned(lock, ownershipLostMessage);
    fs.unlinkSync(lock.lockPath);
    syncDirectory(path.dirname(lock.lockPath));
  } finally {
    fs.closeSync(lock.descriptor);
    if (sameProcessOwners.get(lock.ownerKey) === lock.token) {
      sameProcessOwners.delete(lock.ownerKey);
    }
  }
}

function combineErrors(operationError: unknown, releaseError: unknown): never {
  if (operationError === undefined) throw releaseError;
  if (releaseError === undefined) throw operationError;
  throw new AggregateError(
    [operationError, releaseError],
    'File lock operation and cleanup both failed',
    { cause: operationError }
  );
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // The wait is bounded. Same-process async ownership is rejected below.
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function timeout(filePath: string): Error {
  return new Error(`File lock timeout: ${filePath}`);
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  const ownerKey = path.resolve(`${filePath}.lock`);
  if (sameProcessOwners.has(ownerKey)) {
    throw new Error(`File lock is already held by this process: ${filePath}`);
  }
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let lock = tryAcquire(filePath);
  while (!lock) {
    if (Date.now() >= deadline) throw timeout(filePath);
    sleepSync(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    lock = tryAcquire(filePath);
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    assertOwned(lock, `File lock ownership was lost: ${filePath}`);
    result = fn();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    release(lock, `File lock ownership was lost: ${filePath}`);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined || releaseError !== undefined) {
    combineErrors(operationError, releaseError);
  }
  return result as T;
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let lock = tryAcquire(filePath);
  while (!lock) {
    if (Date.now() >= deadline) throw timeout(filePath);
    await delay(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    lock = tryAcquire(filePath);
  }

  let result: T | undefined;
  let operationError: unknown;
  try {
    assertOwned(lock, `File lock ownership was lost: ${filePath}`);
    result = await fn();
  } catch (error) {
    operationError = error;
  }
  let releaseError: unknown;
  try {
    release(lock, `File lock ownership was lost: ${filePath}`);
  } catch (error) {
    releaseError = error;
  }
  if (operationError !== undefined || releaseError !== undefined) {
    combineErrors(operationError, releaseError);
  }
  return result as T;
}
