import * as fs from 'fs/promises';
import * as path from 'path';

/**
 * Every directory and file under `root` with its mtime, and the bytes of every file.
 * Comparing two snapshots proves that code which must only read left the tree exactly
 * as it was: no file rewritten or touched, nothing created, renamed or deleted.
 */
export async function snapshotDirectoryTree(root: string): Promise<Record<string, string>> {
  const snapshot: Record<string, string> = {};
  const visit = async (dir: string): Promise<void> => {
    const relativeDir = path.relative(root, dir).split(path.sep).join('/');
    snapshot[`${relativeDir}/`] = `dir mtime=${(await fs.lstat(dir)).mtimeMs}`;
    const entries = await fs.readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await visit(fullPath);
        continue;
      }
      const relativePath = path.relative(root, fullPath).split(path.sep).join('/');
      const [stat, bytes] = await Promise.all([fs.lstat(fullPath), fs.readFile(fullPath)]);
      snapshot[relativePath] = `mtime=${stat.mtimeMs} bytes=${bytes.toString('base64')}`;
    }
  };
  await visit(root);
  return snapshot;
}
