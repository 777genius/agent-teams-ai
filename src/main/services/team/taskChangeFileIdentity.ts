import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';
import { posix, win32 } from 'path';

/** Group lexical path aliases before deciding whether a file was newly created. */
export function taskChangeFileIdentity(filePath: string): string {
  const slashes = filePath.replace(/\\/g, '/');
  const normalized = isWindowsishPath(slashes)
    ? win32.normalize(slashes).replace(/\\/g, '/')
    : posix.normalize(slashes);
  const identity = normalizePathForComparison(normalized);
  return process.platform === 'darwin' ? identity.normalize('NFC').toLowerCase() : identity;
}
