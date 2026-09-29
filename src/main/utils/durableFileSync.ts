import * as fs from 'fs';

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

export async function syncDirectoryBestEffort(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, false);
}

export async function syncDirectoryDurably(dirPath: string): Promise<void> {
  await syncDirectory(dirPath, true);
}
