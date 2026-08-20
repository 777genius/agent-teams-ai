import * as fs from 'fs';
import * as path from 'path';

import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

import type { DurableDirectoryEntryCleanupResult } from './durablePathOperations';

/**
 * True when the runtime can bind directory operations to /proc/self/fd paths,
 * making them immune to ancestor replacement (Linux only). Other platforms use
 * the best-effort helpers below: symbolic links are still rejected at the
 * operation target, but ancestor-swap protection is not provided. That is the
 * accepted trade-off for the desktop app, where the directory tree is owned by
 * the local user rather than shared with untrusted tenants.
 */
export function hasStrictIdentityStableDirectorySupport(): boolean {
  return (
    process.platform === 'linux' &&
    typeof fs.constants.O_DIRECTORY === 'number' &&
    typeof fs.constants.O_NOFOLLOW === 'number'
  );
}

async function assertNotSymbolicLink(targetPath: string, errorPath: string): Promise<fs.Stats> {
  const stats = await fs.promises.lstat(targetPath);
  if (stats.isSymbolicLink()) {
    throw new Error(`Durable directory identity changed during cleanup: ${errorPath}`);
  }
  return stats;
}

/**
 * Canonicalize a directory path for best-effort operations. Ancestors may
 * legitimately contain symbolic links (macOS /tmp and /var are symlinks), so
 * they are resolved with realpath; only the final component is required to be
 * a real directory rather than a link.
 */
async function resolveBestEffortDirectoryAsync(
  directoryPath: string,
  options: { create?: boolean; errorPath?: string } = {}
): Promise<string | null> {
  const errorPath = options.errorPath ?? directoryPath;
  let stats: fs.Stats;
  try {
    stats = await assertNotSymbolicLink(directoryPath, errorPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    if (!options.create) return null;
    await fs.promises.mkdir(directoryPath, { recursive: true });
    stats = await assertNotSymbolicLink(directoryPath, errorPath);
  }
  if (!stats.isDirectory()) {
    throw new Error(`Durable directory identity changed during cleanup: ${errorPath}`);
  }
  return fs.promises.realpath(directoryPath);
}

export async function withBestEffortDirectoryTreeAsync<T>(
  rootDirectoryPath: string,
  childDirectoryName: string,
  operation: (paths: { rootDirectoryPath: string; childDirectoryPath: string }) => Promise<T>,
  options: { create?: boolean } = {}
): Promise<T> {
  const resolvedRoot = await resolveBestEffortDirectoryAsync(rootDirectoryPath, options);
  if (resolvedRoot === null) {
    throw new Error(`Identity-stable root directory is missing: ${rootDirectoryPath}`);
  }
  const resolvedChild = await resolveBestEffortDirectoryAsync(
    path.join(resolvedRoot, childDirectoryName),
    options
  );
  if (resolvedChild === null) {
    throw new Error(`Identity-stable child directory is missing: ${childDirectoryName}`);
  }
  return operation({ rootDirectoryPath: resolvedRoot, childDirectoryPath: resolvedChild });
}

export async function readRegularFileNoFollowBestEffortAsync(
  filePath: string,
  encoding: BufferEncoding = 'utf8'
): Promise<string> {
  const stats = await fs.promises.lstat(filePath);
  if (stats.isSymbolicLink() || !stats.isFile()) {
    throw new Error(`Durable path is not a regular file: ${filePath}`);
  }
  const flags =
    fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0) | (fs.constants.O_NONBLOCK ?? 0);
  const handle = await fs.promises.open(filePath, flags);
  try {
    const openedStats = await handle.stat();
    if (!openedStats.isFile()) {
      throw new Error(`Durable path is not a regular file: ${filePath}`);
    }
    return await handle.readFile({ encoding });
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readJsonDataEnvelopeNoFollowAsync(filePath: string): Promise<unknown> {
  const parsed = JSON.parse(await readRegularFileNoFollowBestEffortAsync(filePath)) as unknown;
  return parsed &&
    typeof parsed === 'object' &&
    !Array.isArray(parsed) &&
    Object.prototype.hasOwnProperty.call(parsed, 'data')
    ? (parsed as { data: unknown }).data
    : parsed;
}

export async function readOptionalJsonNoFollowAsync(filePath: string): Promise<unknown | null> {
  try {
    return JSON.parse(await readRegularFileNoFollowBestEffortAsync(filePath)) as unknown;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function syncDirectoryBestEffort(dirPath: string, strict: boolean): Promise<void> {
  let handle: fs.promises.FileHandle | null = null;
  try {
    handle = await fs.promises.open(dirPath, 'r');
    await handle.sync();
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const unsupported =
      code === 'EINVAL' ||
      code === 'ENOSYS' ||
      code === 'ENOTSUP' ||
      code === 'EOPNOTSUPP' ||
      (process.platform === 'win32' &&
        (code === 'EACCES' || code === 'EPERM' || code === 'EISDIR' || code === 'EBADF'));
    if (strict && !unsupported) throw error;
  } finally {
    await handle?.close();
  }
}

export async function removeDirectoryEntriesExceptBestEffortAsync(
  directoryPath: string,
  retainedEntryNames: ReadonlySet<string>,
  options: {
    durability?: 'best-effort' | 'strict';
    displayPath?: string;
    validateDirectory?: (
      stableDirectoryPath: string,
      entries: readonly fs.Dirent[]
    ) => Promise<boolean>;
  } = {}
): Promise<DurableDirectoryEntryCleanupResult> {
  const strict = options.durability !== 'best-effort';
  const displayPath = options.displayPath ?? directoryPath;
  const resolved = await resolveBestEffortDirectoryAsync(directoryPath, {
    errorPath: displayPath,
  });
  if (resolved === null) return 'missing';

  const entries = await fs.promises.readdir(resolved, { withFileTypes: true });
  const retained: { name: string; identity: DurablePathIdentity; birthtimeMs: number }[] = [];

  const verifyRetainedEntries = async (): Promise<void> => {
    for (const entry of retained) {
      const retainedPath = path.join(resolved, entry.name);
      const stats = await fs.promises.lstat(retainedPath);
      if (
        !stats.isFile() ||
        stats.isSymbolicLink() ||
        !isSameDurablePathIdentity(getDurablePathIdentity(stats), entry.identity) ||
        stats.birthtimeMs !== entry.birthtimeMs
      ) {
        throw new Error(`Retained directory entry identity changed: ${retainedPath}`);
      }
    }
  };

  for (const entry of entries) {
    if (!retainedEntryNames.has(entry.name)) continue;
    const retainedPath = path.join(resolved, entry.name);
    const stats = await fs.promises.lstat(retainedPath);
    if (!stats.isFile() || stats.isSymbolicLink()) {
      throw new Error(`Retained directory entry is not a regular file: ${retainedPath}`);
    }
    retained.push({
      name: entry.name,
      identity: getDurablePathIdentity(stats),
      birthtimeMs: stats.birthtimeMs,
    });
  }
  await verifyRetainedEntries();

  if (options.validateDirectory && !(await options.validateDirectory(resolved, entries))) {
    return 'validation_failed';
  }
  await verifyRetainedEntries();

  for (const entry of entries) {
    if (!retainedEntryNames.has(entry.name) && entry.isDirectory()) {
      throw new Error(`Durable directory identity changed during cleanup: ${displayPath}`);
    }
  }
  for (const entry of entries) {
    if (retainedEntryNames.has(entry.name)) continue;
    try {
      await fs.promises.unlink(path.join(resolved, entry.name));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
  }
  await verifyRetainedEntries();
  await syncDirectoryBestEffort(resolved, strict);
  return 'cleaned';
}
