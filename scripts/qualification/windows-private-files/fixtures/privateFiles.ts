import { randomUUID } from 'node:crypto';
import { constants, type Stats } from 'node:fs';
import { lstat, mkdir, open, realpath, rename, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import { assertPrivateWindowsAcl } from './windowsPrivateAcl';

/** Windows path boundary supplements effective ACL verification; it never proves privacy alone. */
export function assertWindowsProfileRoot(root: string, userProfile: string): void {
  const relative = path.win32.relative(userProfile, root);
  if (!relative || relative.startsWith('..') || path.win32.isAbsolute(relative)) {
    throw new Error('API storage must inherit a private user-profile ACL');
  }
}

export async function validateProfileRoot(root: string): Promise<string> {
  if (!path.isAbsolute(root) || path.resolve(root) !== root)
    throw new Error('Expected absolute profile root');
  if (process.platform === 'win32') {
    assertWindowsProfileRoot(root, homedir());
    assertPrivateWindowsAcl(root);
  }
  // Refuse links at every existing component, including the profile root.
  let cursor = root;
  while (true) {
    const stat = await lstat(cursor);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error('Unsafe API profile root');
    if (cursor === root && process.getuid && (stat.uid !== process.getuid() || stat.mode & 0o022)) {
      throw new Error('API profile root is not owner controlled');
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) break;
    cursor = parent;
  }
  if ((await realpath(root)) !== root) throw new Error('API profile root changed');
  return root;
}

export async function privateDirectory(root: string): Promise<string> {
  await validateProfileRoot(root);
  const directory = path.join(root, 'local-http-auth');
  await mkdir(directory, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'EEXIST') throw error;
  });
  await validatePrivatePath(directory, true);
  return directory;
}

export async function validatePrivatePath(file: string, directory = false): Promise<Stats> {
  // lstat owns absence/type detection. An ACL failure on an existing file is never absence.
  const stat = await lstat(file);
  if (
    stat.isSymbolicLink() ||
    (directory ? !stat.isDirectory() : !stat.isFile()) ||
    (!directory && stat.nlink !== 1) ||
    (process.getuid &&
      (stat.uid !== process.getuid() || (stat.mode & 0o777) !== (directory ? 0o700 : 0o600)))
  ) {
    throw new Error('API state must be private and owned by this user');
  }
  if (process.platform === 'win32') assertPrivateWindowsAcl(file);
  return stat;
}

export async function readPrivateJson(file: string): Promise<unknown> {
  await validatePrivatePath(file);
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const stat = await handle.stat();
    if (
      !stat.isFile() ||
      stat.nlink !== 1 ||
      stat.size > 16_384 ||
      (process.getuid && (stat.uid !== process.getuid() || (stat.mode & 0o777) !== 0o600))
    ) {
      throw new Error('Invalid private API file');
    }
    return JSON.parse(await handle.readFile('utf8')) as unknown;
  } finally {
    await handle.close();
  }
}

export async function writePrivateJson(file: string, value: unknown): Promise<void> {
  return replacePrivateJson(file, value, validatePrivatePath);
}

/** Infrastructure primitive: callers must validate an existing target; publication holds its lock. */
export async function replacePrivateJson(
  file: string,
  value: unknown,
  validateExisting: (target: string) => Promise<Stats>
): Promise<void> {
  const inspect = async (): Promise<Stats | null> => {
    // Only a filesystem lstat absence can admit a new target, never an ACL/parse failure.
    try {
      await lstat(file);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw error;
    }
    return validateExisting(file);
  };
  const previous = await inspect();
  const temporary = `${file}.${randomUUID()}.tmp`;
  const handle = await open(
    temporary,
    constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY,
    0o600
  );
  try {
    const temporaryStat = await validatePrivatePath(temporary);
    const opened = await handle.stat();
    if (opened.dev !== temporaryStat.dev || opened.ino !== temporaryStat.ino)
      throw new Error('Private API temporary file changed');
    await handle.writeFile(JSON.stringify(value) + '\n', 'utf8');
    await handle.sync();
    await handle.close();
    const current = await inspect();
    if (current?.dev !== previous?.dev || current?.ino !== previous?.ino)
      throw new Error('API publication target changed');
    await rename(temporary, file);
  } finally {
    await handle.close();
    await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }
}
