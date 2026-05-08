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
}

function readLockInfo(lockPath: string): LockInfo {
  let pid: number | null = null;
  let ageMs: number | null = null;
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
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
  return { pid, ageMs };
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

function shouldBreakExistingLock(lockPath: string, staleTimeoutMs: number): boolean {
  const info = readLockInfo(lockPath);
  if (info.pid !== null && !isProcessAlive(info.pid)) {
    return true;
  }
  return info.ageMs !== null && info.ageMs > staleTimeoutMs;
}

function removeLockPath(lockPath: string): void {
  try {
    fs.rmSync(lockPath, { recursive: true, force: true });
  } catch {
    /* another process may have cleaned it */
  }
}

function tryAcquire(lockPath: string, options: Required<FileLockOptions>): boolean {
  try {
    const dir = path.dirname(lockPath);
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
    const fd = fs.openSync(lockPath, 'wx');
    fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
    fs.closeSync(fd);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'EEXIST' || code === 'EISDIR') {
      if (shouldBreakExistingLock(lockPath, options.staleTimeoutMs)) {
        removeLockPath(lockPath);
      }
      return false;
    }
    throw err;
  }
}

function releaseLock(lockPath: string): void {
  try {
    fs.unlinkSync(lockPath);
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

  while (!tryAcquire(lockPath, resolvedOptions)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    sleepSync(Math.min(resolvedOptions.retryIntervalMs, Math.max(0, deadline - Date.now())));
  }

  try {
    return fn();
  } finally {
    releaseLock(lockPath);
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

  while (!tryAcquire(lockPath, resolvedOptions)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, resolvedOptions.retryIntervalMs));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}
