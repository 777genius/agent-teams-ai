import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

/**
 * Async atomic write: write tmp file then rename over target.
 * Uses best-effort fsync and EXDEV fallback for safety.
 */
export async function atomicWriteAsync(targetPath: string, data: string): Promise<void> {
  const dir = path.dirname(targetPath);
  const tmpPath = path.join(dir, `.tmp.${randomUUID()}`);

  try {
    await fs.promises.mkdir(dir, { recursive: true });
    await fs.promises.writeFile(tmpPath, data, 'utf8');

    let fd: fs.promises.FileHandle | null = null;
    try {
      fd = await fs.promises.open(tmpPath, 'r+');
      await fd.sync();
    } catch {
      // fsync is best-effort.
    } finally {
      await fd?.close();
    }

    try {
      await fs.promises.rename(tmpPath, targetPath);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'EXDEV') {
        await fs.promises.copyFile(tmpPath, targetPath);
        await fs.promises.unlink(tmpPath).catch(() => undefined);
      } else {
        throw error;
      }
    }
  } catch (error) {
    await fs.promises.unlink(tmpPath).catch(() => undefined);
    throw error;
  }
}
