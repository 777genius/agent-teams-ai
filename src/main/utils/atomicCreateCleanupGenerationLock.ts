import * as fs from 'fs';
import * as lockfile from 'proper-lockfile';

import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
} from './durablePathIdentity';

type ExactGenerationOperations = {
  mkdirWithHandle?: (
    pathname: string,
    options?: { mode?: number }
  ) => Promise<{ directoryHandle: fs.promises.FileHandle }>;
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

function nodeCallback(
  callback: (error: NodeJS.ErrnoException | null) => void,
  operation: Promise<unknown>
): void {
  void operation.then(
    () => callback(null),
    (error: NodeJS.ErrnoException) => callback(error)
  );
}

function captureDirectoryIdentity(stats: fs.Stats): DurablePathIdentity {
  const identity = getDurablePathIdentity(stats);
  if (!stats.isDirectory() || !hasTrustworthyDurablePathIdentity(identity)) {
    throw new Error('Atomic-create cleanup lock directory cannot be authenticated');
  }
  return identity;
}

/**
 * proper-lockfile owns heartbeat scheduling, but its pathname-only rmdir can
 * erase a replacement lock generation. This adapter captures identities from
 * the same descriptor/stat observation used by acquisition and stale checks,
 * then binds every library rmdir to that exact generation.
 */
export async function acquireGenerationBoundCleanupLock(
  targetPath: string,
  options: lockfile.LockOptions
): Promise<() => Promise<void>> {
  if (!safeGenerationLockAvailable())
    throw new Error('Atomic-create cleanup lock requires operator reconciliation');
  const exact = exactGenerationOperations();
  if (!exact.mkdirWithHandle || !exact.rmdirExactGeneration) {
    throw new Error('Atomic-create cleanup lock requires exact-generation primitives');
  }

  const lockPath = `${targetPath}.lock`;
  let ownedIdentity: DurablePathIdentity | null = null;
  let observedIdentity: DurablePathIdentity | null = null;
  const adapter = Object.create(fs) as typeof fs;

  adapter.mkdir = ((
    pathname: fs.PathLike,
    mkdirOptions:
      | fs.MakeDirectoryOptions
      | number
      | ((error: NodeJS.ErrnoException | null) => void)
      | undefined,
    maybeCallback?: (error: NodeJS.ErrnoException | null) => void
  ): void => {
    const callback = typeof mkdirOptions === 'function' ? mkdirOptions : maybeCallback;
    if (!callback) throw new Error('Atomic-create cleanup lock mkdir callback is required');
    const mode =
      typeof mkdirOptions === 'number'
        ? mkdirOptions
        : typeof mkdirOptions === 'object' &&
            mkdirOptions !== null &&
            typeof mkdirOptions.mode === 'number'
          ? mkdirOptions.mode
          : undefined;
    nodeCallback(
      callback,
      exact.mkdirWithHandle!(String(pathname), mode === undefined ? undefined : { mode }).then(
        async ({ directoryHandle }) => {
          try {
            ownedIdentity = captureDirectoryIdentity(await directoryHandle.stat());
          } finally {
            await directoryHandle.close().catch(() => undefined);
          }
        }
      )
    );
  }) as typeof fs.mkdir;

  adapter.stat = ((
    pathname: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null, stats?: fs.Stats) => void
  ): void => {
    fs.stat(pathname, (error, stats) => {
      if (error) {
        callback(error);
        return;
      }
      try {
        if (String(pathname) === lockPath) observedIdentity = captureDirectoryIdentity(stats);
        callback(null, stats);
      } catch (captureError) {
        callback(captureError as NodeJS.ErrnoException);
      }
    });
  }) as typeof fs.stat;

  adapter.rmdir = ((
    pathname: fs.PathLike,
    callback: (error: NodeJS.ErrnoException | null) => void
  ): void => {
    const identity = ownedIdentity ?? observedIdentity;
    if (String(pathname) !== lockPath || !identity) {
      callback(
        Object.assign(new Error('Atomic-create cleanup lock generation is unknown'), {
          code: 'EPERM',
        })
      );
      return;
    }
    nodeCallback(callback, exact.rmdirExactGeneration!(lockPath, identity));
  }) as typeof fs.rmdir;

  const generationBoundOptions = { ...options, fs: adapter } as lockfile.LockOptions;
  return lockfile.lock(targetPath, generationBoundOptions);
}

function safeGenerationLockAvailable(): boolean {
  return false;
}
