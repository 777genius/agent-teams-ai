import * as fs from 'node:fs';
import * as path from 'node:path';

async function syncDirectoryBestEffort(directoryPath: string): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(directoryPath, 'r');
    await handle.sync();
  } catch {
    // Directory fsync is unavailable on some supported filesystems/platforms.
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** Remove only crash-left atomic-create temp names that still reference this exact inode. */
export async function cleanupAtomicCreateTempLinks(targetPath: string): Promise<void> {
  const target = await fs.promises.lstat(targetPath);
  if (target.nlink <= 1) return;

  const directoryPath = path.dirname(targetPath);
  for (const entry of await fs.promises.readdir(directoryPath)) {
    if (!/^\.review-create\.[a-f0-9-]+\.tmp$/i.test(entry)) continue;
    const candidatePath = path.join(directoryPath, entry);
    try {
      const candidate = await fs.promises.lstat(candidatePath);
      if (candidate.dev === target.dev && candidate.ino === target.ino) {
        await fs.promises.unlink(candidatePath);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await syncDirectoryBestEffort(directoryPath);
}
