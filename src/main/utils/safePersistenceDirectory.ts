import { renamePathWithRetry } from '@main/utils/atomicWrite';
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

function isPathInside(rootPath: string, candidatePath: string): boolean {
  const relative = path.relative(rootPath, candidatePath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Creates a private persistence directory without following symlinked descendants
 * below the configured storage root. The root itself may intentionally be a symlink.
 */
export async function ensureConstrainedPersistenceDirectory(
  storageRoot: string,
  directoryPath: string
): Promise<void> {
  const lexicalRoot = path.resolve(storageRoot);
  const lexicalDirectory = path.resolve(directoryPath);
  if (!isPathInside(lexicalRoot, lexicalDirectory)) {
    throw new Error('Persistence directory escapes its configured storage root');
  }

  await fs.promises.mkdir(lexicalRoot, { recursive: true, mode: 0o700 });
  const realRoot = await fs.promises.realpath(lexicalRoot);
  const relative = path.relative(lexicalRoot, lexicalDirectory);
  let current = lexicalRoot;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      await fs.promises.mkdir(current, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    const stats = await fs.promises.lstat(current);
    if (!stats.isDirectory() || stats.isSymbolicLink()) {
      throw new Error(`Unsafe persistence directory: ${current}`);
    }
  }

  const realDirectory = await fs.promises.realpath(lexicalDirectory);
  if (!isPathInside(realRoot, realDirectory)) {
    throw new Error('Persistence directory resolves outside its configured storage root');
  }
}

export async function quarantineConstrainedPersistenceFile(
  storageRoot: string,
  sourcePath: string,
  quarantineDirectory: string
): Promise<string> {
  await ensureConstrainedPersistenceDirectory(storageRoot, path.dirname(sourcePath));
  await ensureConstrainedPersistenceDirectory(storageRoot, quarantineDirectory);
  const destinationPath = path.join(
    quarantineDirectory,
    `${path.basename(sourcePath)}.corrupt-${Date.now()}-${randomUUID()}`
  );
  await renamePathWithRetry(sourcePath, destinationPath, {
    syncDirectories: true,
    durability: 'strict',
  });
  return destinationPath;
}
