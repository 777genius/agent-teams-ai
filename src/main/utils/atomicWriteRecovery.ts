import { createHash } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

type DirectorySync = (directoryPath: string) => Promise<void>;

export function hashReviewTransactionPart(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

export function getReviewTransactionTargetKey(targetPath: string): string {
  return hashReviewTransactionPart(path.resolve(targetPath)).slice(0, 16);
}

export function assertReviewTransactionId(id: string): void {
  if (!/^[a-f0-9-]{36}$/i.test(id)) throw new Error('Invalid review file transaction id');
}

export async function lstatOrNull(filePath: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return null;
    throw error;
  }
}

export function isSameFileIdentity(
  left: Pick<fs.Stats, 'dev' | 'ino'>,
  right: Pick<fs.Stats, 'dev' | 'ino'>
): boolean {
  return left.dev === right.dev && left.ino !== 0 && left.ino === right.ino;
}

export async function assertRegularTextArtifact(
  artifactPath: string,
  expectedContent: string,
  expectedIdentity?: Pick<fs.Stats, 'dev' | 'ino'>
): Promise<fs.Stats> {
  const handle = await fs.promises.open(artifactPath, 'r');
  try {
    const stats = await handle.stat();
    if (!stats.isFile()) {
      throw new Error('Review file transaction artifact is not a regular file');
    }
    if (expectedIdentity && !isSameFileIdentity(stats, expectedIdentity)) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
    const content = await handle.readFile('utf8');
    if (content !== expectedContent) {
      throw new Error('File changed during review update; refusing to mutate it');
    }
    return stats;
  } finally {
    await handle.close();
  }
}

export async function restoreDetachedPathNoClobber(
  detachedPath: string,
  targetPath: string,
  syncDirectory: DirectorySync
): Promise<boolean> {
  try {
    await fs.promises.link(detachedPath, targetPath);
    await fs.promises.unlink(detachedPath);
    await syncDirectory(path.dirname(targetPath));
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    // Preserve both the externally-created target and the detached file. The
    // caller reports a conflict, and no version is destroyed.
    return false;
  }
}

export async function publishHardlinkNoClobber(
  sourcePath: string,
  targetPath: string,
  syncDirectory: DirectorySync
): Promise<void> {
  try {
    await fs.promises.link(sourcePath, targetPath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code !== 'EEXIST') throw error;
    const [source, target] = await Promise.all([
      fs.promises.lstat(sourcePath),
      fs.promises.lstat(targetPath),
    ]);
    if (!isSameFileIdentity(source, target)) throw error;
  }
  await syncDirectory(path.dirname(targetPath));
}
