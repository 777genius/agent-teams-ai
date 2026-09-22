import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { RENAME_TREE_RETRY, retryOnTransientFsError } from './transientFsRetry';
export { readBoundedFileHandleUtf8Async } from './durableBoundedFileRead';
export * from './durablePathIdentity';
export {
  assertDurablePathComponentBudget,
  durablePathComponent,
  durablePathComponentWithBudget,
  MAX_DURABLE_PATH_COMPONENT_BYTES,
} from './durablePathComponent';
import { durablePathComponent } from './durablePathComponent';
import {
  hasStrictIdentityStableDirectorySupport,
  removeDirectoryEntriesExceptBestEffortAsync,
  withBestEffortDirectoryTreeAsync,
} from './bestEffortDurableDirectory';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
} from './durablePathIdentity';
import { withDurableReservationRecordLock } from './durableReservationRecordLock';
import type { AtomicCreateResult } from './atomicWrite';
export type AtomicPathRemovalResult = 'deleted' | 'missing' | 'changed';
export type DurableDirectoryEntryCleanupResult = 'cleaned' | 'missing' | 'validation_failed';
export type IdentityStableDirectoryAccessResult<T> =
  | { state: 'opened'; value: T }
  | { state: 'missing' };

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

export function hasTrustworthyDurableFilesystemIdentity(
  identity: Pick<DurablePathIdentity, 'dev' | 'ino'>
): boolean {
  return (
    Number.isSafeInteger(identity.dev) && identity.dev > 0 &&
    Number.isSafeInteger(identity.ino) && identity.ino > 0
  );
}
export function isSameTrustedDurableFilesystemIdentity(
  left: Pick<DurablePathIdentity, 'dev' | 'ino'>,
  right: Pick<DurablePathIdentity, 'dev' | 'ino'>
): boolean {
  return (
    hasTrustworthyDurableFilesystemIdentity(left) &&
    hasTrustworthyDurableFilesystemIdentity(right) &&
    left.dev === right.dev &&
    left.ino === right.ino
  );
}

/**
 * Remove a private scratch name only while it still resolves to the exact
 * generation created by this transaction.  Cleanup must never turn a late
 * replacement of a `.tmp`, `.claim`, or `.recovery` spelling into data loss.
 */
async function removeDurablePathIfIdentityMatchesAsync(
  pathname: string,
  expectedIdentity: DurablePathIdentity,
  remove: (pathname: string) => Promise<void>
): Promise<boolean> {
  const access = await withIdentityStableDirectoryPathAsync(
    path.dirname(pathname),
    async (stableParentPath) => {
      const descriptorBoundPath = path.join(stableParentPath, path.basename(pathname));
      try {
        const stats = await fs.promises.lstat(descriptorBoundPath);
        if (
          !isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(stats), expectedIdentity) ||
          stats.birthtimeMs !== expectedIdentity.birthtimeMs
        ) return false;
        await remove(descriptorBoundPath);
        return true;
      } catch (error) {
        if (isMissing(error)) return false;
        throw error;
      }
    },
    { errorPath: pathname }
  );
  return access.state === 'opened' && access.value;
}
export async function unlinkDurablePathIfIdentityMatchesAsync(
  pathname: string,
  expectedIdentity: DurablePathIdentity
): Promise<boolean> {
  return removeDurablePathIfIdentityMatchesAsync(pathname, expectedIdentity, (candidate) =>
    fs.promises.unlink(candidate)
  );
}
export async function rmdirDurablePathIfIdentityMatchesAsync(
  pathname: string,
  expectedIdentity: DurablePathIdentity
): Promise<boolean> {
  return removeDurablePathIfIdentityMatchesAsync(pathname, expectedIdentity, (candidate) =>
    fs.promises.rmdir(candidate)
  );
}
export async function durablePathExistsAsync(
  targetPath: string,
  options: { rejectSymbolicLink?: boolean } = {}
): Promise<boolean> {
  try {
    const stats = options.rejectSymbolicLink
      ? await fs.promises.lstat(targetPath)
      : await fs.promises.stat(targetPath);
    if (options.rejectSymbolicLink && stats.isSymbolicLink()) {
      throw new Error(`Durable path is a symbolic link: ${targetPath}`);
    }
    return true;
  } catch (error) {
    if (options.rejectSymbolicLink && (error as NodeJS.ErrnoException).code !== 'ENOENT') {
      throw error;
    }
    return false;
  }
}
export function assertIdentityStableDirectoryChildOperationsSupported(): void {
  if (
    process.platform !== 'linux' ||
    typeof fs.constants.O_DIRECTORY !== 'number' ||
    typeof fs.constants.O_NOFOLLOW !== 'number'
  ) {
    throw new Error(
      `Identity-stable directory child operations are unsupported on ${process.platform}`
    );
  }
}

