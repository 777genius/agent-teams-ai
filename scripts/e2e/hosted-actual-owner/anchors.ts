import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { open, realpath } from 'node:fs/promises';
import { relative, resolve, sep } from 'node:path';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export type FileAnchor = Readonly<{
  path: string;
  device: string;
  inode: string;
  mode: number;
  uid: number;
  size: number;
  sha256: string;
}>;

export function isStrictDescendant(root: string, path: string): boolean {
  const relation = relative(root, path);
  return (
    relation !== '' &&
    relation !== '..' &&
    !relation.startsWith(`..${sep}`) &&
    !relation.startsWith(sep)
  );
}

export async function anchorRegularFile(path: string, expectedMode?: number): Promise<FileAnchor> {
  const canonicalPath = await realpath(path);
  if (canonicalPath !== resolve(path)) throw new Error('actual_owner_file_symlink_forbidden');
  const handle = await open(canonicalPath, 'r');
  try {
    const before = await handle.stat({ bigint: true });
    if (
      !before.isFile() ||
      before.nlink !== 1n ||
      (expectedMode !== undefined && Number(before.mode & 0o777n) !== expectedMode) ||
      before.size < 1n ||
      before.size > BigInt(Number.MAX_SAFE_INTEGER)
    ) {
      throw new Error('actual_owner_file_identity_invalid');
    }
    const bytes = await handle.readFile();
    const after = await handle.stat({ bigint: true });
    if (
      before.dev !== after.dev ||
      before.ino !== after.ino ||
      before.size !== after.size ||
      before.mtimeNs !== after.mtimeNs ||
      before.ctimeNs !== after.ctimeNs
    ) {
      throw new Error('actual_owner_file_rotated');
    }
    return Object.freeze({
      path: canonicalPath,
      device: String(after.dev),
      inode: String(after.ino),
      mode: Number(after.mode & 0o777n),
      uid: Number(after.uid),
      size: bytes.byteLength,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
  } finally {
    await handle.close();
  }
}

export async function assertAnchorCurrent(anchor: FileAnchor): Promise<void> {
  const current = await anchorRegularFile(anchor.path, anchor.mode);
  if (JSON.stringify(current) !== JSON.stringify(anchor))
    throw new Error('actual_owner_file_rotated');
}

export async function gitIdentity(
  root: string
): Promise<Readonly<{ commit: string; tree: string }>> {
  const [{ stdout: commit }, { stdout: tree }] = await Promise.all([
    execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: root }),
    execFileAsync('git', ['rev-parse', 'HEAD^{tree}'], { cwd: root }),
  ]);
  return Object.freeze({ commit: commit.trim(), tree: tree.trim() });
}
