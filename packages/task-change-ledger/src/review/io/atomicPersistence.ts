import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { isTransientFsErrorCode, RENAME_PUBLISH_RETRY } from './transientFsRetry.js';
import { sameArtifact, unlinkOwnedArtifact, writeGuardedTemp } from './mutationAuthority.js';
import type { ArtifactIdentity } from './mutationAuthority.js';

export interface AtomicWriteOptions {
  assertCurrent?: () => void;
  mode?: number;
  durability?: 'best-effort' | 'strict';
  syncDirectory?: boolean;
  /**
   * Runs after the temporary file is complete and synced, immediately before every
   * publish attempt (including Windows retries).
   * Callers can use this to repeat a compare-and-swap guard without exposing a
   * partially-written target.
   */
  beforeCommit?: () => Promise<void>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function renameWithRetry(
  src: string,
  dest: string,
  beforeAttempt?: () => Promise<void>,
  assertCurrent?: () => void
): Promise<void> {
  for (let attempt = 1; attempt <= RENAME_PUBLISH_RETRY.maxAttempts; attempt++) {
    await beforeAttempt?.();
    assertCurrent?.();
    try {
      await fs.promises.rename(src, dest);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (isTransientFsErrorCode(code) && attempt < RENAME_PUBLISH_RETRY.maxAttempts) {
        await sleep(RENAME_PUBLISH_RETRY.delayMs(attempt));
        continue;
      }
      throw error;
    }
  }
}

export async function renamePathWithRetry(
  src: string,
  dest: string,
  options: { syncDirectories?: boolean; durability?: 'best-effort' | 'strict' } = {}
): Promise<void> {
  // The retry loop covers the rename and nothing else. Once the rename has
  // succeeded the source name is gone, so retrying anything that follows it -
  // the directory sync refused with EPERM/EACCES/EBUSY, say - would rename a
  // path that no longer exists and report ENOENT for data that is in fact
  // already published. A sync failure is reported as itself.
  await renameWithRetry(src, dest);
  if (options.syncDirectories) {
    await syncRenamedDirectories(src, dest, options.durability === 'strict');
  }
}

export async function atomicWriteAsync(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);
  let owned: ArtifactIdentity | undefined;

  try {
    options.assertCurrent?.();
    await fs.promises.mkdir(dir, { recursive: true });
    options.assertCurrent?.();
    if (options.assertCurrent)
      await writeGuardedTemp(tmpPath, data, options.mode, options, (identity) => {
        owned = identity;
      });
    else
      await fs.promises.writeFile(tmpPath, data, {
        ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
        flag: 'wx',
        ...(options.mode === undefined ? {} : { mode: options.mode }),
      });

    options.assertCurrent?.();
    await syncFile(tmpPath, options.durability === 'strict');
    await renameWithRetry(
      tmpPath,
      targetPath,
      options.beforeCommit,
      options.assertCurrent
        ? () => {
            options.assertCurrent!();
            if (!owned || !sameArtifact(fs.lstatSync(tmpPath), owned))
              throw new Error('Atomic staging identity changed');
          }
        : undefined
    );
    if (options.syncDirectory) {
      await syncDirectory(dir, options.durability === 'strict');
    }
    options.assertCurrent?.();
  } catch (error) {
    if (options.assertCurrent) {
      try {
        unlinkOwnedArtifact(tmpPath, owned, options);
      } catch {
        /* Retain private evidence after revocation. */
      }
    } else await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}

export async function syncFile(filePath: string, strict: boolean): Promise<void> {
  let fd: fs.promises.FileHandle | null = null;
  let firstError: unknown = null;
  try {
    fd = await fs.promises.open(filePath, 'r+');
    await fd.sync();
  } catch (error) {
    firstError = error;
  } finally {
    try {
      await fd?.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (firstError && strict) {
    throw firstError instanceof Error
      ? firstError
      : new Error('File synchronization failed with a non-Error value', { cause: firstError });
  }
}

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) return true;
  // Windows does not provide a portable directory handle that can be fsynced.
  // Keep only the platform-specific open/sync failures best-effort there; real
  // storage failures such as EIO and ENOSPC must still fail strict operations.
  return (
    process.platform === 'win32' &&
    (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF')
  );
}

export async function syncDirectory(dirPath: string, strict: boolean): Promise<void> {
  let fd: fs.promises.FileHandle | null = null;
  let firstError: unknown = null;
  try {
    fd = await fs.promises.open(dirPath, 'r');
    await fd.sync();
  } catch (error) {
    firstError = error;
  } finally {
    try {
      await fd?.close();
    } catch (error) {
      firstError ??= error;
    }
  }
  if (strict && firstError && !isUnsupportedDirectorySyncError(firstError)) {
    throw firstError instanceof Error
      ? firstError
      : new Error('Directory synchronization failed with a non-Error value', {
          cause: firstError,
        });
  }
}

export async function syncDirectoryDurably(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, true);
}

export async function syncRenamedDirectories(
  src: string,
  dest: string,
  strict: boolean
): Promise<void> {
  const sourceDir = path.dirname(src);
  const destinationDir = path.dirname(dest);
  await syncDirectory(destinationDir, strict);
  if (sourceDir !== destinationDir) {
    await syncDirectory(sourceDir, strict);
  }
}

export async function unlinkPathDurably(filePath: string): Promise<void> {
  await fs.promises.unlink(filePath);
  await syncDirectory(path.dirname(filePath), true);
}
