import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { assertNoAmbiguousDetachedReservation } from './durableDetachedRemoval';
import { RENAME_TREE_RETRY, retryOnTransientFsError } from './transientFsRetry';

export * from './durablePathIdentity';

import {
  hasStrictIdentityStableDirectorySupport,
  removeDirectoryEntriesExceptBestEffortAsync,
  withBestEffortDirectoryTreeAsync,
} from './bestEffortDurableDirectory';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

import type { AtomicCreateResult } from './atomicWrite';

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
  const refuseChangedIdentity = async (reason?: Error): Promise<never> => {
    await directoryHandle.close().catch(() => undefined);
    throw reason ?? new Error(`Durable directory identity changed during cleanup: ${errorPath}`);
  };
  try {
    for (const [index, component] of components.entries()) {
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
          return await refuseChangedIdentity(
            await describeDirectoryComponentOpenFailure(error, {
              childPath,
              displayComponent: stableDescriptorMatch
                ? component
                : path.join(initialPath, ...components.slice(0, index + 1)),
              errorPath,
            })
          );
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

// Diagnostics only: the caller refuses the path either way. Symlinked or
// unreadable ancestors are configuration problems, not races, so name them.
async function describeDirectoryComponentOpenFailure(
  error: unknown,
  input: { childPath: string; displayComponent: string; errorPath: string }
): Promise<Error | undefined> {
  const code = (error as NodeJS.ErrnoException).code;
  if (code === 'EACCES' || code === 'EPERM') {
    return new Error(
      `Durable directory path component is not readable for identity verification: ${input.displayComponent} (in ${input.errorPath}); strict identity checks require read and search access to every ancestor`,
      { cause: error }
    );
  }
  // Linux can report O_DIRECTORY|O_NOFOLLOW on a symlink as ENOTDIR rather than ELOOP.
  const isSymbolicLink =
    code === 'ELOOP' ||
    (await fs.promises.lstat(input.childPath).then(
      (stats) => stats.isSymbolicLink(),
      () => false
    ));
  if (!isSymbolicLink) return undefined;
  return new Error(
    `Durable directory path contains a symbolic link component: ${input.displayComponent} (in ${input.errorPath}); use a real directory path without symlinks`,
    { cause: error }
  );
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
            throw new Error(`Durable directory identity changed during cleanup: ${displayPath}`);
          }
        }
        for (const entry of entries) {
          if (retainedEntryNames.has(entry.name)) continue;
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
  return access.state === 'missing' ? 'missing' : access.value;
}

// The identity fence renames a whole directory tree aside and, on failure,
// renames it back. On Windows either rename can be refused for as long as some
// other process still holds a handle anywhere inside that tree.
function renameWithTransientRetry(src: string, dest: string): Promise<void> {
  return retryOnTransientFsError(() => fs.promises.rename(src, dest), RENAME_TREE_RETRY);
}

export interface DurablePathRemovalProofHooks {
  /**
   * Stable, transaction-owned sibling path used to resume an exact detached
   * removal after a process restart.
   */
  detachedPath: string;
  assertWriterAdmission?: () => Promise<void>;
  onRemovalPrepared?: (targetPath: string, identity: DurablePathIdentity) => Promise<void>;
  onDetachedValidated: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
  onRemovalDurable: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
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
export async function removePathWithIdentityFenceAsync(
  targetPath: string,
  options: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
    validateDetached?: (detachedPath: string, identity: DurablePathIdentity) => Promise<boolean>;
    durability?: 'best-effort' | 'strict';
    /** Permanent deletion requires a cooperative writer fence and durable intent. */
    reservePublicDirectory?: boolean;
    proofHooks?: DurablePathRemovalProofHooks;
  } = {}
): Promise<AtomicPathRemovalResult> {
  const protectedRemoval = options.reservePublicDirectory === true;
  const proof = options.proofHooks;
  if (protectedRemoval && (!proof?.assertWriterAdmission || !proof.onRemovalPrepared)) {
    throw new Error('operator_required: permanent deletion writer admission is unavailable');
  }
  const dir = path.dirname(targetPath);
  const detachedPath =
    proof?.detachedPath ?? path.join(dir, `.${path.basename(targetPath)}.deleting.${randomUUID()}`);
  const removalOptions = {
    ...(options.recursive === undefined ? {} : { recursive: options.recursive }),
    ...(options.force === undefined ? {} : { force: options.force }),
    ...(options.maxRetries === undefined ? {} : { maxRetries: options.maxRetries }),
    ...(options.retryDelay === undefined ? {} : { retryDelay: options.retryDelay }),
  };
  if (protectedRemoval) {
    await proof!.assertWriterAdmission!();
    await assertNoAmbiguousDetachedReservation(targetPath);
    // No identity-bound recursive remover is available. Fail before the public
    // path is detached so an ordinary deletion cannot hide the team in quarantine.
    let hasDetachedTarget = false;
    try {
      await fs.promises.lstat(detachedPath);
      hasDetachedTarget = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    if (!hasDetachedTarget) {
      try {
        await fs.promises.lstat(targetPath);
        throw new Error(
          `operator_required: identity-bound quarantine removal is unavailable: ${targetPath}`
        );
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        return 'missing';
      }
    }
  }

  let detachedStats: fs.Stats;
  if (!protectedRemoval && !proof) {
    // Keep the legacy one-rename path for ordinary short-lived removals.
    // The transaction contract below applies only to proof-backed cleanup.
    try {
      await renameWithTransientRetry(targetPath, detachedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
      throw error;
    }
    detachedStats = await fs.promises.lstat(detachedPath);
  } else
    try {
      detachedStats = await fs.promises.lstat(detachedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      let publicStats: fs.Stats;
      try {
        publicStats = await fs.promises.lstat(targetPath);
      } catch (publicError) {
        if ((publicError as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw publicError;
      }
      const expected = getDurablePathIdentity(publicStats);
      if (
        protectedRemoval &&
        options.validateDetached &&
        !(await options.validateDetached(targetPath, expected))
      ) {
        return 'changed';
      }
      // The durable receipt binds the public identity and quarantine name before
      // the first rename. A restart may resume only this exact generation.
      await proof?.onRemovalPrepared?.(targetPath, expected);
      if (protectedRemoval) await proof!.assertWriterAdmission!();
      try {
        await renameWithTransientRetry(targetPath, detachedPath);
      } catch (renameError) {
        // Some filesystems can report ENOENT after the rename took effect.
        // The exact detached identity is still the only admissible result.
        if ((renameError as NodeJS.ErrnoException).code !== 'ENOENT') throw renameError;
      }
      await syncDirectory(dir, options.durability === 'strict');
      try {
        detachedStats = await fs.promises.lstat(detachedPath);
      } catch (detachedError) {
        if ((detachedError as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
        throw detachedError;
      }
      const observed = getDurablePathIdentity(detachedStats);
      if (
        !isSameDurablePathIdentity(expected, observed) ||
        expected.birthtimeMs !== observed.birthtimeMs
      ) {
        throw new Error(`operator_required: detached target identity changed at ${detachedPath}`);
      }
    }

  const identity = getDurablePathIdentity(detachedStats);
  const restoreDetachedFileNoClobber = async (): Promise<void> => {
    if (protectedRemoval || (!detachedStats.isFile() && !detachedStats.isSymbolicLink())) return;
    let observed: fs.Stats;
    try {
      observed = await fs.promises.lstat(detachedPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const current = getDurablePathIdentity(observed);
    if (
      !isSameDurablePathIdentity(identity, current) ||
      identity.birthtimeMs !== current.birthtimeMs
    ) {
      return;
    }
    try {
      await fs.promises.link(detachedPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return;
      throw error;
    }
    await fs.promises.unlink(detachedPath);
    await syncDirectory(dir, options.durability === 'strict');
  };
  if (options.validateDetached && !(await options.validateDetached(detachedPath, identity))) {
    // In particular, never rename a directory back over a C that appeared at
    // the public pathname. Leave the quarantine artifact for an operator.
    await restoreDetachedFileNoClobber();
    return 'changed';
  }
  // A resumed quarantine may have been published just before the prior
  // process stopped. Make its directory entry durable before recording a
  // detached receipt, including on filesystems where rename survived a crash.
  if (proof) await syncDirectory(dir, options.durability === 'strict');
  if (protectedRemoval) await proof!.assertWriterAdmission!();
  try {
    await proof?.onDetachedValidated(detachedPath, identity);
    if (protectedRemoval) await proof!.assertWriterAdmission!();
    // Node's recursive rm accepts a pathname, not an open directory handle.
    // Another same-UID actor can exchange that pathname after any lstat and
    // make rm remove an unrelated directory. Retain the detached object and
    // its durable receipt until an identity-bound remover is available.
    if (protectedRemoval) {
      throw new Error(
        `operator_required: identity-bound quarantine removal is unavailable: ${detachedPath}`
      );
    }
    const beforeRemove = await fs.promises.lstat(detachedPath);
    const current = getDurablePathIdentity(beforeRemove);
    if (
      !isSameDurablePathIdentity(identity, current) ||
      identity.birthtimeMs !== current.birthtimeMs
    ) {
      throw new Error(`operator_required: detached target identity changed at ${detachedPath}`);
    }
    await fs.promises.rm(detachedPath, removalOptions);
  } catch (error) {
    await restoreDetachedFileNoClobber().catch(() => undefined);
    throw error;
  }
  await syncDirectory(dir, options.durability === 'strict');
  // Only this explicit durable receipt can advance coordinator completion.
  await proof?.onRemovalDurable(detachedPath, identity);
  return 'deleted';
}
