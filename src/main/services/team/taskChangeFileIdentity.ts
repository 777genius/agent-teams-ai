import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';
import { realpathSync } from 'fs';
import { posix, win32 } from 'path';

function resolveExistingAncestor(filePath: string, pathApi: typeof posix): string {
  let candidate = filePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return pathApi.join(realpathSync.native(candidate), ...missingSegments.reverse());
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') break;
      const parent = pathApi.dirname(candidate);
      if (parent === candidate) break;
      missingSegments.push(pathApi.basename(candidate));
      candidate = parent;
    }
  }
  return filePath;
}

/** Group paths by the current filesystem target, including aliases of missing files. */
export function taskChangeFileIdentity(filePath: string): string {
  const slashes = filePath.replace(/\\/g, '/');
  if (isWindowsishPath(slashes)) {
    const resolved =
      process.platform === 'win32'
        ? resolveExistingAncestor(filePath, win32)
        : win32.normalize(filePath);
    return normalizePathForComparison(resolved);
  }
  const resolved = slashes.startsWith('/') ? resolveExistingAncestor(slashes, posix) : slashes;
  return posix.normalize(resolved);
}
