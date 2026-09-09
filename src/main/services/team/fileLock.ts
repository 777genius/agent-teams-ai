import { createHash,randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const STALE_TIMEOUT_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

export interface FileLockOptions {
  acquireTimeoutMs?: number;
  staleTimeoutMs?: number;
  retryIntervalMs?: number;
}

interface LockInfo {
  pid: number | null;
  ageMs: number | null;
  content: string | null;
  identity: string | null;
}

function readLockInfo(lockPath: string): LockInfo {
  let pid: number | null = null;
  let content: string | null = null;
  let identity: string | null = null;
  let ageMs: number | null = null;
  try {
    content = fs.readFileSync(lockPath, 'utf8');
    const lines = content.split('\n');
    const parsedPid = parseInt(lines[0] ?? '', 10);
    if (Number.isFinite(parsedPid) && parsedPid > 0) {
      pid = parsedPid;
    }
    const ts = parseInt(lines[1] ?? '', 10);
    if (Number.isFinite(ts)) {
      ageMs = Date.now() - ts;
    }
  } catch {
    /* lock may have been released concurrently */
  }
  if (ageMs === null) {
    try {
      ageMs = Date.now() - fs.statSync(lockPath).mtimeMs;
    } catch {
      /* lock may have been released concurrently */
    }
  }
  try {
    const stat = fs.lstatSync(lockPath);
    identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
  } catch {
    /* concurrently released */
  }
  return { pid, ageMs, content, identity };
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== 'ESRCH';
  }
}

function sameLock(left: LockInfo, right: LockInfo): boolean {
  return (
    left.identity !== null && left.identity === right.identity && left.content === right.content
  );
}

function recoverAbandonedLock(lockPath: string, staleTimeoutMs: number): void {
  const observed = readLockInfo(lockPath);
  // A live (or permission-inaccessible) owner retains exclusion regardless of age.
  if (
    observed.pid !== null
      ? isProcessAlive(observed.pid)
      : observed.ageMs === null || observed.ageMs <= staleTimeoutMs
  )
    return;
  if (!observed.identity) return;
  if (observed.pid === null) {
    try {
      if (!fs.lstatSync(lockPath).isDirectory()) return;
    } catch {
      return;
    }
  }
  // Serialize reclaimers of THIS abandoned acquisition. Another generation has a
  // different identity/token and cannot be unlinked by an old reclaimer. A crash
  // during this short synchronous claim fails closed, rather than stealing a lock.
  const key = createHash('sha256').update(`${observed.identity}:${observed.content}`).digest('hex');
  const claim = `${lockPath}.reclaim-${key}`;
  let fd: number;
  try {
    fd = fs.openSync(claim, 'wx');
  } catch (error) {
    if (
      (error as NodeJS.ErrnoException).code === 'EEXIST' ||
      (error as NodeJS.ErrnoException).code === 'ENOENT'
    )
      return;
    throw error;
  }
  try {
    if (sameLock(observed, readLockInfo(lockPath)))
      fs.rmSync(lockPath, { recursive: true, force: true });
  } finally {
    fs.closeSync(fd);
    fs.unlinkSync(claim);
  }
}

function writeLockFile(lockPath: string, token: string): void {
  const fd = fs.openSync(lockPath, 'wx');
  let closeError: unknown = null;
  try {
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n${token}\n`);
  } finally {
    try {
      fs.closeSync(fd);
    } catch (err) {
      closeError = err;
    }
  }
  if (closeError) {
    throw closeError instanceof Error ? closeError : new Error('Failed to close file lock');
  }
}

function isExistingLockError(code: string | undefined): boolean {
  return code === 'EEXIST' || code === 'EISDIR';
}

function tryAcquire(lockPath: string, options: Required<FileLockOptions>, token: string): boolean {
  try {
    // Fast path: assume the lock directory already exists (the common case once a
    // team dir is created). This drops an existsSync(dir) stat from EVERY acquire,
    // which adds up across the many lock cycles during a team launch.
    writeLockFile(lockPath, token);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Lock directory missing - create it lazily and acquire in the same call, so
      // first-acquire latency in a fresh dir is unchanged.
      try {
        fs.mkdirSync(path.dirname(lockPath), { recursive: true });
        writeLockFile(lockPath, token);
        return true;
      } catch (retryError) {
        const retryCode = (retryError as NodeJS.ErrnoException).code;
        if (retryCode === 'ENOENT') {
          return false;
        }
        if (isExistingLockError(retryCode)) {
          recoverAbandonedLock(lockPath, options.staleTimeoutMs);
          return false;
        }
        throw retryError;
      }
    }
    if (isExistingLockError(code)) {
      recoverAbandonedLock(lockPath, options.staleTimeoutMs);
      return false;
    }
    throw err;
  }
}

function releaseLock(lockPath: string, token: string): void {
  try {
    if (readLockInfo(lockPath).content?.split('\n')[2] === token) fs.unlinkSync(lockPath);
  } catch {
    /* already released or cleaned up */
  }
}

function sleepSync(ms: number): void {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    // Synchronous callers need the same cross-process lock as controller writes.
  }
}

function resolveLockOptions(options: FileLockOptions): Required<FileLockOptions> {
  return {
    acquireTimeoutMs: options.acquireTimeoutMs ?? ACQUIRE_TIMEOUT_MS,
    staleTimeoutMs: options.staleTimeoutMs ?? STALE_TIMEOUT_MS,
    retryIntervalMs: options.retryIntervalMs ?? RETRY_INTERVAL_MS,
  };
}

export function withFileLockSync<T>(
  filePath: string,
  fn: () => T,
  options: FileLockOptions = {}
): T {
  const resolvedOptions = resolveLockOptions(options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + resolvedOptions.acquireTimeoutMs;
  const token = randomUUID();

  while (!tryAcquire(lockPath, resolvedOptions, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    sleepSync(Math.min(resolvedOptions.retryIntervalMs, Math.max(0, deadline - Date.now())));
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath, token);
  }
}

export async function withFileLock<T>(
  filePath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  const resolvedOptions = resolveLockOptions(options);
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + resolvedOptions.acquireTimeoutMs;
  const token = randomUUID();

  while (!tryAcquire(lockPath, resolvedOptions, token)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, resolvedOptions.retryIntervalMs));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath, token);
  }
}
