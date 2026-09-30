import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  INTERNAL_STORAGE_DATABASE_FILENAME,
  INTERNAL_STORAGE_DIRNAME,
} from '@features/internal-storage/contracts';

const MAX_IDENTITY_DATABASE_BYTES = 512 * 1024 * 1024;
const NO_FOLLOW = fs.constants.O_NOFOLLOW;
const DATABASE_SIDECAR_SUFFIXES = Object.freeze(['-journal', '-shm', '-wal']);

interface EntryIdentity {
  readonly device: bigint;
  readonly inode: bigint;
}

export interface IdentityDatabasePathBinding {
  readonly appDataRoot: string;
  readonly storagePath: string;
  readonly databasePath: string;
  readonly rootIdentity: EntryIdentity;
  readonly storageIdentity: EntryIdentity;
  readonly databaseIdentity: EntryIdentity;
}

function entryIdentity(stat: fs.BigIntStats): EntryIdentity {
  return Object.freeze({ device: stat.dev, inode: stat.ino });
}

function sameEntry(stat: fs.BigIntStats, expected: EntryIdentity): boolean {
  return stat.dev === expected.device && stat.ino === expected.inode;
}

function noFollowReadFlags(): number {
  if (!Number.isSafeInteger(NO_FOLLOW) || NO_FOLLOW <= 0) {
    throw new Error('team-lifecycle-read-no-follow-unavailable');
  }
  return fs.constants.O_RDONLY | NO_FOLLOW;
}

function stableFile(before: fs.BigIntStats, after: fs.BigIntStats): boolean {
  return (
    sameEntry(after, entryIdentity(before)) &&
    before.size === after.size &&
    before.mtimeNs === after.mtimeNs &&
    before.ctimeNs === after.ctimeNs
  );
}

function isDirectChild(root: string, candidate: string, expectedName: string): boolean {
  return path.relative(root, candidate) === expectedName;
}

function isMissingPath(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    'code' in error &&
    (error as NodeJS.ErrnoException).code === 'ENOENT'
  );
}

async function lstatIfPresent(targetPath: string): Promise<fs.BigIntStats | null> {
  try {
    return await fs.promises.lstat(targetPath, { bigint: true });
  } catch (error) {
    if (isMissingPath(error)) return null;
    throw error;
  }
}

async function sidecarsAreAbsent(databasePath: string): Promise<boolean> {
  const values = await Promise.all(
    DATABASE_SIDECAR_SUFFIXES.map((suffix) => lstatIfPresent(`${databasePath}${suffix}`))
  );
  return values.every((value) => value === null);
}

async function readDescriptorSnapshot(
  databasePath: string,
  expectedPathStat: fs.BigIntStats
): Promise<Buffer> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(databasePath, noFollowReadFlags());
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || !stableFile(expectedPathStat, opened)) {
      throw new Error('team-lifecycle-read-identity-database-replaced');
    }

    const expectedSize = Number(expectedPathStat.size);
    const buffer = Buffer.allocUnsafe(expectedSize + 1);
    let offset = 0;
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    if (offset !== expectedSize || !stableFile(opened, after)) {
      throw new Error('team-lifecycle-read-identity-database-changed');
    }
    return buffer.subarray(0, offset);
  } finally {
    if (handle) await handle.close();
  }
}