async function withPortableIdentityCheckedDirectoryPathAsync<T>(
  directoryPath: string,
  operation: (directoryPath: string, directoryHandle: fs.promises.FileHandle) => Promise<T>,
  options: {
    create?: boolean;
    errorPath: string;
    expectedIdentity?: DurablePathIdentity;
  }
): Promise<IdentityStableDirectoryAccessResult<T>> {
  const verify = (stats: fs.Stats, expected?: DurablePathIdentity): void => {
    if (
      !stats.isDirectory() ||
      stats.isSymbolicLink() ||
      (expected !== undefined &&
        (!isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(stats), expected) ||
          stats.birthtimeMs !== expected.birthtimeMs))
    ) {
      throw new Error(`Durable directory identity changed during cleanup: ${options.errorPath}`);
    }
  };
  let handle: fs.promises.FileHandle | null = null;
  try {
    let initial: fs.Stats;
    try {
      initial = await fs.promises.lstat(directoryPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT' && !options.create) {
        return { state: 'missing' };
      }
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        await fs.promises.mkdir(directoryPath, { recursive: true });
        initial = await fs.promises.lstat(directoryPath);
      } else {
        throw error;
      }
    }
    verify(initial, options.expectedIdentity);
    try {
      handle = await fs.promises.open(
        directoryPath,
        fs.constants.O_RDONLY | fs.constants.O_NONBLOCK
      );
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Windows does not consistently permit a directory handle through the
      // Node open API. Its lstat identity is still a no-follow final-component
      // fence for this best-effort portable path.
      if (process.platform !== 'win32' || (code !== 'EACCES' && code !== 'EPERM' && code !== 'EISDIR')) {
        throw error;
      }
    }
    const opened = handle ? await handle.stat() : await fs.promises.lstat(directoryPath);
    verify(opened, getDurablePathIdentity(initial));
    const beforeOperation = await fs.promises.lstat(directoryPath);
    verify(beforeOperation, getDurablePathIdentity(opened));
    const value = await operation(directoryPath, handle as fs.promises.FileHandle);
    const afterOperation = await fs.promises.lstat(directoryPath);
    verify(afterOperation, getDurablePathIdentity(opened));
    return { state: 'opened', value };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
