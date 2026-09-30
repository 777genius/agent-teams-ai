import * as fs from 'fs';
import * as path from 'path';

import {
  type DurableFileIdentity,
  getDurableFileIdentity,
  getDurablePathIdentity,
  isSameDurableFileIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

import type { AtomicCreateRecoveryDirectoryAuthority } from './atomicCreateCleanupCapacity';
import type { AtomicCreateRecoveryRecord } from './atomicCreateCleanupRecord';

const RECOVERY_DEADLINE_MS = 1_000;
const MAX_RECOVERY_METADATA_OPERATIONS = 256;

/** A single recovery pass is finite even when a directory contains hostile state. */
export interface AtomicCreateRecoveryBudget {
  readonly deadlineMs: number;
  remainingMetadataOperations: number;
}

export function createAtomicCreateRecoveryBudget(): AtomicCreateRecoveryBudget {
  return {
    deadlineMs: Date.now() + RECOVERY_DEADLINE_MS,
    remainingMetadataOperations: MAX_RECOVERY_METADATA_OPERATIONS,
  };
}

function remainingBudgetMs(budget: AtomicCreateRecoveryBudget, operation: string): number {
  const remaining = budget.deadlineMs - Date.now();
  if (remaining <= 0 || budget.remainingMetadataOperations <= 0) {
    throw new Error(`Atomic-create recovery ${operation} budget exhausted`);
  }
  budget.remainingMetadataOperations--;
  return remaining;
}

/**
 * Bounds every traversal/metadata await, not just descriptor reads. A timed
 * operation is left to settle before its own resource cleanup runs; no later
 * recovery action is started from that pass.
 */
export async function withinAtomicCreateRecoveryBudget<T>(
  budget: AtomicCreateRecoveryBudget,
  operation: string,
  work: () => Promise<T>,
  onTimeout?: (pending: Promise<T>) => void
): Promise<T> {
  const remaining = remainingBudgetMs(budget, operation);
  const pending = work();
  let timer: NodeJS.Timeout | undefined;
  let timedOut = false;
  try {
    return await Promise.race([
      pending,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          timedOut = true;
          reject(new Error(`Atomic-create recovery ${operation} timed out`));
        }, remaining);
        timer.unref();
      }),
    ]);
  } catch (error) {
    // Do not close resources owned by work under an in-flight syscall. Its own
    // finally/descriptor-drain path remains ordered after the kernel settles.
    if (timedOut && onTimeout) onTimeout(pending);
    else void pending.catch(() => undefined);
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/**
 * Transfer a descriptor returned after its caller timed out directly to one
 * close operation. The successful path retains ownership for its caller.
 */
export function withinAtomicCreateRecoveryOpenBudget<T extends { close(): Promise<void> }>(
  budget: AtomicCreateRecoveryBudget,
  operation: string,
  open: () => Promise<T>
): Promise<T> {
  return withinAtomicCreateRecoveryBudget(budget, operation, open, (pending) => {
    void pending.then(
      (handle) => handle.close().catch(() => undefined),
      () => undefined
    );
  });
}

async function closeWithinRecoveryBudget(
  handle: { close(): Promise<void> },
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  if (!budget) {
    await handle.close().catch(() => undefined);
    return;
  }
  let started = false;
  try {
    await withinAtomicCreateRecoveryBudget(budget, 'descriptor-close', () => {
      started = true;
      return handle.close();
    });
  } catch {
    if (!started) void handle.close().catch(() => undefined);
  }
}

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

export async function syncPath(
  pathname: string,
  flags: number | string,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  if (!budget) return syncHandle(await fs.promises.open(pathname, flags));
  const handle = await withinAtomicCreateRecoveryOpenBudget(budget, 'sync-path-open', () =>
    fs.promises.open(pathname, flags)
  );
  let closeAfterPendingSync = false;
  try {
    await withinAtomicCreateRecoveryBudget(
      budget,
      'sync-path-fsync',
      () => handle.sync(),
      (pending) => {
        closeAfterPendingSync = true;
        void pending.catch(() => undefined).then(() => handle.close().catch(() => undefined));
      }
    );
  } finally {
    if (!closeAfterPendingSync) await closeWithinRecoveryBudget(handle, budget);
  }
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
export interface BoundedRegularText {
  text: string;
  identity: DurableFileIdentity;
}

export async function readBoundedRegularTextWithIdentity(
  pathname: string,
  maxBytes: number,
  budget?: AtomicCreateRecoveryBudget
): Promise<BoundedRegularText> {
  const metadata = <T>(operation: string, work: () => Promise<T>): Promise<T> =>
    budget ? withinAtomicCreateRecoveryBudget(budget, operation, work) : work();
  const beforeOpen = await metadata('record-lstat', () => fs.promises.lstat(pathname));
  if (
    !beforeOpen.isFile() ||
    beforeOpen.isSymbolicLink() ||
    !Number.isSafeInteger(beforeOpen.size) ||
    beforeOpen.size < 0 ||
    beforeOpen.size > maxBytes
  ) {
    throw new Error(`Atomic-create ownership record is not a bounded regular file: ${pathname}`);
  }
  const handle = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'record-open', () =>
        fs.promises.open(pathname, boundedRecordOpenFlags())
      )
    : await fs.promises.open(pathname, boundedRecordOpenFlags());
  let timer: NodeJS.Timeout | undefined;
  let closeAfterPendingOperation = false;
  try {
    const opened = budget
      ? await withinAtomicCreateRecoveryBudget(
          budget,
          'record-fstat',
          () => handle.stat(),
          (pending) => {
            closeAfterPendingOperation = true;
            void pending.catch(() => undefined).then(() => handle.close().catch(() => undefined));
          }
        )
      : await handle.stat();
    if (
      !opened.isFile() ||
      !isSameDurableFileIdentity(
        getDurableFileIdentity(beforeOpen),
        getDurableFileIdentity(opened)
      ) ||
      !Number.isSafeInteger(opened.size) ||
      opened.size < 0 ||
      opened.size > maxBytes
    ) {
      throw new Error(`Atomic-create ownership record changed: ${pathname}`);
    }
    // The descriptor read consumes the remainder of this pass, not a fresh
    // one-second allowance. Check the allowance before starting the syscall:
    // starting a read first can leave close waiting on work that was already
    // unauthorized by an expired pass. Its catch path below still drains
    // before close.
    const readTimeoutMs = budget ? remainingBudgetMs(budget, 'record-read') : 1_000;
    const bytes = Buffer.alloc(maxBytes + 1);
    const read = handle.read(bytes, 0, bytes.length, 0);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`Atomic-create ownership record read timed out: ${pathname}`)),
        readTimeoutMs
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
      closeAfterPendingOperation = true;
      void read.catch(() => undefined).then(() => handle.close().catch(() => undefined));
      throw error;
    }
    if (bytesRead > maxBytes) {
      throw new Error(`Atomic-create ownership record exceeds ${maxBytes} bytes: ${pathname}`);
    }
    return {
      text: bytes.subarray(0, bytesRead).toString('utf8'),
      identity: getDurableFileIdentity(opened),
    };
  } finally {
    if (timer) clearTimeout(timer);
    if (!closeAfterPendingOperation) await closeWithinRecoveryBudget(handle, budget);
  }
}