export async function admitIdentityDatabasePath(
  appDataRoot: string
): Promise<IdentityDatabasePathBinding> {
  if (
    !path.isAbsolute(appDataRoot) ||
    path.resolve(appDataRoot) !== appDataRoot ||
    appDataRoot === path.parse(appDataRoot).root
  ) {
    throw new Error('team-lifecycle-read-app-data-root-invalid');
  }

  const storagePath = path.join(appDataRoot, INTERNAL_STORAGE_DIRNAME);
  const databasePath = path.join(storagePath, INTERNAL_STORAGE_DATABASE_FILENAME);
  const [rootStat, storageStat, canonicalRoot, canonicalStorage, canonicalDatabase, databaseStat] =
    await Promise.all([
      fs.promises.lstat(appDataRoot, { bigint: true }),
      fs.promises.lstat(storagePath, { bigint: true }),
      fs.promises.realpath(appDataRoot),
      fs.promises.realpath(storagePath),
      fs.promises.realpath(databasePath),
      fs.promises.lstat(databasePath, { bigint: true }),
    ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !storageStat.isDirectory() ||
    storageStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    canonicalRoot !== appDataRoot ||
    canonicalStorage !== storagePath ||
    canonicalDatabase !== databasePath ||
    !isDirectChild(canonicalRoot, canonicalStorage, INTERNAL_STORAGE_DIRNAME) ||
    !isDirectChild(canonicalStorage, canonicalDatabase, INTERNAL_STORAGE_DATABASE_FILENAME) ||
    databaseStat.size < 1n ||
    databaseStat.size > BigInt(MAX_IDENTITY_DATABASE_BYTES) ||
    !(await sidecarsAreAbsent(databasePath))
  ) {
    throw new Error('team-lifecycle-read-identity-database-unavailable');
  }

  return Object.freeze({
    appDataRoot,
    storagePath,
    databasePath,
    rootIdentity: entryIdentity(rootStat),
    storageIdentity: entryIdentity(storageStat),
    databaseIdentity: entryIdentity(databaseStat),
  });
}

export async function readImmutableDatabaseSnapshot(
  binding: IdentityDatabasePathBinding
): Promise<Buffer> {
  const { appDataRoot, storagePath, databasePath } = binding;
  const [rootStat, storageStat, canonicalRoot, canonicalStorage, canonicalDatabase, databaseStat] =
    await Promise.all([
      fs.promises.lstat(appDataRoot, { bigint: true }),
      fs.promises.lstat(storagePath, { bigint: true }),
      fs.promises.realpath(appDataRoot),
      fs.promises.realpath(storagePath),
      fs.promises.realpath(databasePath),
      fs.promises.lstat(databasePath, { bigint: true }),
    ]);
  if (
    !rootStat.isDirectory() ||
    rootStat.isSymbolicLink() ||
    !storageStat.isDirectory() ||
    storageStat.isSymbolicLink() ||
    !databaseStat.isFile() ||
    databaseStat.isSymbolicLink() ||
    !sameEntry(rootStat, binding.rootIdentity) ||
    !sameEntry(storageStat, binding.storageIdentity) ||
    !sameEntry(databaseStat, binding.databaseIdentity) ||
    canonicalRoot !== appDataRoot ||
    canonicalStorage !== storagePath ||
    canonicalDatabase !== databasePath ||
    !isDirectChild(canonicalRoot, canonicalStorage, INTERNAL_STORAGE_DIRNAME) ||
    !isDirectChild(canonicalStorage, canonicalDatabase, INTERNAL_STORAGE_DATABASE_FILENAME) ||
    databaseStat.size < 1n ||
    databaseStat.size > BigInt(MAX_IDENTITY_DATABASE_BYTES) ||
    !(await sidecarsAreAbsent(databasePath))
  ) {
    throw new Error('team-lifecycle-read-identity-database-replaced');
  }

  const snapshot = await readDescriptorSnapshot(databasePath, databaseStat);
  const [
    rootAfter,
    storageAfter,
    databaseAfter,
    rootPathAfter,
    storagePathAfter,
    databasePathAfter,
  ] = await Promise.all([
    fs.promises.lstat(appDataRoot, { bigint: true }),
    fs.promises.lstat(storagePath, { bigint: true }),
    fs.promises.lstat(databasePath, { bigint: true }),
    fs.promises.realpath(appDataRoot),
    fs.promises.realpath(storagePath),
    fs.promises.realpath(databasePath),
  ]);
  if (
    !sameEntry(rootAfter, binding.rootIdentity) ||
    !sameEntry(storageAfter, binding.storageIdentity) ||
    !sameEntry(databaseAfter, binding.databaseIdentity) ||
    !stableFile(databaseStat, databaseAfter) ||
    rootPathAfter !== canonicalRoot ||
    storagePathAfter !== canonicalStorage ||
    databasePathAfter !== canonicalDatabase ||
    !(await sidecarsAreAbsent(databasePath))
  ) {
    throw new Error('team-lifecycle-read-identity-database-changed');
  }
  return snapshot;
}
