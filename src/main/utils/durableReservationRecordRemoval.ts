import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';

import {
  getDurablePathIdentity,
  readBoundedFileHandleUtf8Async,
  unlinkDurablePathIfIdentityMatchesAsync,
} from './durablePathOperationSupport';

const MAX_RECORD_BYTES = 64 * 1024;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/** Deletes only a parsed generation held by a no-replace recovery hard link. */
export async function removeExactDurableRecord(input: {
  readonly recordPaths: readonly string[];
  readonly expected: unknown;
  readonly valid: (value: unknown) => boolean;
  readonly syncParentDirectory: () => Promise<void>;
}): Promise<void> {
  let removed = false;
  for (const recordPath of input.recordPaths) {
    // Do not detach an unauthenticated record merely to discover whether it is
    // ours. In particular FIFO, directory, oversized, open, and fstat
    // failures leave the exact original entry visible at its original name.
    let preflight: fs.promises.FileHandle | null = null;
    try {
      preflight = await fs.promises.open(
        recordPath,
        fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
      );
      const stats = await preflight.stat();
      if (!stats.isFile() || stats.size > MAX_RECORD_BYTES) continue;
      const parsed = JSON.parse(
        await readBoundedFileHandleUtf8Async(preflight, MAX_RECORD_BYTES)
      ) as unknown;
      if (!input.valid(parsed) || JSON.stringify(parsed) !== JSON.stringify(input.expected)) continue;
    } catch (error) {
      if (isMissing(error) || error instanceof SyntaxError) continue;
      throw error;
    } finally {
      await preflight?.close().catch(() => undefined);
    }
    const recoveryPath = `${recordPath}.removing.${randomUUID()}`;
    try {
      // Capture is an atomic no-replace link. Unlike rename, a replacement at
      // recordPath stays published there even if it wins after preflight.
      await fs.promises.link(recordPath, recoveryPath);
    } catch (error) {
      if (isMissing(error)) continue;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw error;
    }
    let handle: fs.promises.FileHandle | null = null;
    let recoveryIdentity: ReturnType<typeof getDurablePathIdentity> | null = null;
    let remove = false;
    try {
      // Bind the captured generation before any operation that can fail. An
      // oversized, nonregular, open, or fstat failure leaves the original
      // record visible and only drops this private hard-link alias below.
      const recoveryStats = await fs.promises.lstat(recoveryPath);
      recoveryIdentity = getDurablePathIdentity(recoveryStats);
      if (!recoveryStats.isFile() || recoveryStats.isSymbolicLink()) {
        remove = false;
      } else {
        handle = await fs.promises.open(
          recoveryPath,
          fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK
        );
        const stats = await handle.stat();
        if (
          !stats.isFile() ||
          stats.isSymbolicLink() ||
          stats.dev !== recoveryIdentity.dev ||
          stats.ino !== recoveryIdentity.ino ||
          stats.birthtimeMs !== recoveryIdentity.birthtimeMs ||
          stats.size > MAX_RECORD_BYTES
        ) {
          remove = false;
        } else {
          const parsed = JSON.parse(
            await readBoundedFileHandleUtf8Async(handle, MAX_RECORD_BYTES)
          ) as unknown;
          remove = input.valid(parsed) && JSON.stringify(parsed) === JSON.stringify(input.expected);
        }
      }
    } catch (error) {
      if (!(error instanceof SyntaxError) && !isMissing(error)) throw error;
    } finally {
      await handle?.close().catch(() => undefined);
    }
    if (!recoveryIdentity) continue;
    if (remove && (await unlinkDurablePathIfIdentityMatchesAsync(recordPath, recoveryIdentity))) {
      await unlinkDurablePathIfIdentityMatchesAsync(recoveryPath, recoveryIdentity);
      removed = true;
    } else {
      await unlinkDurablePathIfIdentityMatchesAsync(recoveryPath, recoveryIdentity);
    }
  }
  if (removed) await input.syncParentDirectory();
}
