import { lstat, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

import {
  validateOwnedDirectoryRoot,
  validatePrivatePath,
  validateProfileRoot,
} from './privateFiles';
import { assertPrivateWindowsAcl } from './windowsPrivateAcl';

/** Validate existing ancestry before creating owner-only credential directories. */
async function validateExistingRoot(root: string): Promise<void> {
  if (root === homedir()) {
    await validateOwnedDirectoryRoot(root);
    if (process.platform === 'win32') assertPrivateWindowsAcl(root);
  } else await validateProfileRoot(root);
}

export async function preparePrivateFileDirectory(file: string): Promise<void> {
  const directory = path.dirname(file);
  const missing: string[] = [];
  let existing = directory;
  while (true) {
    try {
      await lstat(existing);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      missing.unshift(existing);
      const parent = path.dirname(existing);
      if (parent === existing) throw new Error('Missing private credential root');
      existing = parent;
    }
  }
  await validateExistingRoot(existing);
  for (const target of missing) {
    await validateExistingRoot(path.dirname(target));
    await mkdir(target, { mode: 0o700 }).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'EEXIST') throw error;
    });
    await validatePrivatePath(target, true);
  }
  await validateProfileRoot(directory);
  await validatePrivatePath(directory, true);
}