export async function withIdentityStableDirectoryPathAsync<T>(
  directoryPath: string,
  operation: (stableDirectoryPath: string, directoryHandle: fs.promises.FileHandle) => Promise<T>,
  options: {
    create?: boolean;
    durability?: 'best-effort' | 'strict';
    errorPath?: string;
    /** Refuse a same-name replacement even if it is also a directory. */
    expectedIdentity?: DurablePathIdentity;
  } = {}
): Promise<IdentityStableDirectoryAccessResult<T>> {
  if (!hasStrictIdentityStableDirectorySupport()) {
    // APFS and NTFS do not expose Linux's /proc/self/fd pathname bridge to
    // Node. Keep rollback usable there by binding every portable operation to
    // an opened directory identity and rejecting any final-component symlink
    // replacement before or after the operation; never canonicalize through
    // (and therefore follow) a replacement public symlink.
    return withPortableIdentityCheckedDirectoryPathAsync(directoryPath, operation, {
      create: options.create,
      errorPath: options.errorPath ?? directoryPath,
      expectedIdentity: options.expectedIdentity,
    });
  }
  assertIdentityStableDirectoryChildOperationsSupported();
  const strict = options.durability !== 'best-effort';
  const errorPath = options.errorPath ?? directoryPath;
  const stableDescriptorMatch = /^\/proc\/self\/fd\/(\d+)(?:\/(.*))?$/.exec(directoryPath);
  const components = stableDescriptorMatch
    ? (stableDescriptorMatch[2] ?? '').split(path.sep).filter(Boolean)
    : path.resolve(directoryPath).split(path.sep).filter(Boolean);
  const initialPath = stableDescriptorMatch
    ? `/proc/self/fd/${stableDescriptorMatch[1]}`
    : path.parse(path.resolve(directoryPath)).root;
  let directoryHandle: fs.promises.FileHandle;
  try {
    directoryHandle = await fs.promises.open(
      initialPath,
      fs.constants.O_RDONLY |
        fs.constants.O_DIRECTORY |
        (stableDescriptorMatch ? 0 : fs.constants.O_NOFOLLOW)
    );
  } catch {
    throw new Error(`Durable directory identity changed during cleanup: ${errorPath}`);
  }
  const refuseChangedIdentity = async (): Promise<never> => {
    await directoryHandle.close().catch(() => undefined);
    throw new Error(`Durable directory identity changed during cleanup: ${errorPath}`);
  };
  try {
    for (const component of components) {
      const stableParentPath = getIdentityStableDirectoryPath(directoryHandle);
      if (stableParentPath === null) return await refuseChangedIdentity();
      const childPath = path.join(stableParentPath, component);
      let childHandle: fs.promises.FileHandle;
      try {
        childHandle = await fs.promises.open(
          childPath,
          fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
          return await refuseChangedIdentity();
        }
        if (!options.create) {
          await directoryHandle.close();
          return { state: 'missing' };
        }
        try {
          await fs.promises.mkdir(childPath);
          await syncDirectoryHandle(directoryHandle, strict);
          childHandle = await fs.promises.open(
            childPath,
            fs.constants.O_RDONLY | fs.constants.O_DIRECTORY | fs.constants.O_NOFOLLOW
          );
        } catch {
          return await refuseChangedIdentity();
        }
      }
      // Install the child handle before closing its ancestor.  `close()` can
      // itself fail (including under injected I/O failures); assigning after
      // that await used to leave a successfully-opened child descriptor out of
      // the outer finally.
      const parentHandle = directoryHandle;
      directoryHandle = childHandle;
      await parentHandle.close();
    }
    const directoryStats = await directoryHandle.stat();
    const stableDirectoryPath = getIdentityStableDirectoryPath(directoryHandle);
    if (!directoryStats.isDirectory() || stableDirectoryPath === null) {
      return await refuseChangedIdentity();
    }
    if (
      options.expectedIdentity &&
      (!isSameTrustedDurableFilesystemIdentity(
        getDurablePathIdentity(directoryStats),
        options.expectedIdentity
      ) || directoryStats.birthtimeMs !== options.expectedIdentity.birthtimeMs)
    ) {
      return await refuseChangedIdentity();
    }
    const stableStats = await fs.promises.stat(stableDirectoryPath);
    if (
      !stableStats.isDirectory() ||
      !isSameTrustedDurableFilesystemIdentity(
        getDurablePathIdentity(directoryStats),
        getDurablePathIdentity(stableStats)
      ) ||
      stableStats.birthtimeMs !== directoryStats.birthtimeMs
    ) {
      return await refuseChangedIdentity();
    }
    return {
      state: 'opened',
      value: await operation(stableDirectoryPath, directoryHandle),
    };
  } finally {
    await directoryHandle.close().catch(() => undefined);
  }
}
export async function withIdentityStableDirectoryTreeAsync<T>(
  rootDirectoryPath: string,
  childDirectoryName: string,
  operation: (paths: { rootDirectoryPath: string; childDirectoryPath: string }) => Promise<T>,
  options: { create?: boolean } = {}
): Promise<T> {
  if (path.basename(childDirectoryName) !== childDirectoryName) {
    throw new Error(`Invalid identity-stable child directory name: ${childDirectoryName}`);
  }
  if (!hasStrictIdentityStableDirectorySupport()) {
    return withBestEffortDirectoryTreeAsync(
      rootDirectoryPath,
      childDirectoryName,
      operation,
      options
    );
  }
  const rootAccess = await withIdentityStableDirectoryPathAsync(
    rootDirectoryPath,
    async (stableRootDirectoryPath) => {
      const childAccess = await withIdentityStableDirectoryPathAsync(
        path.join(stableRootDirectoryPath, childDirectoryName),
        async (stableChildDirectoryPath) =>
          operation({
            rootDirectoryPath: stableRootDirectoryPath,
            childDirectoryPath: stableChildDirectoryPath,
          }),
        options
      );
      if (childAccess.state === 'missing') {
        throw new Error(`Identity-stable child directory is missing: ${childDirectoryName}`);
      }
      return childAccess.value;
    },
    options
  );
  if (rootAccess.state === 'missing') {
    throw new Error(`Identity-stable root directory is missing: ${rootDirectoryPath}`);
  }
  return rootAccess.value;
}
export async function withIdentityStableIndexedDirectoryLocksAsync<T>(
  input: {
    rootDirectoryPath: string;
    containerDirectoryName: string;
    targetDirectoryName: string;
    indexFileName: string;
    lifecycleLockName: string;
    acquireLifecycleLock: boolean;
    stableContainerDirectoryPath?: string;
  },
  withLock: (lockPath: string, operation: () => Promise<T>) => Promise<T>,
  operation: (paths: { targetDirectoryPath: string; indexPath: string }) => Promise<T>
): Promise<T> {
  for (const entryName of [
    input.targetDirectoryName,
    input.indexFileName,
    input.lifecycleLockName,
  ]) {
    if (path.basename(entryName) !== entryName) {
      throw new Error(`Invalid identity-stable directory entry name: ${entryName}`);
    }
  }
  const runWithLocks = (rootDirectoryPath: string, childDirectoryPath: string) => {
    const runWithIndexLock = () =>
      withLock(path.join(rootDirectoryPath, input.indexFileName), () =>
        operation({
          targetDirectoryPath: path.join(childDirectoryPath, input.targetDirectoryName),
          indexPath: path.join(rootDirectoryPath, input.indexFileName),
        })
      );
    return input.acquireLifecycleLock
      ? withLock(path.join(childDirectoryPath, input.lifecycleLockName), runWithIndexLock)
      : runWithIndexLock();
  };
  if (input.stableContainerDirectoryPath) {
    return runWithLocks(input.rootDirectoryPath, input.stableContainerDirectoryPath);
  }
  return withIdentityStableDirectoryTreeAsync(
    input.rootDirectoryPath,
    input.containerDirectoryName,
    (paths) => runWithLocks(paths.rootDirectoryPath, paths.childDirectoryPath),
    { create: true }
  );
}
export {
  readJsonDataEnvelopeNoFollowAsync,
  readOptionalJsonNoFollowAsync,
  readRegularFileNoFollowBestEffortAsync as readRegularFileNoFollowAsync,
} from './bestEffortDurableDirectory';
export async function removeDirectoryEntriesExceptAsync(
  directoryPath: string,
  retainedEntryNames: ReadonlySet<string>,
  options: {
    durability?: 'best-effort' | 'strict';
    displayPath?: string;
    validateDirectory?: (
      stableDirectoryPath: string,
      entries: ReadonlyArray<fs.Dirent>
    ) => Promise<boolean>;
  } = {}
): Promise<DurableDirectoryEntryCleanupResult> {
  if (!hasStrictIdentityStableDirectorySupport()) {
    return removeDirectoryEntriesExceptBestEffortAsync(directoryPath, retainedEntryNames, options);
  }
  const strict = options.durability !== 'best-effort';
  const displayPath = options.displayPath ?? directoryPath;
  const access = await withIdentityStableDirectoryPathAsync(
    directoryPath,
    async (stableDirectoryPath, directoryHandle) => {
      const entries = await fs.promises.readdir(stableDirectoryPath, { withFileTypes: true });
      const retainedHandles: Array<{
        name: string;
        identity: DurablePathIdentity;
        birthtimeMs: number;
        handle: fs.promises.FileHandle;
      }> = [];
      const verifyRetainedEntries = async (): Promise<void> => {
        for (const retained of retainedHandles) {
          const retainedPath = path.join(stableDirectoryPath, retained.name);
          const [pathStats, handleStats] = await Promise.all([
            fs.promises.lstat(retainedPath),
            retained.handle.stat(),
          ]);
          if (
            !pathStats.isFile() ||
            pathStats.isSymbolicLink() ||
            !handleStats.isFile() ||
            !isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(pathStats),
              retained.identity
            ) ||
            !isSameTrustedDurableFilesystemIdentity(
              getDurablePathIdentity(handleStats),
              retained.identity
            ) ||
            pathStats.birthtimeMs !== retained.birthtimeMs ||
            handleStats.birthtimeMs !== retained.birthtimeMs
          ) {
            throw new Error(`Retained directory entry identity changed: ${retainedPath}`);
          }
        }
      };

      try {
        for (const entry of entries) {
          if (!retainedEntryNames.has(entry.name)) continue;
          const retainedPath = path.join(stableDirectoryPath, entry.name);
          let retainedHandle: fs.promises.FileHandle | null = null;
          try {
            retainedHandle = await fs.promises.open(
              retainedPath,
              fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
            );
            const stats = await retainedHandle.stat();
            if (!stats.isFile()) {
              throw new Error(`Retained directory entry is not a regular file: ${retainedPath}`);
            }
            retainedHandles.push({
              name: entry.name,
              identity: getDurablePathIdentity(stats),
              birthtimeMs: stats.birthtimeMs,
              handle: retainedHandle,
            });
            retainedHandle = null;
          } catch {
            // `stat()` can fail after open.  Registering only after stat used
            // to leak that descriptor because the outer finally did not yet
            // know about it.
            await retainedHandle?.close().catch(() => undefined);
            throw new Error(`Retained directory entry is not a regular file: ${retainedPath}`);
          }
        }
        await verifyRetainedEntries();
        if (
          options.validateDirectory &&
          !(await options.validateDirectory(stableDirectoryPath, entries))
        ) {
          return 'validation_failed';
        }
        await verifyRetainedEntries();
        for (const entry of entries) {
          if (!retainedEntryNames.has(entry.name) && entry.isDirectory()) {
            throw new Error(`Durable directory identity changed during cleanup: ${displayPath}`);
          }
        }
        for (const entry of entries) {
          if (retainedEntryNames.has(entry.name)) continue;
          try {
            const entryPath = path.join(stableDirectoryPath, entry.name);
            const entryStats = await fs.promises.lstat(entryPath);
            if (!(await unlinkDurablePathIfIdentityMatchesAsync(
              entryPath,
              getDurablePathIdentity(entryStats)
            ))) return 'validation_failed';
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          }
        }
        await verifyRetainedEntries();
        await syncDirectoryHandle(directoryHandle, strict);
        return 'cleaned';
      } finally {
        await Promise.all(
          retainedHandles.map(({ handle }) => handle.close().catch(() => undefined))
        );
      }
    },
    { errorPath: displayPath }
  );
  return access.state === 'missing' ? 'missing' : access.value;
}
// The identity fence renames a whole directory tree aside and, on failure,
// renames it back. On Windows either rename can be refused for as long as some
// other process still holds a handle anywhere inside that tree.
export function renameWithTransientRetry(src: string, dest: string): Promise<void> {
  return retryOnTransientFsError(() => fs.promises.rename(src, dest), RENAME_TREE_RETRY);
}
export interface DurablePathRemovalProofHooks {
  /**
   * Stable, transaction-owned sibling path used to resume an exact detached
   * removal after a process restart.
   */
  detachedPath: string;
  onDetachedValidated: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
  /**
   * A deterministic boundary used by proof callers.  It runs after the
   * semantic validation and immediately before the final identity check which
   * guards the destructive syscall.  Production callers normally omit it;
   * tests use it to prove that a replacement at the last possible boundary is
   * left untouched.
   */
  onBeforeDestructiveMutation?: (
    detachedPath: string,
    identity: DurablePathIdentity
  ) => Promise<void>;
  onRemovalDurable: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
}

