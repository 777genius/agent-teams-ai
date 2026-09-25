import { createHash, randomBytes } from 'node:crypto';
import { constants, createReadStream } from 'node:fs';
import { chmod, chown, lstat, mkdir, open, readFile, realpath, rename, rm } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';

/** hostedctl runs as root; defaults follow the caller so the same code is testable unprivileged. */
const selfUid = () => process.getuid?.() ?? 0;
const selfGid = () => process.getgid?.() ?? 0;

export const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');

export function sha256File(path) {
  return new Promise((resolveDigest, reject) => {
    const hash = createHash('sha256');
    createReadStream(path).on('error', reject).on('data', chunk => hash.update(chunk))
      .on('end', () => resolveDigest(hash.digest('hex')));
  });
}

export function assertAbsolute(path, label) {
  if (typeof path !== 'string' || !isAbsolute(path) || resolve(path) !== path) {
    throw new Error(`hostedctl-${label}-must-be-absolute-normalized-path`);
  }
  return path;
}

/** Creates or adopts one directory with exact owner and mode. Symlinks are refused. */
export async function ensureDirectory(path, { uid = selfUid(), gid = selfGid(), mode }) {
  assertAbsolute(path, 'directory');
  await mkdir(path, { recursive: true, mode });
  const entry = await lstat(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || await realpath(path) !== path) {
    throw new Error(`hostedctl-directory-invalid:${path}`);
  }
  await chown(path, uid, gid);
  await chmod(path, mode);
}

/**
 * The launcher trusts a path only when it and every ancestor are owned by a trusted uid (root in
 * production) and not writable by group or others. A root-owned sticky directory such as /tmp is
 * accepted as an ancestor: other users cannot rename or remove entries they do not own there.
 */
export async function assertRootOwnedChain(path, { trustedUids = [0] } = {}) {
  assertAbsolute(path, 'root-owned-path');
  if (await realpath(path) !== path) throw new Error(`hostedctl-path-not-canonical:${path}`);
  for (let current = path; ; current = dirname(current)) {
    const entry = await lstat(current);
    const stickyRoot = current !== path && entry.uid === 0 && (entry.mode & 0o1000) !== 0;
    if (entry.isSymbolicLink() || !trustedUids.includes(entry.uid) ||
        ((entry.mode & 0o022) !== 0 && !stickyRoot)) {
      throw new Error(`hostedctl-path-not-root-owned:${current}`);
    }
    if (current === '/') return;
  }
}

/** Private, fsynced replace. The rename is atomic; the parent is synced after it. */
export async function atomicWriteFile(path, bytes, { uid = selfUid(), gid = selfGid(), mode = 0o600 } = {}) {
  assertAbsolute(path, 'file');
  const temporary = `${path}.tmp-${randomBytes(6).toString('hex')}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(bytes);
    await handle.chown(uid, gid);
    await handle.chmod(mode);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await rm(temporary, { force: true });
    throw error;
  }
  await handle.close();
  try {
    await rename(temporary, path);
  } catch (error) {
    await rm(temporary, { force: true });
    throw error;
  }
  await syncDirectory(dirname(path));
}

export async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY | constants.O_DIRECTORY);
  try { await handle.sync(); } finally { await handle.close(); }
}

/** Reads a small regular file after checking it was not swapped for a link. */
export async function readRegularFile(path, { maxBytes = 1_048_576, uid, mode } = {}) {
  const entry = await lstat(path);
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > maxBytes ||
      (uid !== undefined && entry.uid !== uid) ||
      (mode !== undefined && (entry.mode & 0o777) !== mode)) {
    throw new Error(`hostedctl-file-invalid:${path}`);
  }
  return readFile(path);
}

export async function pathExists(path) {
  return lstat(path).then(() => true, error => {
    if (error.code === 'ENOENT') return false;
    throw error;
  });
}
