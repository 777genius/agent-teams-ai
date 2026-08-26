import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { anchorRegularFile, isStrictDescendant, type FileAnchor } from './anchors';

export async function ensurePrivateDirectory(path: string, root: string): Promise<void> {
  if (!isStrictDescendant(resolve(root), resolve(path)))
    throw new Error('actual_owner_directory_escape');
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
  const stat = await lstat(path);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.nlink < 2 || (stat.mode & 0o077) !== 0) {
    throw new Error('actual_owner_directory_identity_invalid');
  }
}

export async function atomicPrivateFile(
  path: string,
  bytes: Uint8Array,
  root: string
): Promise<FileAnchor> {
  const parent = dirname(path);
  await ensurePrivateDirectory(parent, root);
  if (!isStrictDescendant(resolve(root), resolve(path)))
    throw new Error('actual_owner_file_escape');
  const temporary = join(parent, `.${randomBytes(16).toString('hex')}.tmp`);
  try {
    const handle = await open(temporary, 'wx', 0o600);
    try {
      await handle.writeFile(bytes);
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temporary, path);
    return await anchorRegularFile(path, 0o600);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
}

export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}