/** Re-authenticate a pathname after a proof boundary, before mutating it. */
export async function durablePathStillHasIdentityAsync(
  pathname: string,
  expectedIdentity: DurablePathIdentity
): Promise<boolean> {
  try {
    const stats = await fs.promises.lstat(pathname);
    return (
      isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(stats), expectedIdentity) &&
      stats.birthtimeMs === expectedIdentity.birthtimeMs
    );
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

function getIdentityStableDirectoryPath(handle: fs.promises.FileHandle): string | null {
  return process.platform === 'linux' ? `/proc/self/fd/${handle.fd}` : null;
}
async function syncDirectoryHandle(handle: fs.promises.FileHandle, strict: boolean): Promise<void> {
  try {
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported =
      code === 'EINVAL' ||
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF'));
    if (strict && !unsupported) throw error;
  }
}
async function syncFile(filePath: string, strict: boolean): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  let failure: unknown = null;
  try {
    handle = await fs.promises.open(filePath, 'r+');
    await handle.sync();
  } catch (error) {
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure && strict) {
    throw failure instanceof Error
      ? failure
      : new Error('Failed to synchronize file durably', { cause: failure });
  }
}
export async function syncDirectory(dirPath: string, strict: boolean): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported =
      code === 'EINVAL' ||
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF'));
    if (strict && !unsupported) {
      throw error;
    }
  } finally {
    await handle?.close();
  }
}

