import * as fs from 'fs';
import * as path from 'path';

import {
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  type DurablePathIdentity,
} from './durablePathIdentity';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

type ExactGenerationOperations = {
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  mkdtempWithHandle?: (
    prefix: string
  ) => Promise<{ pathname: string; directoryHandle: fs.promises.FileHandle }>;
};

type Admission = { assertOwnership: () => Promise<void> };

export interface AtomicCreateRecoveryDirectoryAuthority {
  pathname: string;
  identity: DurablePathIdentity;
  /** Kept open until the recovery record has been durably published. */
  directoryHandle: fs.promises.FileHandle;
  /** A child path rooted in directoryHandle, never a reopened pathname. */
  stablePath: string;
}

function isMissing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

async function captureCreatedRecoveryDirectory(
  directory: string,
  pathname: string,
  directoryHandle: fs.promises.FileHandle
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  if (path.resolve(path.dirname(pathname)) !== path.resolve(directory)) {
    await directoryHandle.close().catch(() => undefined);
    throw new Error('Atomic-create recovery directory is outside its admission boundary');
  }
  let retained = false;
  try {
    const stats = await directoryHandle.stat();
    if (!stats.isDirectory()) {
      throw new Error('Atomic-create recovery directory cannot be authenticated');
    }
    const identity = getDurablePathIdentity(stats);
    if (!hasTrustworthyDurablePathIdentity(identity) || process.platform !== 'linux') {
      throw new Error('Atomic-create recovery directory requires descriptor-rooted child operations');
    }
    retained = true;
    return {
      pathname,
      identity,
      directoryHandle,
      stablePath: `/proc/self/fd/${directoryHandle.fd}/.`,
    };
  } finally {
    if (!retained) await directoryHandle.close().catch(() => undefined);
  }
}

async function releaseUnadmittedRecoveryDirectory(
  created: AtomicCreateRecoveryDirectoryAuthority
): Promise<void> {
  const release = exactGenerationOperations().rmdirExactGeneration;
  if (!release) return;
  try {
    await retryOnTransientFsError(
      () => release(created.pathname, created.identity),
      RENAME_PUBLISH_RETRY
    );
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
}

/**
 * Allocate a directory while an authenticated admission fence still covers
 * both its creation and descriptor capture. The caller supplies its lease
 * protocol so this focused descriptor handoff module has no ownership cycle.
 */
export async function allocateAtomicCreateRecoveryDirectoryAuthority(
  directory: string,
  prefix: string,
  countExisting: () => Promise<number>,
  capacity: number,
  withAdmission: <T>(operation: (admission: Admission) => Promise<T>) => Promise<T>,
  reclaimExpired: (assertOwnership: () => Promise<void>) => Promise<void>
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  if (!exactGenerationOperations().mkdtempWithHandle) {
    throw new Error('Atomic-create recovery directory creation requires an atomic descriptor primitive');
  }
  let untransferred: AtomicCreateRecoveryDirectoryAuthority | null = null;
  try {
    const result = await withAdmission(async ({ assertOwnership }) => {
      await reclaimExpired(assertOwnership);
      await assertOwnership();
      if ((await countExisting()) >= capacity) {
        throw new Error(`Atomic-create recovery authority capacity (${capacity}) exhausted`);
      }
      await assertOwnership();
      const create = exactGenerationOperations().mkdtempWithHandle!;
      const { pathname, directoryHandle } = await create(prefix);
      try {
        await assertOwnership();
      } catch (error) {
        // The creation primitive has already made a descriptor visible. Even
        // though admission was lost before we can authenticate a rollback
        // generation, it must not leak that descriptor into a future fd alias.
        await directoryHandle.close().catch(() => undefined);
        throw error;
      }
      const created = await captureCreatedRecoveryDirectory(directory, pathname, directoryHandle);
      let capturedWhileAdmitted = false;
      try {
        await assertOwnership();
        capturedWhileAdmitted = true;
        await assertOwnership();
        untransferred = created;
        return created;
      } catch (error) {
        try {
          if (capturedWhileAdmitted) await releaseUnadmittedRecoveryDirectory(created);
        } catch (releaseError) {
          await created.directoryHandle.close().catch(() => undefined);
          throw new AggregateError(
            [error, releaseError],
            'Atomic-create recovery admission fence was lost and rollback failed'
          );
        }
        await created.directoryHandle.close().catch(() => undefined);
        throw error;
      }
    });
    untransferred = null;
    return result;
  } catch (error) {
    await untransferred?.directoryHandle.close().catch(() => undefined);
    throw error;
  }
}
