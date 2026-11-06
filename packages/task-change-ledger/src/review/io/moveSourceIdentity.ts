import * as fs from 'node:fs';
import * as path from 'node:path';

/** Distinguish a published case alias from a recreated source or hardlink. */
export async function hasUnexpectedMoveSource(
  sourcePath: string,
  targetPath: string,
  published: Pick<fs.Stats, 'dev' | 'ino'>
): Promise<boolean> {
  let source: fs.Stats;
  try {
    source = await fs.promises.lstat(sourcePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return false;
    throw error;
  }
  if (source.dev !== published.dev || source.ino === 0 || source.ino !== published.ino) return true;
  const sourceDir = path.dirname(sourcePath);
  const sourceName = path.basename(sourcePath);
  const targetName = path.basename(targetPath);
  if (
    sourceDir !== path.dirname(targetPath) ||
    sourceName === targetName ||
    sourceName.normalize('NFC').toLowerCase() !== targetName.normalize('NFC').toLowerCase()
  ) {
    return true;
  }
  const entries = await fs.promises.readdir(sourceDir);
  return entries.includes(sourceName) || !entries.includes(targetName);
}