type OwnedCaptureMoveResult = 'moved' | 'missing' | 'occupied';

/**
 * Move into a child of a 0700, receipt-bound tombstone. The destination is
 * private to this transaction. Node does not expose renameat2(RENAME_NOREPLACE),
 * so a portable rename would silently replace an intervening destination.
 */
export async function moveToOwnedCapture(
  sourcePath: string,
  destinationPath: string
): Promise<OwnedCaptureMoveResult> {
  // `link` is the portable atomic no-replace primitive for an entry which can
  // be hard linked. Directories/junctions deliberately fail closed: treating
  // lstat(destination)+rename as a substitute would overwrite a foreign
  // arrival at the exact last-validation-to-mutation boundary.
  return withDurableReservationRecordLock(`${destinationPath}.capture`, async () => {
    let sourceStats: fs.Stats;
    try {
      sourceStats = await fs.promises.lstat(sourcePath);
    } catch (error) {
      if (isMissing(error)) return 'missing';
      throw error;
    }
    if (sourceStats.isDirectory() && !sourceStats.isSymbolicLink()) return 'occupied';
    try {
      await fs.promises.link(sourcePath, destinationPath);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'EEXIST' || code === 'ENOTEMPTY' || code === 'EPERM' || code === 'EXDEV') {
        return 'occupied';
      }
      if (isMissing(error)) return 'missing';
      throw error;
    }
    const captured = await fs.promises.lstat(destinationPath);
    if (
      !isSameTrustedDurableFilesystemIdentity(
        getDurablePathIdentity(sourceStats),
        getDurablePathIdentity(captured)
      ) || sourceStats.birthtimeMs !== captured.birthtimeMs
    ) return 'occupied';
    try {
      const confirmed = await fs.promises.lstat(sourcePath);
      if (
        !isSameTrustedDurableFilesystemIdentity(
          getDurablePathIdentity(sourceStats),
          getDurablePathIdentity(confirmed)
        ) || confirmed.birthtimeMs !== sourceStats.birthtimeMs
      ) return 'occupied';
      if (!(await unlinkDurablePathIfIdentityMatchesAsync(sourcePath, getDurablePathIdentity(sourceStats)))) {
        return 'occupied';
      }
      return 'moved';
    } catch (error) {
      if (isMissing(error)) return 'moved';
      throw error;
    }
  });
}
/**
 * Replace an existing regular file only if the inode and contents that were
 * observed by the caller are still current. The observed pathname is detached
 * before comparison, and the new file is published with a no-clobber hardlink.
 * A concurrently published replacement therefore cannot be overwritten in the
 * compare/commit gap.
 */
