import * as fs from 'node:fs';
import * as path from 'node:path';

import { type DurablePathIdentity, getDurablePathIdentity } from './durablePathIdentity';
import {
  isSameTrustedDurableFilesystemIdentity,
  rmdirDurablePathIfIdentityMatchesAsync,
  unlinkDurablePathIfIdentityMatchesAsync,
  withIdentityStableDirectoryPathAsync,
} from './durablePathOperationSupport';

function sameIdentity(stats: fs.Stats, expected: DurablePathIdentity): boolean {
  return (
    isSameTrustedDurableFilesystemIdentity(getDurablePathIdentity(stats), expected) &&
    stats.birthtimeMs === expected.birthtimeMs
  );
}

/**
 * Removes only descendants reached through a live directory authority. Each
 * final-component mutation rechecks its generation; an unexpected replacement
 * stops the operation before a sibling or replacement can be removed.
 */
export async function removeDurablePathExactAsync(
  pathname: string,
  expectedIdentity: DurablePathIdentity,
  recursive: boolean,
  options: {
    onBeforeDestructiveMutation?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  } = {}
): Promise<boolean> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(pathname);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ENOTDIR';
  }
  if (!sameIdentity(stats, expectedIdentity)) return false;
  if (!stats.isDirectory() || stats.isSymbolicLink()) {
    await options.onBeforeDestructiveMutation?.(pathname, expectedIdentity);
    return unlinkDurablePathIfIdentityMatchesAsync(pathname, expectedIdentity);
  }
  if (!recursive) {
    await options.onBeforeDestructiveMutation?.(pathname, expectedIdentity);
    return rmdirDurablePathIfIdentityMatchesAsync(pathname, expectedIdentity);
  }
  const access = await withIdentityStableDirectoryPathAsync(
    pathname,
    async (stableDirectoryPath) => {
      for (const entry of await fs.promises.readdir(stableDirectoryPath)) {
        const childPath = path.join(stableDirectoryPath, entry);
        const childStats = await fs.promises.lstat(childPath);
        if (!(await removeDurablePathExactAsync(
          childPath,
          getDurablePathIdentity(childStats),
          true
        ))) return false;
      }
      return true;
    },
    { expectedIdentity, errorPath: pathname }
  );
  if (access.state !== 'opened' || !access.value) return false;
  await options.onBeforeDestructiveMutation?.(pathname, expectedIdentity);
  return rmdirDurablePathIfIdentityMatchesAsync(pathname, expectedIdentity);
}
