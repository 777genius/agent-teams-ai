import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { RENAME_TREE_RETRY, retryOnTransientFsError } from './transientFsRetry';

import type { AtomicCreateResult } from './atomicWrite';

export interface DurablePathIdentity {
  dev: number;
  ino: number;
  birthtimeMs: number;
}

export type AtomicPathRemovalResult = 'deleted' | 'missing' | 'changed';

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
  onDetachedValidated: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
  onRemovalDurable: (detachedPath: string, identity: DurablePathIdentity) => Promise<void>;
}

export function getDurablePathIdentity(
  stats: Pick<fs.Stats, 'dev' | 'ino' | 'birthtimeMs'>
): DurablePathIdentity {
  return {
    dev: stats.dev,
    ino: stats.ino,
    birthtimeMs: stats.birthtimeMs,
  };
}

export function isSameDurablePathIdentity(
  left: DurablePathIdentity,
  right: DurablePathIdentity
): boolean {
  if (left.dev !== right.dev) return false;
  if (left.ino !== 0 && right.ino !== 0) return left.ino === right.ino;
  return left.birthtimeMs === right.birthtimeMs;
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
      await renameWithTransientRetry(detachedPath, targetPath);
      detached = false;
      await syncDirectory(dir, options.durability === 'strict');
      return true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') return false;
      throw error;
    }
  };

  try {
    if (options.proofHooks) {
      let resumedStats: fs.Stats | null = null;
      try {
        resumedStats = await fs.promises.lstat(detachedPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
      if (resumedStats) {
        const resumedIdentity = getDurablePathIdentity(resumedStats);
        if (
          options.validateDetached &&
          !(await options.validateDetached(detachedPath, resumedIdentity))
        ) {
          return 'changed';
        }
        await options.proofHooks.onDetachedValidated(detachedPath, resumedIdentity);
        await fs.promises.rm(detachedPath, removalOptions);
        await syncDirectory(dir, options.durability === 'strict');
        await options.proofHooks.onRemovalDurable(detachedPath, resumedIdentity);
        return 'deleted';
      }
    }

    try {
      await renameWithTransientRetry(targetPath, detachedPath);
      detached = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 'missing';
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
