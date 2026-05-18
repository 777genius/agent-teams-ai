import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

const RENAME_MAX_ATTEMPTS = 8;
const RENAME_RETRY_BASE_DELAY_MS = 40;
const RENAME_RETRY_MAX_DELAY_MS = 250;
const RENAME_RETRY_JITTER_MS = 25;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getRenameRetryDelayMs(attempt: number): number {
  const backoff = Math.min(RENAME_RETRY_BASE_DELAY_MS * attempt, RENAME_RETRY_MAX_DELAY_MS);
  return backoff + Math.floor(Math.random() * (RENAME_RETRY_JITTER_MS + 1));
}

async function renameWithRetry(src: string, dest: string): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_MAX_ATTEMPTS; attempt++) {
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EXDEV') {
        await fs.promises.copyFile(src, dest);
        await fs.promises.unlink(src).catch(() => undefined);
        return;
      }
      if (code && RETRYABLE_RENAME_CODES.has(code) && attempt < RENAME_MAX_ATTEMPTS) {
        await sleep(getRenameRetryDelayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

/**
 * Async atomic write: write tmp file then rename over target.
 * Uses best-effort fsync and bounded Windows transient rename retries for safety.
 */
export async function atomicWriteAsync(targetPath: string, data: string | Buffer): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, data, typeof data === 'string' ? 'utf8' : undefined);

    let fd: fs.promises.FileHandle | null = null;
    try {
      fd = await fs.promises.open(tmpPath, 'r+');
      await fd.sync();
    } catch {
      // fsync is best-effort.
    } finally {
      try {
        await fd?.close();
      } catch {
        // close is best-effort after a best-effort fsync.
      }
    }

    await renameWithRetry(tmpPath, targetPath);
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
