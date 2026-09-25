import * as fs from 'node:fs';
import * as path from 'node:path';

import { withFileLockSync } from '@main/services/team/fileLock';

const AUTHORITY_RESOURCE_NAME = 'product-task-write-authority-v1';
const LOCK_DIRECTORY_NAME = '.product-task-write-locks';

export const PRODUCT_TASK_WRITE_LOCK_OPTIONS = { preventLiveOwnerTakeover: true } as const;

export type ProductTaskWriteDirectoryIdentity = Readonly<{
  canonicalPath: string;
  device: number;
  inode: number;
}>;

function inspectTrustedAncestry(directory: string): void {
  const absolute = path.resolve(directory);
  if (!path.isAbsolute(directory) || absolute !== directory) {
    throw new Error('product-task-write-lock-directory-invalid');
  }
  let current = path.parse(absolute).root;
  for (const component of absolute.slice(current.length).split(path.sep).filter(Boolean)) {
    current = path.join(current, component);
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) {
      throw new Error('product-task-write-lock-directory-ancestry-unsafe');
    }
    if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
      // A root-owned sticky temporary directory cannot replace another user's
      // child entry; an ordinary writable parent can replace the lock root.
      const stickyRoot = (stat.mode & 0o1000) !== 0 && stat.uid === 0;
      if (!stickyRoot) throw new Error('product-task-write-lock-directory-ancestry-writable');
    }
  }
}

export function inspectProductTaskWritePrivateDirectory(
  directory: string
): ProductTaskWriteDirectoryIdentity {
  inspectTrustedAncestry(directory);
  const stat = fs.lstatSync(directory);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error('product-task-write-lock-directory-unsafe');
  }
  if (process.platform !== 'win32') {
    if ((stat.mode & 0o077) !== 0 || (process.getuid && stat.uid !== process.getuid())) {
      throw new Error('product-task-write-lock-directory-not-private');
    }
  }
  return {
    canonicalPath: fs.realpathSync.native(directory),
    device: stat.dev,
    inode: stat.ino,
  };
}

/** Pure path derivation before AUTH_DATA_ROOT has its storage/app.db. */
export function productTaskWriteLockDirectoryPathForAuthRoot(authDataRoot: string): string {
  if (!path.isAbsolute(authDataRoot) || path.resolve(authDataRoot) !== authDataRoot) {
    throw new Error('product-task-write-auth-root-invalid');
  }
  return path.join(authDataRoot, LOCK_DIRECTORY_NAME);
}

/** Create only the private lock directory; never relax an existing directory. */
export function ensureProductTaskWriteLockDirectory(authDataRoot: string): string {
  productTaskWriteLockDirectoryPathForAuthRoot(authDataRoot);
  const root = inspectProductTaskWritePrivateDirectory(authDataRoot);
  const directory = path.join(root.canonicalPath, LOCK_DIRECTORY_NAME);
  try {
    fs.mkdirSync(directory, { mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
  }
  return inspectProductTaskWritePrivateDirectory(directory).canonicalPath;
}

/**
 * Deployment-global resource shared by v35 mutations and task-file publication.
 * withFileLock/withFileLockSync append `.lock` to this exact path. Acquire it
 * before any per-team task lock.
 */
export function productTaskWriteAuthorityResource(lockDirectory: string): string {
  return path.join(
    inspectProductTaskWritePrivateDirectory(lockDirectory).canonicalPath,
    AUTHORITY_RESOURCE_NAME
  );
}

/** Busy authority fails before a synchronous v35 transaction begins. */
export function withProductTaskWriteAuthorityLockSync<T>(lockDirectory: string, work: () => T): T {
  const resource = productTaskWriteAuthorityResource(lockDirectory);
  let entered = false;
  try {
    return withFileLockSync(
      resource,
      () => {
        entered = true;
        return work();
      },
      { ...PRODUCT_TASK_WRITE_LOCK_OPTIONS, acquireTimeoutMs: 0 }
    );
  } catch (error) {
    if (!entered && error instanceof Error && error.message === `File lock timeout: ${resource}`) {
      throw new Error('product-authority-lock-transient-busy');
    }
    throw error;
  }
}
