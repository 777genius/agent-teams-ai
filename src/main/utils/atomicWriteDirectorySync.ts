import * as fs from 'fs';

export type AtomicWriteDirectorySyncOutcome =
  | 'durable'
  | 'unsupported-platform'
  | 'best-effort-unavailable'
  | 'failed-after-publish';

export type DirectorySyncPreparation =
  | { readonly status: 'ready'; readonly handle: fs.promises.FileHandle }
  | { readonly status: 'unsupported-platform' | 'best-effort-unavailable' };

const UNSUPPORTED_DIRECTORY_SYNC_CODES = new Set(['EINVAL', 'ENOSYS', 'ENOTSUP', 'EOPNOTSUPP']);

export function isUnsupportedDirectorySyncError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  if (code && UNSUPPORTED_DIRECTORY_SYNC_CODES.has(code)) return true;
  return (
    process.platform === 'win32' &&
    (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF')
  );
}

export async function prepareDirectorySync(
  dirPath: string,
  strict: boolean
): Promise<DirectorySyncPreparation> {
  if (process.platform === 'win32') {
    return { status: 'unsupported-platform' };
  }

  let fd: fs.promises.FileHandle | null = null;
  try {
    fd = await fs.promises.open(dirPath, 'r');
    await fd.sync();
    return { status: 'ready', handle: fd };
  } catch (error) {
    await fd?.close().catch(() => undefined);
    if (isUnsupportedDirectorySyncError(error)) {
      return { status: 'unsupported-platform' };
    }
    if (strict) {
      throw error instanceof Error
        ? error
        : new Error('Directory synchronization failed with a non-Error value', { cause: error });
    }
    return { status: 'best-effort-unavailable' };
  }
}

export async function closeDirectorySync(
  preparation: DirectorySyncPreparation | null
): Promise<void> {
  if (preparation?.status !== 'ready') return;
  await preparation.handle.close().catch(() => undefined);
}

export async function finishDirectorySyncAfterPublish(
  preparation: DirectorySyncPreparation | null
): Promise<AtomicWriteDirectorySyncOutcome | null> {
  if (!preparation) return null;
  if (preparation.status !== 'ready') return preparation.status;

  try {
    await preparation.handle.sync();
    return 'durable';
  } catch {
    return 'failed-after-publish';
  } finally {
    await closeDirectorySync(preparation);
  }
}
