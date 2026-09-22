import * as fs from 'fs';
import * as path from 'path';

import { lstatOrNull, restoreDetachedPathNoClobber } from './atomicWriteRecovery';
import {
  getDurableFileIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
} from './durablePathIdentity';

type RenameWithRetry = (src: string, dest: string) => Promise<void>;
type SyncDirectoryBestEffort = (dirPath: string) => Promise<void>;

/**
 * Removes only crash-left atomic-create temp names that still reference the
 * supplied target inode. This stays separate from the public atomic-write API
 * because the cleanup's ownership fences are intentionally self-contained.
 */
export async function cleanupAtomicCreateTempLinksRaceSafely(
  targetPath: string,
  renameWithRetry: RenameWithRetry,
  syncDirectoryBestEffort: SyncDirectoryBestEffort
): Promise<void> {
  const target = await fs.promises.lstat(targetPath);
  const targetIdentity = getDurableFileIdentity(target);
  // A zero/unknown inode is not a usable identity. Metadata and file content
  // can describe two unrelated files identically, and a path-only cleanup has
  // no transaction-owned handle with which to prove otherwise. Leaving the
  // crash guard is the only race-free, cross-platform outcome in that case.
  if (
    target.nlink <= 1 ||
    !target.isFile() ||
    target.isSymbolicLink() ||
    !hasTrustworthyDurablePathIdentity(targetIdentity)
  ) {
    return;
  }

  const dir = path.dirname(targetPath);
  const entries = await fs.promises.readdir(dir);
  for (const entry of entries) {
    if (!/^\.review-create\.[a-f0-9-]+\.tmp$/i.test(entry)) continue;
    const candidatePath = path.join(dir, entry);
    try {
      const candidate = await fs.promises.lstat(candidatePath);
      if (
        !candidate.isFile() ||
        candidate.isSymbolicLink() ||
        !isSameDurableFileIdentity(getDurableFileIdentity(candidate), targetIdentity)
      ) {
        continue;
      }

      // Never unlink the public guard name after inspecting it. A second
      // publisher can replace that name between lstat and unlink, which would
      // otherwise make this crash cleanup delete the replacement. Move the
      // candidate into a fresh, private directory first. The rename is the
      // ownership fence: a replacement published after it remains at
      // candidatePath, while the detached generation can be verified and
      // removed without targeting the public name.
      //
      // mkdtemp uses an atomic no-replace directory creation and defaults to
      // owner-only permissions. Keeping the detached file below that directory
      // also prevents this cleanup from ever overwriting another guard name.
      const cleanupDirectory = await fs.promises.mkdtemp(
        path.join(dir, '.review-create-cleanup-')
      );
      const detachedPath = path.join(cleanupDirectory, entry);
      let detached = false;
      try {
        try {
          await renameWithRetry(candidatePath, detachedPath);
          detached = true;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
          throw error;
        }

        const detachedStats = await lstatOrNull(detachedPath);
        if (
          detachedStats &&
          detachedStats.isFile() &&
          !detachedStats.isSymbolicLink() &&
          isSameDurableFileIdentity(getDurableFileIdentity(detachedStats), targetIdentity)
        ) {
          // detachedPath is an owned, unique path. Do not ever unlink
          // candidatePath here: a writer that recreated it after the rename
          // owns that replacement.
          await fs.promises.unlink(detachedPath).catch((error) => {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
          });
          detached = false;
          continue;
        }

        // Rename may have moved a replacement which won the race after the
        // first lstat. Restore it only if the public name is still vacant.
        // If another writer has already recreated candidatePath, retain the
        // detached object rather than deleting either generation.
        if (detachedStats) {
          try {
            const restored = await restoreDetachedPathNoClobber(
              detachedPath,
              candidatePath,
              syncDirectoryBestEffort
            );
            detached = !restored;
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
            // A concurrent cleaner can win after the no-clobber link but
            // before its old detached name is released. Re-check only the
            // private path; the public name is never unlinked by this flow.
            detached = (await lstatOrNull(detachedPath)) !== null;
          }
        } else {
          // Another cleaner may have removed the detached generation. Its
          // public name is still never targeted, and the now-empty private
          // directory can be discarded.
          detached = false;
        }
      } catch (error) {
        // A transient failure while deleting the privately detached guard must
        // remain retryable. Restore the exact inspected generation only if
        // the public guard name is still vacant; a replacement that won the
        // race remains untouched. Leaving the file below a random private
        // directory would make a later cleanup unable to discover it.
        if (detached) {
          try {
            const restored = await restoreDetachedPathNoClobber(
              detachedPath,
              candidatePath,
              syncDirectoryBestEffort
            );
            detached = !restored;
          } catch (restoreError) {
            if ((restoreError as NodeJS.ErrnoException).code !== 'ENOENT') throw restoreError;
            detached = (await lstatOrNull(detachedPath)) !== null;
          }
        }
        throw error;
      } finally {
        // A failed no-clobber restore intentionally leaves its detached
        // object in this uniquely-owned directory for manual/recovery-safe
        // inspection. Never recursively remove that directory.
        if (!detached) {
          await fs.promises.rmdir(cleanupDirectory).catch((error) => {
            const code = (error as NodeJS.ErrnoException).code;
            if (code !== 'ENOENT' && code !== 'ENOTEMPTY' && code !== 'EEXIST') {
              throw error;
            }
          });
        }
      }
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'ENOENT') throw error;
    }
  }
  await syncDirectoryBestEffort(dir);
}
