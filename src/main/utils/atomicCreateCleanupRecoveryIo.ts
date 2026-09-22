import * as fs from 'fs';
import * as path from 'path';

import type { AtomicCreateRecoveryDirectoryAuthority } from './atomicCreateCleanupCapacity';
import type { AtomicCreateRecoveryRecord } from './atomicCreateCleanupRecord';
import {
  getDurableFileIdentity,
  getDurablePathIdentity,
  isSameDurableFileIdentity,
  isSameDurablePathIdentity,
  type DurableFileIdentity,
} from './durablePathIdentity';

export function aggregateCleanupError(primaryError: unknown, laterErrors: unknown[]): unknown {
  if (laterErrors.length === 0) return primaryError;
  return new AggregateError(
    [primaryError, ...laterErrors],
    'Atomic-create cleanup failed and recovery also failed'
  );
}

export function errorCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

async function syncHandle(handle: fs.promises.FileHandle): Promise<void> {
  try {
    await handle.sync();
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function syncPath(pathname: string, flags: number | string): Promise<void> {
  await syncHandle(await fs.promises.open(pathname, flags));
}

export function noFollowReadFlags(): number {
  return (
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)
  );
}

export function boundedRecordOpenFlags(): number {
  return (
    noFollowReadFlags() |
    (typeof fs.constants.O_NONBLOCK === 'number' ? fs.constants.O_NONBLOCK : 0)
  );
}

/** Read a small ownership record without following a substituted pathname. */
export async function readBoundedRegularText(pathname: string, maxBytes: number): Promise<string> {
  const beforeOpen = await fs.promises.lstat(pathname);
  if (
    !beforeOpen.isFile() ||
    beforeOpen.isSymbolicLink() ||
    !Number.isSafeInteger(beforeOpen.size) ||
    beforeOpen.size < 0 ||
    beforeOpen.size > maxBytes
  ) {
    throw new Error(`Atomic-create ownership record is not a bounded regular file: ${pathname}`);
  }
  const handle = await fs.promises.open(pathname, boundedRecordOpenFlags());
  let timer: NodeJS.Timeout | undefined;
  let closeAfterRead = false;
  try {
    const opened = await handle.stat();
    if (
      !opened.isFile() ||
      !isSameDurableFileIdentity(getDurableFileIdentity(beforeOpen), getDurableFileIdentity(opened)) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      opened.size > maxBytes
    ) {
      throw new Error(`Atomic-create ownership record changed: ${pathname}`);
    }
    const bytes = Buffer.alloc(maxBytes + 1);
    const read = handle.read(bytes, 0, bytes.length, 0);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Atomic-create ownership record read timed out: ${pathname}`)),
        1_000
      );
      timer.unref();
    });
    let bytesRead: number;
    try {
      ({ bytesRead } = await Promise.race([read, timeout]));
    } catch (error) {
      // Node does not expose cancellation for FileHandle.read().  Do not close
      // this descriptor underneath an in-flight read: a later operation could
      // otherwise reuse its fd number. The timed-out caller fails promptly,
      // while this descriptor closes only after the kernel operation drains.
      closeAfterRead = true;
      void read.catch(() => undefined).then(() => handle.close().catch(() => undefined));
      throw error;
    }
    if (bytesRead > maxBytes) {
      throw new Error(`Atomic-create ownership record exceeds ${maxBytes} bytes: ${pathname}`);
    }
    return bytes.subarray(0, bytesRead).toString('utf8');
  } finally {
    if (timer) clearTimeout(timer);
    if (!closeAfterRead) await handle.close().catch(() => undefined);
  }
}

export function directoryOpenFlags(): number {
  return (
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
    (typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0)
  );
}

function isUnsupportedDirectorySync(error: unknown): boolean {
  return ['EINVAL', 'ENOTSUP', 'EOPNOTSUPP', 'EPERM', 'EISDIR'].includes(errorCode(error) ?? '');
}

export async function syncRecoveryDirectory(directoryPath: string): Promise<void> {
  try {
    await syncPath(directoryPath, directoryOpenFlags());
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

export async function syncRecoveryRecord(
  recordPath: string,
  cleanupDirectory: string,
  parentDirectory: string
): Promise<void> {
  await syncPath(recordPath, noFollowReadFlags());
  await syncRecoveryDirectory(cleanupDirectory);
  await syncRecoveryDirectory(parentDirectory);
}

export async function boundedMatchingEntries(
  directoryPath: string,
  pattern: RegExp,
  limit: number,
  kind: string
): Promise<string[]> {
  const directory = await fs.promises.opendir(directoryPath);
  const entries: string[] = [];
  try {
    for await (const entry of directory) {
      if (!pattern.test(entry.name)) continue;
      if (entries.length >= limit) {
        throw new Error(`Atomic-create ${kind} retention limit (${limit}) exceeded`);
      }
      entries.push(entry.name);
    }
  } finally {
    await directory.close().catch(() => undefined);
  }
  return entries;
}

export async function createRecoveryRecord(
  parentDirectory: string,
  allocatedDirectory: AtomicCreateRecoveryDirectoryAuthority,
  cleanupDirectoryName: string,
  nonce: string,
  cleanupAuthority: string,
  attachmentName: string,
  attachmentIdentity: DurableFileIdentity
): Promise<{
  record: AtomicCreateRecoveryRecord;
  recordPath: string;
  directoryHandle: fs.promises.FileHandle;
  stableDirectory: string;
}> {
  const { directoryHandle, stablePath: stableDirectory } = allocatedDirectory;
  let retained = false;
  try {
    const directoryStats = await directoryHandle.stat();
    const directoryIdentity = getDurablePathIdentity(directoryStats);
    if (
      !directoryStats.isDirectory() ||
      !isSameDurablePathIdentity(directoryIdentity, allocatedDirectory.identity) ||
      directoryStats.birthtimeMs !== allocatedDirectory.identity.birthtimeMs
    ) {
      throw new Error('Atomic-create recovery directory is not a directory');
    }
    const record: AtomicCreateRecoveryRecord = {
      version: 1,
      nonce,
      cleanupAuthority,
      directoryName: cleanupDirectoryName,
      directoryIdentity,
      attachment: { name: attachmentName, identity: attachmentIdentity },
    };
    const recordPath = path.join(stableDirectory, '.atomic-create-recovery.json');
    await fs.promises.writeFile(recordPath, JSON.stringify(record), {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    await syncRecoveryRecord(recordPath, stableDirectory, parentDirectory);
    retained = true;
    return { record, recordPath, directoryHandle, stableDirectory };
  } finally {
    if (!retained) await directoryHandle.close().catch(() => undefined);
  }
}