/** Read bytes and identity from one authenticated descriptor generation. */
export async function readBoundedRegularText(
  pathname: string,
  maxBytes: number,
  budget?: AtomicCreateRecoveryBudget
): Promise<string> {
  return (await readBoundedRegularTextWithIdentity(pathname, maxBytes, budget)).text;
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

export async function syncRecoveryDirectory(
  directoryPath: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  try {
    await syncPath(directoryPath, directoryOpenFlags(), budget);
  } catch (error) {
    if (!isUnsupportedDirectorySync(error)) throw error;
  }
}

export async function syncRecoveryRecord(
  recordPath: string,
  cleanupDirectory: string,
  parentDirectory: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  await syncPath(recordPath, noFollowReadFlags(), budget);
  await syncRecoveryDirectory(cleanupDirectory, budget);
  await syncRecoveryDirectory(parentDirectory, budget);
}

export async function boundedMatchingEntries(
  directoryPath: string,
  pattern: RegExp,
  limit: number,
  kind: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<string[]> {
  const directory = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'directory-open', () =>
        fs.promises.opendir(directoryPath)
      )
    : await fs.promises.opendir(directoryPath);
  const entries: string[] = [];
  let closeAfterPendingRead = false;
  try {
    while (true) {
      const entry = budget
        ? await withinAtomicCreateRecoveryBudget(
            budget,
            'directory-read',
            () => directory.read(),
            (pending) => {
              closeAfterPendingRead = true;
              void pending
                .catch(() => undefined)
                .then(() => directory.close().catch(() => undefined));
            }
          )
        : await directory.read();
      if (!entry) break;
      if (!pattern.test(entry.name)) continue;
      if (entries.length >= limit) {
        throw new Error(`Atomic-create ${kind} retention limit (${limit}) exceeded`);
      }
      entries.push(entry.name);
    }
  } finally {
    if (!closeAfterPendingRead) await closeWithinRecoveryBudget(directory, budget);
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
  attachmentIdentity: DurableFileIdentity,
  budget?: AtomicCreateRecoveryBudget
): Promise<{
  record: AtomicCreateRecoveryRecord;
  recordPath: string;
  directoryHandle: fs.promises.FileHandle;
  stableDirectory: string;
}> {
  // The directory allocator cannot reserve capacity across a late create.
  // Do not let a direct adapter publish a record outside that reservation.
  if (!safeRecoveryRecordReservationAvailable()) {
    throw new Error('Atomic-create recovery record requires operator reconciliation');
  }
  const { directoryHandle, stablePath: stableDirectory } = allocatedDirectory;
  let retained = false;
  let closeAfterPendingStat = false;
  let closeAfterPendingRecordOperation = false;
  try {
    const directoryStats = budget
      ? await withinAtomicCreateRecoveryBudget(
          budget,
          'recovery-record-directory-fstat',
          () => directoryHandle.stat(),
          (pending) => {
            closeAfterPendingStat = true;
            void pending
              .catch(() => undefined)
              .then(() => directoryHandle.close().catch(() => undefined));
          }
        )
      : await directoryHandle.stat();
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
    const recordHandle = budget
      ? await withinAtomicCreateRecoveryOpenBudget(budget, 'recovery-record-create', () =>
          fs.promises.open(recordPath, 'wx', 0o600)
        )
      : await fs.promises.open(recordPath, 'wx', 0o600);
    try {
      const recordIo = (operation: string, work: () => Promise<void>): Promise<void> =>
        budget
          ? withinAtomicCreateRecoveryBudget(budget, operation, work, (pending) => {
              closeAfterPendingRecordOperation = true;
              void pending
                .catch(() => undefined)
                .then(() => recordHandle.close().catch(() => undefined))
                .then(() => directoryHandle.close().catch(() => undefined));
            })
          : work();
      await recordIo('recovery-record-write', () =>
        recordHandle.writeFile(JSON.stringify(record), 'utf8')
      );
      await recordIo('recovery-record-fsync', () => recordHandle.sync());
    } finally {
      if (!closeAfterPendingRecordOperation) await closeWithinRecoveryBudget(recordHandle, budget);
    }
    await syncRecoveryRecord(recordPath, stableDirectory, parentDirectory, budget);
    retained = true;
    return { record, recordPath, directoryHandle, stableDirectory };
  } finally {
    if (!retained && !closeAfterPendingStat && !closeAfterPendingRecordOperation) {
      await closeWithinRecoveryBudget(directoryHandle, budget);
    }
  }
}

function safeRecoveryRecordReservationAvailable(): boolean {
  return false;
}
