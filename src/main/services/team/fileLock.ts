import * as fs from 'fs';
import * as path from 'path';

const STALE_TIMEOUT_MS = 30_000;
const ACQUIRE_TIMEOUT_MS = 5_000;
const RETRY_INTERVAL_MS = 20;

function readLockAge(lockPath: string): number | null {
  try {
    const content = fs.readFileSync(lockPath, 'utf8');
    const ts = parseInt(content.split('\n')[1] ?? '', 10);
    if (Number.isFinite(ts)) return Date.now() - ts;
  } catch {
    /* lock may have been released concurrently */
  }
  return null;
}

function tryAcquire(lockPath: string): boolean {
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
    if ((err as NodeJS.ErrnoException).code === 'EEXIST') {
      const age = readLockAge(lockPath);
      if (age !== null && age > STALE_TIMEOUT_MS) {
        try {
          fs.unlinkSync(lockPath);
        } catch {
          /* another process may have cleaned it */
        }
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

export async function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const lockPath = `${filePath}.lock`;
  const deadline = Date.now() + ACQUIRE_TIMEOUT_MS;

  while (!tryAcquire(lockPath)) {
    if (Date.now() >= deadline) {
      throw new Error(`File lock timeout: ${filePath}`);
    }
    await new Promise((resolve) => setTimeout(resolve, RETRY_INTERVAL_MS));
  }

  try {
    return await fn();
  } finally {
    releaseLock(lockPath);
  }
}
