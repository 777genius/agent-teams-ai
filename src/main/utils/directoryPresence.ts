import { promises as fs } from 'fs';

/**
 * `missing` is reserved for definitive absence (ENOENT/ENOTDIR). Permission or
 * I/O failures stay `unknown` so callers never report an inaccessible folder
 * as deleted.
 */
export type DirectoryPresence = 'directory' | 'missing' | 'not_directory' | 'unknown';

/** Node ENOENT/ENOTDIR, plus SFTP SSH_FX_NO_SUCH_FILE (`2`). */
const MISSING_PATH_ERRNO_CODES = new Set(['ENOENT', 'ENOTDIR', '2']);

export function isDefinitiveMissingPathError(error: unknown): boolean {
  const raw = (error as NodeJS.ErrnoException | { code?: unknown } | null)?.code;
  const code = typeof raw === 'number' ? String(raw) : raw;
  return typeof code === 'string' && MISSING_PATH_ERRNO_CODES.has(code);
}

export async function readDirectoryPresence(directoryPath: string): Promise<DirectoryPresence> {
  try {
    return (await fs.stat(directoryPath)).isDirectory() ? 'directory' : 'not_directory';
  } catch (error) {
    return isDefinitiveMissingPathError(error) ? 'missing' : 'unknown';
  }
}

export async function isMissingDirectory(directoryPath: string): Promise<boolean> {
  return (await readDirectoryPresence(directoryPath)) === 'missing';
}

export async function resolvePathAvailability(
  projectPath: string,
  probe: () => Promise<unknown>
): Promise<'available' | 'deleted'> {
  if (!projectPath.trim()) {
    return 'deleted';
  }
  try {
    await probe();
    return 'available';
  } catch (error) {
    return isDefinitiveMissingPathError(error) ? 'deleted' : 'available';
  }
}
