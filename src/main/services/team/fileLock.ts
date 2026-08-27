import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';

const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;
const LEGACY_SAFE_TIMESTAMP = Number.MAX_SAFE_INTEGER;
const AUTHORITATIVE_MAGIC = 'agent-teams-legacy-authoritative-v1';
const MAX_LOCK_BYTES = 256;
const RANDOM_UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const NO_FOLLOW = process.platform === 'win32' ? 0 : (fs.constants.O_NOFOLLOW ?? 0);
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
  requestedParent: string;
  token: symbol;
}

interface LockTarget {
  canonicalParent: string;
  lockPath: string;
  ownerKey: string;
  requestedParent: string;
}

type AcquisitionResult = OwnedLock | 'contended' | 'retry';

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

function resolveLockTarget(filePath: string): LockTarget {
  const requestedLockPath = path.resolve(`${filePath}.lock`);
  const requestedParent = path.dirname(requestedLockPath);
  fs.mkdirSync(requestedParent, { recursive: true, mode: 0o700 });
  const canonicalParent = fs.realpathSync.native(requestedParent);
  const stats = fs.lstatSync(canonicalParent);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new Error(`Unsafe file lock directory: ${requestedParent}`);
  }
  const lockPath = path.join(canonicalParent, path.basename(requestedLockPath));
  return {
    canonicalParent,
    lockPath,
    ownerKey: lockPath,
    requestedParent,
  };
}

function assertOwned(lock: OwnedLock, ownershipLostMessage: string): void {
  try {
    const descriptorStats = fs.fstatSync(lock.descriptor, { bigint: true });
    const parentStats = fs.lstatSync(lock.canonicalParent, { bigint: true });
    const pathStats = fs.lstatSync(lock.lockPath, { bigint: true });
    if (
      fs.realpathSync.native(lock.requestedParent) === lock.canonicalParent &&
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

function uncertain(filePath: string): Error {
  return new Error(`Legacy file lock ownership is uncertain: ${filePath}`);
}

function assertNotOwnedByThisProcess(filePath: string, ownerKey: string): void {
  if (sameProcessOwners.has(ownerKey)) {
    throw new Error(`File lock is already held by this process: ${filePath}`);
  }
}

function readBoundedLock(lockPath: string): string | 'retry' {
  let descriptor: number | undefined;
  try {
    const pathStatsBefore = fs.lstatSync(lockPath, { bigint: true });
    if (pathStatsBefore.isSymbolicLink() || !pathStatsBefore.isFile()) {
      throw new Error('Lock path is not a regular file');
    }
    descriptor = fs.openSync(lockPath, fs.constants.O_RDONLY | NO_FOLLOW);
    const descriptorStatsBefore = fs.fstatSync(descriptor, { bigint: true });
    if (
      !descriptorStatsBefore.isFile() ||
      !sameIdentity(identity(pathStatsBefore), identity(descriptorStatsBefore)) ||
      descriptorStatsBefore.size > BigInt(MAX_LOCK_BYTES)
    ) {
      throw new Error('Lock identity is ambiguous');
    }

    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1);
    let bytesRead = 0;
    while (bytesRead < buffer.length) {
      const count = fs.readSync(descriptor, buffer, bytesRead, buffer.length - bytesRead, null);
      if (count === 0) break;
      bytesRead += count;
    }
    const descriptorStatsAfter = fs.fstatSync(descriptor, { bigint: true });
    const pathStatsAfter = fs.lstatSync(lockPath, { bigint: true });
    if (
      bytesRead > MAX_LOCK_BYTES ||
      descriptorStatsAfter.size !== BigInt(bytesRead) ||
      !descriptorStatsAfter.isFile() ||
      pathStatsAfter.isSymbolicLink() ||
      !pathStatsAfter.isFile() ||
      !sameIdentity(identity(descriptorStatsBefore), identity(descriptorStatsAfter)) ||
      !sameIdentity(identity(descriptorStatsBefore), identity(pathStatsAfter))
    ) {
      throw new Error('Lock changed while it was being read');
    }
    return buffer.subarray(0, bytesRead).toString('utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
    throw error;
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

function isActiveProcess(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EPERM') return true;
    if (code === 'ESRCH') return false;
    throw error;
  }
}

function classifyExistingLock(filePath: string, lockPath: string): 'contended' | 'retry' {
  try {
    const observed = readBoundedLock(lockPath);
    if (observed === 'retry') return 'retry';
    const lines = observed.split('\n');
    if (
      lines.length !== 5 ||
      lines[4] !== '' ||
      !/^[1-9]\d*$/.test(lines[0]) ||
      lines[1] !== String(LEGACY_SAFE_TIMESTAMP) ||
      lines[2] !== AUTHORITATIVE_MAGIC ||
      !RANDOM_UUID_V4.test(lines[3])
    ) {
      throw uncertain(filePath);
    }
    const pid = Number(lines[0]);
    if (!Number.isSafeInteger(pid) || !isActiveProcess(pid)) throw uncertain(filePath);
    return 'contended';
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'retry';
    throw uncertain(filePath);
  }
}

function tryAcquire(filePath: string, target: LockTarget): AcquisitionResult {
  const { lockPath, canonicalParent, ownerKey, requestedParent } = target;
  assertNotOwnedByThisProcess(filePath, ownerKey);
  const token = Symbol(lockPath);
  const content = `${process.pid}\n${LEGACY_SAFE_TIMESTAMP}\n${AUTHORITATIVE_MAGIC}\n${randomUUID()}\n`;
  let descriptor: number;
  try {
    descriptor = fs.openSync(lockPath, 'wx', 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EISDIR') return classifyExistingLock(filePath, lockPath);
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
      ownerKey,
      parentIdentity: identity(fs.lstatSync(canonicalParent, { bigint: true })),
      requestedParent,
      token,
    };
    assertOwned(lock, `File lock ownership was lost: ${filePath}`);
    sameProcessOwners.set(ownerKey, token);
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
  const target = resolveLockTarget(filePath);
  assertNotOwnedByThisProcess(filePath, target.ownerKey);
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let acquisition = tryAcquire(filePath, target);
  while (acquisition === 'contended' || acquisition === 'retry') {
    if (acquisition === 'retry') {
      acquisition = tryAcquire(filePath, target);
      if (acquisition === 'retry' && Date.now() >= deadline) throw timeout(filePath);
      continue;
    }
    if (Date.now() >= deadline) throw timeout(filePath);
    sleepSync(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    acquisition = tryAcquire(filePath, target);
  }
  const lock = acquisition;

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
  const target = resolveLockTarget(filePath);
  assertNotOwnedByThisProcess(filePath, target.ownerKey);
  const deadline = Date.now() + (options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS);
  let acquisition = tryAcquire(filePath, target);
  while (acquisition === 'contended' || acquisition === 'retry') {
    if (acquisition === 'retry') {
      acquisition = tryAcquire(filePath, target);
      if (acquisition === 'retry' && Date.now() >= deadline) throw timeout(filePath);
      continue;
    }
    if (Date.now() >= deadline) throw timeout(filePath);
    await delay(Math.min(options.retryIntervalMs ?? RETRY_INTERVAL_MS, deadline - Date.now()));
    acquisition = tryAcquire(filePath, target);
  }
  const lock = acquisition;

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