export async function atomicReplaceFileIfUnchangedAsync(
  targetPath: string,
  data: string | Buffer,
  expected: {
    identity: DurablePathIdentity;
    content: string | Buffer;
  },
  options: { mode?: number } = {}
): Promise<AtomicCreateResult | null> {
  const dir = path.dirname(targetPath);
  const transactionId = randomUUID();
  const stagedPath = path.join(dir, `.compare-replace.${transactionId}.tmp`);
  const detachedPath = path.join(dir, `.compare-replace.${transactionId}.before`);
  let targetDetached = false;

  const restoreDetachedNoClobber = async (): Promise<void> => {
    try {
      await fs.promises.link(detachedPath, targetPath);
      await fs.promises.unlink(detachedPath);
      targetDetached = false;
      await syncDirectory(dir, true);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // The concurrently published target wins. Retain the detached artifact
      // under its transaction name rather than destroying either version.
    }
  };

  try {
    await fs.promises.writeFile(stagedPath, data, {
      ...(typeof data === 'string' ? { encoding: 'utf8' as const } : {}),
      flag: 'wx',
      ...(options.mode === undefined ? {} : { mode: options.mode }),
    });
    await syncFile(stagedPath, true);

    try {
      await fs.promises.rename(targetPath, detachedPath);
      targetDetached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }

    const detachedHandle = await fs.promises.open(detachedPath, 'r');
    let detachedMatches = false;
    try {
      const detachedStats = await detachedHandle.stat();
      const detachedContent = await detachedHandle.readFile(
        typeof expected.content === 'string' ? 'utf8' : undefined
      );
      const contentMatches =
        typeof expected.content === 'string'
          ? detachedContent === expected.content
          : Buffer.isBuffer(detachedContent) && detachedContent.equals(expected.content);
      detachedMatches =
        detachedStats.isFile() &&
        isSameTrustedDurableFilesystemIdentity(
          getDurablePathIdentity(detachedStats),
          expected.identity
        ) &&
        contentMatches;
    } finally {
      await detachedHandle.close();
    }

    if (!detachedMatches) {
      await restoreDetachedNoClobber();
      return null;
    }

    const stagedStats = await fs.promises.lstat(stagedPath);
    try {
      await fs.promises.link(stagedPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A replacement was published after the comparison. It owns the target.
      await fs.promises.unlink(detachedPath);
      targetDetached = false;
      await syncDirectory(dir, true);
      return null;
    }
    await fs.promises.unlink(stagedPath);
    await fs.promises.unlink(detachedPath);
    targetDetached = false;
    await syncDirectory(dir, true);
    return { dev: stagedStats.dev, ino: stagedStats.ino };
  } finally {
    await fs.promises.unlink(stagedPath).catch(() => undefined);
    if (targetDetached) {
      await restoreDetachedNoClobber().catch(() => undefined);
    }
  }
}
/**
 * Atomically detach a path from its public name, validate the exact detached
 * object, and only then remove it. Anything published at the original name
 * after detachment is outside the destructive operation and survives.
 */
