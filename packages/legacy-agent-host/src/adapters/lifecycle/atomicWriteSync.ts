import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { isTransientFsErrorCode, RENAME_PUBLISH_RETRY } from '@agent-teams/task-change-ledger/review-io';

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function renameWithRetrySync(src: string, dest: string): void {
  for (let attempt = 1; attempt <= RENAME_PUBLISH_RETRY.maxAttempts; attempt++) {
    try {
      fs.renameSync(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isTransientFsErrorCode(code) && attempt < RENAME_PUBLISH_RETRY.maxAttempts) {
        sleepSync(RENAME_PUBLISH_RETRY.delayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

export function renamePathWithRetrySync(src: string, dest: string): void {
  renameWithRetrySync(src, dest);
}

export function atomicWriteSync(
  targetPath: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): void {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    fs.mkdirSync(dir, { recursive: true });
    if (options.mode === undefined) {
      fs.writeFileSync(tmpPath, data, typeof data === 'string' ? 'utf8' : undefined);
    } else {
      fs.writeFileSync(tmpPath, data, {
        ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
        mode: options.mode,
      });
    }
    renameWithRetrySync(tmpPath, targetPath);
  } catch (error) {
    fs.rmSync(tmpPath, { force: true });
    throw error;
  }
}
