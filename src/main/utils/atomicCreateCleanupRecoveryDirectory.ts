import * as fs from 'fs';
import * as path from 'path';

import {
  type AtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryBudget,
} from './atomicCreateCleanupRecoveryIo';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
} from './durablePathIdentity';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

interface ExactGenerationOperations {
  rmdirExactGeneration?: (pathname: string, identity: DurablePathIdentity) => Promise<void>;
  mkdtempWithHandle?: (
    prefix: string
  ) => Promise<{ pathname: string; directoryHandle: fs.promises.FileHandle }>;
}

interface Admission { assertOwnership: () => Promise<void> }

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
  directoryHandle: fs.promises.FileHandle,
  budget?: AtomicCreateRecoveryBudget
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  if (path.resolve(path.dirname(pathname)) !== path.resolve(directory)) {
    await directoryHandle.close().catch(() => undefined);
    throw new Error('Atomic-create recovery directory is outside its admission boundary');
  }
  let retained = false;
  let closeAfterPendingStat = false;
  try {
    const stats = budget
      ? await withinAtomicCreateRecoveryBudget(
          budget,
          'recovery-directory-fstat',
          () => directoryHandle.stat(),
          (pending) => {
            closeAfterPendingStat = true;
            void pending
              .catch(() => undefined)
              .then(() => directoryHandle.close().catch(() => undefined));
          }
        )
      : await directoryHandle.stat();
    if (!stats.isDirectory()) {
      throw new Error('Atomic-create recovery directory cannot be authenticated');
    }
    const identity = getDurablePathIdentity(stats);
    if (!hasTrustworthyDurablePathIdentity(identity) || process.platform !== 'linux') {
      throw new Error(
        'Atomic-create recovery directory requires descriptor-rooted child operations'
      );
    }
    retained = true;
    return {
      pathname,
      identity,
      directoryHandle,
      stablePath: `/proc/self/fd/${directoryHandle.fd}/.`,
    };
  } finally {
    if (!retained && !closeAfterPendingStat) {
      await directoryHandle.close().catch(() => undefined);
    }
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
  reclaimExpired: (assertOwnership: () => Promise<void>) => Promise<void>,
  budget?: AtomicCreateRecoveryBudget
): Promise<AtomicCreateRecoveryDirectoryAuthority> {
  // count-then-create cannot reserve a slot: a timed-out create may complete
  // after admission is released and put the namespace over capacity.
  if (!safeDirectoryReservationAvailable()) {
    throw new Error(
      'Atomic-create recovery directory reservation requires operator reconciliation'
    );
  }
  const create = exactGenerationOperations().mkdtempWithHandle;
  if (!create) {
    throw new Error(
      'Atomic-create recovery directory creation requires an atomic descriptor primitive'
    );
  }
  const cleanupState: { untransferred: AtomicCreateRecoveryDirectoryAuthority | null } = {
    untransferred: null,
  };
  try {
    const result = await withAdmission(async ({ assertOwnership }) => {
      await reclaimExpired(assertOwnership);
      await assertOwnership();
      if ((await countExisting()) >= capacity) {
        throw new Error(`Atomic-create recovery authority capacity (${capacity}) exhausted`);
      }
      await assertOwnership();
      const createDirectory = () => create(prefix);
      const { pathname, directoryHandle } = budget
        ? await withinAtomicCreateRecoveryBudget(
            budget,
            'recovery-directory-create',
            createDirectory,
            (pending) => {
              void pending.then(
                ({ directoryHandle }) => directoryHandle.close().catch(() => undefined),
                () => undefined
              );
            }
          )
        : await createDirectory();
      try {
        await assertOwnership();
      } catch (error) {
        // The creation primitive has already made a descriptor visible. Even
        // though admission was lost before we can authenticate a rollback
        // generation, it must not leak that descriptor into a future fd alias.
        await directoryHandle.close().catch(() => undefined);
        throw error;
      }
      const created = await captureCreatedRecoveryDirectory(
        directory,
        pathname,
        directoryHandle,
        budget
      );
      let capturedWhileAdmitted = false;
      try {
        await assertOwnership();
        capturedWhileAdmitted = true;
        await assertOwnership();
        cleanupState.untransferred = created;
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
    cleanupState.untransferred = null;
    return result;
  } catch (error) {
    const untransferred = cleanupState.untransferred;
    if (untransferred) {
      await untransferred.directoryHandle.close().catch(() => undefined);
    }
    throw error;
  }
}

function safeDirectoryReservationAvailable(): boolean {
  return false;
}
