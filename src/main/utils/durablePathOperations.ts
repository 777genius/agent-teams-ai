import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

export * from './durablePathIdentity';

import {
  hasStrictIdentityStableDirectorySupport,
  removeDirectoryEntriesExceptBestEffortAsync,
  withBestEffortDirectoryTreeAsync,
} from './bestEffortDurableDirectory';
import {
  reconcileDetachedRemovalPublicReservation,
  resumeDeterministicDetachedRemoval,
} from './durableDetachedRemoval';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

import type { AtomicCreateResult } from './atomicCreateTypes';

export type AtomicPathRemovalResult = 'deleted' | 'missing' | 'changed';
export type DurableDirectoryEntryCleanupResult = 'cleaned' | 'missing' | 'validation_failed';
export type IdentityStableDirectoryAccessResult<T> =
  | { state: 'opened'; value: T }
  | { state: 'missing' };

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

/**
 * Walk a directory path one component at a time from an already opened
 * directory. Every caller-controlled component is opened with O_NOFOLLOW, so
 * neither a pre-existing symlink nor an ancestor replacement can redirect
 * operations which use the returned /proc/self/fd path.
 */
export async function withIdentityStableDirectoryPathAsync<T>(
  directoryPath: string,
  operation: (stableDirectoryPath: string, directoryHandle: fs.promises.FileHandle) => Promise<T>,
  options: {
    create?: boolean;
    durability?: 'best-effort' | 'strict';
    errorPath?: string;
  } = {}
): Promise<IdentityStableDirectoryAccessResult<T>> {
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
      await directoryHandle.close();
      directoryHandle = childHandle;
    }
    const directoryStats = await directoryHandle.stat();
    const stableDirectoryPath = getIdentityStableDirectoryPath(directoryHandle);
    if (!directoryStats.isDirectory() || stableDirectoryPath === null) {
      return await refuseChangedIdentity();
    }
    const stableStats = await fs.promises.stat(stableDirectoryPath);
    if (
      !stableStats.isDirectory() ||
      !isSameDurablePathIdentity(
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
            !isSameDurablePathIdentity(getDurablePathIdentity(pathStats), retained.identity) ||
            !isSameDurablePathIdentity(getDurablePathIdentity(handleStats), retained.identity) ||
            pathStats.birthtimeMs !== retained.birthtimeMs ||
            handleStats.birthtimeMs !== retained.birthtimeMs
          ) {
            throw new Error(`Retained directory entry identity changed: ${retainedPath}`);
          }
        }
      };

      try {
        // Bind every retained pathname to an opened regular file before any
        // transient entry is removed. O_NONBLOCK keeps a FIFO substitution from
        // occupying a libuv worker while the fstat type check rejects it.
        for (const entry of entries) {
          if (!retainedEntryNames.has(entry.name)) continue;
          const retainedPath = path.join(stableDirectoryPath, entry.name);
          let retainedHandle: fs.promises.FileHandle;
          try {
            retainedHandle = await fs.promises.open(
              retainedPath,
              fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
            );
          } catch {
            throw new Error(`Retained directory entry is not a regular file: ${retainedPath}`);
          }
          const stats = await retainedHandle.stat();
          if (!stats.isFile()) {
            await retainedHandle.close().catch(() => undefined);
            throw new Error(`Retained directory entry is not a regular file: ${retainedPath}`);
          }
          retainedHandles.push({
            name: entry.name,
            identity: getDurablePathIdentity(stats),
            birthtimeMs: stats.birthtimeMs,
            handle: retainedHandle,
          });
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
            // Node has no identity-checked recursive child-removal primitive.
            throw new Error(`Durable directory identity changed during cleanup: ${displayPath}`);
          }
        }
        for (const entry of entries) {
          if (retainedEntryNames.has(entry.name)) continue;
          // This path stays anchored to the already validated directory handle.
          // unlink removes a substituted symlink without traversing it and
          // refuses a substituted directory.
          try {
            await fs.promises.unlink(path.join(stableDirectoryPath, entry.name));
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
  if (access.state === 'missing') {
    return 'missing';
  }
  return access.value;
}

export interface DurablePathRemovalProofHooks {
  /**
   * Stable, transaction-owned sibling path used to resume an exact detached
   * removal after a process restart.
   */
  detachedPath: string;
  onDetachedValidated: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
  onRemovalDurable: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
}

function getIdentityStableDirectoryPath(handle: fs.promises.FileHandle): string | null {
  if (process.platform !== 'linux') return null;
  return `/proc/self/fd/${handle.fd}`;
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

async function syncDirectory(dirPath: string, strict: boolean): Promise<void> {
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
        isSameDurablePathIdentity(getDurablePathIdentity(detachedStats), expected.identity) &&
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
    return {
      dev: stagedStats.dev,
      ino: stagedStats.ino,
      birthtimeMs: stagedStats.birthtimeMs,
      size: stagedStats.size,
    };
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
export async function removePathWithIdentityFenceAsync(
  targetPath: string,
  options: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    validateDetached?: (detachedPath: string, identity: DurablePathIdentity) => Promise<boolean>;
    durability?: 'best-effort' | 'strict';
    /**
     * Route writes which still use the public directory name into a durable
     * reservation while the detached object is validated and removed.
     */
    reservePublicDirectory?: boolean;
    proofHooks?: DurablePathRemovalProofHooks;
  } = {}
): Promise<AtomicPathRemovalResult> {
  const dir = path.dirname(targetPath);
  const detachedPath =
    options.proofHooks?.detachedPath ??
    path.join(dir, `.${path.basename(targetPath)}.deleting.${randomUUID()}`);
  const removalOptions = {
    ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
  };
  let detached = false;
  let publicReservationPath: string | null = null;
  let publicReservationPublished = false;
  let publicReservationIdentity: DurablePathIdentity | null = null;

  const copyReservationEntriesNoClobber = async (
    sourceDirectory: string,
    destinationDirectory: string
  ): Promise<void> => {
    const entries = await fs.promises.readdir(sourceDirectory, { withFileTypes: true });
    for (const entry of entries) {
      const sourcePath = path.join(sourceDirectory, entry.name);
      const destinationPath = path.join(destinationDirectory, entry.name);
      if (entry.isDirectory()) {
        try {
          await fs.promises.mkdir(destinationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          const destinationStats = await fs.promises.lstat(destinationPath);
          if (!destinationStats.isDirectory() || destinationStats.isSymbolicLink()) continue;
        }
        await copyReservationEntriesNoClobber(sourcePath, destinationPath);
        continue;
      }

      if (entry.isSymbolicLink()) {
        const linkTarget = await fs.promises.readlink(sourcePath);
        try {
          await fs.promises.symlink(linkTarget, destinationPath);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        }
        continue;
      }

      if (!entry.isFile()) continue;
      try {
        await fs.promises.link(sourcePath, destinationPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      }
    }
  };

  const settlePublicReservation = async (): Promise<void> => {
    if (!publicReservationPath) return;
    const reservationPath = publicReservationPath;

    // rmdir is deliberately non-recursive: a write racing the close turns an
    // empty reservation into ENOTEMPTY instead of being deleted.
    try {
      await fs.promises.rmdir(reservationPath);
      publicReservationPath = null;
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        publicReservationPath = null;
        return;
      }
      if (code !== 'ENOTEMPTY' && code !== 'EEXIST') throw error;
    }

    try {
      await fs.promises.mkdir(targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A new public object already won. Keep the reservation as a durable,
      // uniquely named recovery copy rather than touching that replacement.
      return;
    }

    // The public directory was claimed with mkdir (no clobber). Publish every
    // captured entry with no-clobber links/directories; never unlink the
    // reservation copy because another writer may still hold it open.
    await copyReservationEntriesNoClobber(reservationPath, targetPath);
    await syncDirectory(targetPath, options.durability === 'strict');
  };

  const closePublicReservation = async (): Promise<void> => {
    if (publicReservationPublished && publicReservationIdentity) {
      const expectedReservationIdentity = publicReservationIdentity;
      // Detach first, then validate and remove the uniquely named detached
      // symlink. A replacement published at the public name before cleanup is
      // restored unchanged; one published during validation is never targeted.
      await removePathWithIdentityFenceAsync(targetPath, {
        ...removalOptions,
        durability: options.durability,
        validateDetached: async (reservationDetachedPath, identity) => {
          if (
            !isSameDurablePathIdentity(identity, expectedReservationIdentity) ||
            identity.birthtimeMs !== expectedReservationIdentity.birthtimeMs
          ) {
            return false;
          }
          const detachedStats = await fs.promises.lstat(reservationDetachedPath);
          return detachedStats.isSymbolicLink();
        },
      });
      publicReservationPublished = false;
      publicReservationIdentity = null;
    }
    await settlePublicReservation();
  };

  const restoreDetached = async (): Promise<boolean> => {
    try {
      await fs.promises.lstat(targetPath);
      return false;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    try {
      await fs.promises.rename(detachedPath, targetPath);
      detached = false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  const resumeProofBackedRemoval = async (): Promise<AtomicPathRemovalResult> => {
    if (!options.proofHooks) return 'missing';
    if (options.reservePublicDirectory) {
      // A crash between reservation publish and close leaves a dangling
      // junction at the public name; free or settle it before resuming.
      await reconcileDetachedRemovalPublicReservation({
        targetPath,
        parentDirectory: dir,
        settleReservation: async (reservationPath) => {
          await syncDirectory(dir, options.durability === 'strict');
          publicReservationPath = reservationPath;
          await settlePublicReservation();
        },
      });
    }
    return resumeDeterministicDetachedRemoval({
      detachedPath,
      removalOptions,
      validateDetached: options.validateDetached,
      proofHooks: options.proofHooks,
      syncParentDirectory: () => syncDirectory(dir, options.durability === 'strict'),
    });
  };

  try {
    if (options.proofHooks) {
      const resumed = await resumeProofBackedRemoval();
      if (resumed !== 'missing') return resumed;
    }

    try {
      await fs.promises.rename(targetPath, detachedPath);
      detached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return resumeProofBackedRemoval();
      }
      throw error;
    }

    const stats = await fs.promises.lstat(detachedPath);
    const identity = getDurablePathIdentity(stats);
    if (options.reservePublicDirectory && stats.isDirectory()) {
      publicReservationPath = path.join(
        dir,
        `.${path.basename(targetPath)}.replacement.${randomUUID()}`
      );
      await fs.promises.mkdir(publicReservationPath);
      try {
        await fs.promises.symlink(publicReservationPath, targetPath, 'junction');
        publicReservationIdentity = getDurablePathIdentity(await fs.promises.lstat(targetPath));
        publicReservationPublished = true;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
        await settlePublicReservation();
      }
    }

    if (options.validateDetached && !(await options.validateDetached(detachedPath, identity))) {
      await closePublicReservation();
      await restoreDetached();
      return 'changed';
    }

    await closePublicReservation();
    await options.proofHooks?.onDetachedValidated(detachedPath, identity);
    await fs.promises.rm(detachedPath, removalOptions);
    detached = false;
    await syncDirectory(dir, options.durability === 'strict');
    await options.proofHooks?.onRemovalDurable(detachedPath, identity);
    return 'deleted';
  } catch (error) {
    await closePublicReservation().catch(() => undefined);
    if (detached) await restoreDetached().catch(() => undefined);
    throw error;
  }
}
