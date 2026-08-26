import { randomBytes } from 'node:crypto';
import { chmod, lstat, mkdir, open, rename, rm } from 'node:fs/promises';
import { dirname, join, relative, resolve, sep } from 'node:path';

import { anchorRegularFile, isStrictDescendant, type FileAnchor } from './anchors';

async function hardenDirectory(path: string): Promise<void> {
  const before = await lstat(path);
  if (!before.isDirectory() || before.isSymbolicLink() || before.nlink < 2) {
    throw new Error('actual_owner_directory_identity_invalid');
  }
  await chmod(path, 0o700);
  const after = await lstat(path);
  if (
    !after.isDirectory() ||
    after.isSymbolicLink() ||
    after.dev !== before.dev ||
    after.ino !== before.ino ||
    after.nlink < 2 ||
    (after.mode & 0o777) !== 0o700
  ) {
    throw new Error('actual_owner_directory_identity_invalid');
  }
}

/** Creates and verifies root and every requested descendant directory at mode 0700. */
export async function ensurePrivateDirectory(path: string, root: string): Promise<void> {
  const resolvedRoot = resolve(root);
  const resolvedPath = resolve(path);
  if (resolvedPath !== resolvedRoot && !isStrictDescendant(resolvedRoot, resolvedPath))
    throw new Error('actual_owner_directory_escape');
  await hardenDirectory(resolvedRoot);
  if (resolvedPath === resolvedRoot) return;
  let current = resolvedRoot;
  for (const segment of relative(resolvedRoot, resolvedPath).split(sep)) {
    current = join(current, segment);
    await mkdir(current, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await hardenDirectory(current);
  }
}

/** Atomically replaces a private regular file and returns its post-write identity anchor. */
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

/** Encodes one canonical single-line JSON value for private evidence files. */
export function canonicalJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value)}\n`, 'utf8');
}
