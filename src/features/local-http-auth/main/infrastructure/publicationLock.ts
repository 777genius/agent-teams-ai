import { constants } from 'node:fs';
import { open, unlink } from 'node:fs/promises';
import path from 'node:path';

/** Cross-process serialization prevents compare/unlink cleanup deleting a replacement. */
export async function withPublicationLock<T>(
  directory: string,
  operation: () => Promise<T>
): Promise<T> {
  const file = path.join(directory, 'publication.lock');
  for (let attempt = 0; attempt < 100; attempt++) {
    const handle = await open(
      file,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
      0o600
    ).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
      return null;
    });
    if (!handle) {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      continue;
    }
    try {
      return await operation();
    } finally {
      await handle.close();
      await unlink(file);
    }
  }
  // Never remove another process's lock, even if it appears stale.
  throw new Error('API authority publication is busy; private lock requires owner recovery');
}
