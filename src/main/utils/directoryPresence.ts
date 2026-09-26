import { promises as fs } from 'fs';

/**
 * `missing` is reserved for definitive absence (ENOENT/ENOTDIR). Permission or
 * I/O failures stay `unknown` so callers never report an inaccessible folder
 * as deleted.
 */
export type DirectoryPresence = 'directory' | 'missing' | 'not_directory' | 'unknown';

const MISSING_PATH_ERRNO_CODES = new Set(['ENOENT', 'ENOTDIR']);

export async function readDirectoryPresence(directoryPath: string): Promise<DirectoryPresence> {
  try {
    return (await fs.stat(directoryPath)).isDirectory() ? 'directory' : 'not_directory';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    return code && MISSING_PATH_ERRNO_CODES.has(code) ? 'missing' : 'unknown';
  }
}

export async function isMissingDirectory(directoryPath: string): Promise<boolean> {
  return (await readDirectoryPresence(directoryPath)) === 'missing';
}
