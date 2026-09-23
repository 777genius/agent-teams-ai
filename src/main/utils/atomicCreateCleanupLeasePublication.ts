import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import {
  type AtomicCreateRecoveryBudget,
  createAtomicCreateRecoveryBudget,
  readBoundedRegularTextWithIdentity,
  withinAtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryOpenBudget,
} from './atomicCreateCleanupRecoveryIo';
import {
  type DurableFileIdentity,
  getDurableFileIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurableFileIdentity,
} from './durablePathIdentity';
import { RENAME_PUBLISH_RETRY, retryOnTransientFsError } from './transientFsRetry';

const MAX_OWNER_RECORD_BYTES = 4 * 1024;

export interface AtomicCreateLeaseOwner {
  version: 1;
  fence: string;
  pid: number;
  incarnation: string | null;
  released?: true;
}

type ExactGenerationOperations = {
  unlinkExactGeneration?: (pathname: string, identity: DurableFileIdentity) => Promise<void>;
  /** Publishes the generation held by the creation handle, never a re-read path. */
  linkExactGeneration?: (
    sourcePath: string,
    destinationPath: string,
    identity: DurableFileIdentity
  ) => Promise<void>;
};

function exactGenerationOperations(): ExactGenerationOperations {
  return fs.promises as typeof fs.promises & ExactGenerationOperations;
}

function codeOf(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException).code;
}

function isMissing(error: unknown): boolean {
  return codeOf(error) === 'ENOENT';
}

function ownerIo<T>(
  budget: AtomicCreateRecoveryBudget | undefined,
  operation: string,
  work: () => Promise<T>,
  onTimeout?: (pending: Promise<T>) => void
): Promise<T> {
  return budget ? withinAtomicCreateRecoveryBudget(budget, operation, work, onTimeout) : work();
}

async function closeOwnerHandle(
  handle: fs.promises.FileHandle,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  let closeStarted = false;
  try {
    await ownerIo(budget, 'owner-handle-close', () => {
      closeStarted = true;
      return handle.close();
    });
  } catch {
    // Closing a descriptor is still required after the public allowance ends.
    // A late close has no pathname side effect and must not hold the caller.
    if (!closeStarted) void handle.close().catch(() => undefined);
  }
}

async function syncOwnerPublication(
  pathname: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  const open = () =>
    fs.promises.open(
      pathname,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0)
    );
  const handle = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'owner-publication-open', open)
    : await open();
  let closeAfterPendingSync = false;
  try {
    if (budget) {
      await withinAtomicCreateRecoveryBudget(
        budget,
        'owner-publication-fsync',
        () => handle.sync(),
        (pending) => {
          closeAfterPendingSync = true;
          void pending.catch(() => undefined).then(() => handle.close().catch(() => undefined));
        }
      );
    } else await handle.sync();
  } finally {
    if (!closeAfterPendingSync) await closeOwnerHandle(handle, budget);
  }
}

async function syncOwnerDirectory(
  directory: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<void> {
  const open = () =>
    fs.promises.open(
      directory,
      fs.constants.O_RDONLY |
        (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
        (typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0)
    );
  const handle = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'owner-directory-open', open)
    : await open();
  let closeAfterPendingSync = false;
  try {
    if (budget) {
      await withinAtomicCreateRecoveryBudget(
        budget,
        'owner-directory-fsync',
        () => handle.sync(),
        (pending) => {
          closeAfterPendingSync = true;
          void pending.catch(() => undefined).then(() => handle.close().catch(() => undefined));
        }
      );
    } else await handle.sync();
  } finally {
    if (!closeAfterPendingSync) await closeOwnerHandle(handle, budget);
  }
}

async function releasePublishedAliases(
  release: (pathname: string, identity: DurableFileIdentity) => Promise<void>,
  pathname: string,
  publishedIdentity: DurableFileIdentity | null,
  pending: string,
  pendingIdentity: DurableFileIdentity | null,
  error: unknown,
  message: string,
  budget?: AtomicCreateRecoveryBudget
): Promise<never> {
  const cleanupErrors: unknown[] = [];
  // The publication allowance may have expired between write, fstat and
  // fsync. Rollback needs its own finite allowance to retire the captured A.
  const cleanupBudget = budget ? createAtomicCreateRecoveryBudget() : undefined;
  if (publishedIdentity) {
    try {
      await ownerIo(cleanupBudget, 'owner-publication-rollback', () =>
        retryOnTransientFsError(() => release(pathname, publishedIdentity), RENAME_PUBLISH_RETRY)
      );
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
    }
  }
  if (pendingIdentity) {
    try {
      await ownerIo(cleanupBudget, 'owner-pending-rollback', () =>
        retryOnTransientFsError(() => release(pending, pendingIdentity), RENAME_PUBLISH_RETRY)
      );
    } catch (cleanupError) {
      if (!isMissing(cleanupError)) cleanupErrors.push(cleanupError);
    }
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError([error, ...cleanupErrors], message);
  }
  throw error;
}

async function writeAndPublishOwner(
  pathname: string,
  pending: string,
  owner: AtomicCreateLeaseOwner,
  syncDirectories: readonly string[],
  replaceIdentity?: DurableFileIdentity,
  budget?: AtomicCreateRecoveryBudget
): Promise<DurableFileIdentity | null> {
  const { unlinkExactGeneration: release, linkExactGeneration: publish } =
    exactGenerationOperations();
  if (!release || !publish) {
    throw new Error('Atomic-create cleanup owner publication requires exact-generation primitives');
  }
  let pendingIdentity: DurableFileIdentity | null = null;
  let publishedIdentity: DurableFileIdentity | null = null;
  let pendingHandle: fs.promises.FileHandle | null = null;
  let closeAfterPendingStat = false;
  let closeAfterPendingWriteOrSync = false;
  const reapLatePendingHandle = async (handle: fs.promises.FileHandle): Promise<void> => {
    try {
      const stats = await handle.stat();
      if (stats.isFile() && !stats.isSymbolicLink())
        await release(pending, getDurableFileIdentity(stats));
    } catch {
      // A failed exact release leaves this pending alias in place. Its name
      // alone cannot authenticate a later scanner, so an operator must
      // inspect it after writers are quiesced.
    } finally {
      await handle.close().catch(() => undefined);
    }
  };
  try {
    // Capture A from the creating descriptor. A pathname lstat after creation
    // could authenticate a substituted B and hand B to publication/deletion.
    const openedPendingHandle = budget
      ? await withinAtomicCreateRecoveryBudget(
          budget,
          'owner-pending-open',
          () => fs.promises.open(pending, 'wx', 0o600),
          (lateOpen) => {
            void lateOpen.then(reapLatePendingHandle, () => undefined);
          }
        )
      : await fs.promises.open(pending, 'wx', 0o600);
    pendingHandle = openedPendingHandle;
    const ownerHandleIo = (operation: string, work: () => Promise<void>): Promise<void> =>
      budget
        ? withinAtomicCreateRecoveryBudget(budget, operation, work, (pendingIo) => {
            closeAfterPendingWriteOrSync = true;
            void pendingIo
              .catch(() => undefined)
              .then(() => reapLatePendingHandle(openedPendingHandle));
          })
        : work();
    await ownerHandleIo('owner-pending-write', () =>
      openedPendingHandle.writeFile(JSON.stringify(owner), 'utf8')
    );
    // Capture A after its bytes are complete but before fsync. A deadline
    // between these awaits can now retire the pending alias in catch.
    const pendingStats = budget
      ? await withinAtomicCreateRecoveryBudget(
          budget,
          'owner-pending-fstat',
          () => openedPendingHandle.stat(),
          (lateStat) => {
            closeAfterPendingStat = true;
            void lateStat
              .catch(() => undefined)
              .then(() => reapLatePendingHandle(openedPendingHandle));
          }
        )
      : await openedPendingHandle.stat();
    if (
      !pendingStats.isFile() ||
      pendingStats.isSymbolicLink() ||
      !hasTrustworthyDurablePathIdentity(getDurablePathIdentity(pendingStats))
    ) {
      throw new Error('Atomic-create cleanup pending owner cannot be authenticated');
    }
    const capturedPendingIdentity = getDurableFileIdentity(pendingStats);
    pendingIdentity = capturedPendingIdentity;
    await ownerHandleIo('owner-pending-fsync', () => openedPendingHandle.sync());
    if (replaceIdentity) {
      await ownerIo(budget, 'owner-replaced-release', () =>
        retryOnTransientFsError(() => release(pathname, replaceIdentity), RENAME_PUBLISH_RETRY)
      );
    }
    await ownerIo(
      budget,
      'owner-publish',
      () => publish(pending, pathname, capturedPendingIdentity),
      (pendingPublish) => {
        void pendingPublish.then(
          () => release(pathname, capturedPendingIdentity).catch(() => undefined),
          () => undefined
        );
      }
    );
    publishedIdentity = capturedPendingIdentity;
    await syncOwnerPublication(pathname, budget);
    for (const directory of syncDirectories) await syncOwnerDirectory(directory, budget);
    await ownerIo(budget, 'owner-pending-release', () =>
      retryOnTransientFsError(() => release(pending, capturedPendingIdentity), RENAME_PUBLISH_RETRY)
    );
    return publishedIdentity;
  } catch (error) {
    return await releasePublishedAliases(
      release,
      pathname,
      publishedIdentity,
      pending,
      pendingIdentity,
      error,
      'Atomic-create owner publication failed and cleanup also failed',
      budget
    );
  } finally {
    if (!closeAfterPendingStat && !closeAfterPendingWriteOrSync && pendingHandle) {
      if (pendingIdentity) await closeOwnerHandle(pendingHandle, budget);
      else void reapLatePendingHandle(pendingHandle);
    }
  }
}

export async function publishAdmissionOwner(
  directory: string,
  owner: AtomicCreateLeaseOwner,
  replaceReleasedOwner = false,
  expectedReplacedIdentity?: DurableFileIdentity,
  budget?: AtomicCreateRecoveryBudget
): Promise<DurableFileIdentity | null> {
  // A caller-supplied exact-generation adapter cannot authenticate the parent
  // directory across a timed-out retry. Retain all names until a native,
  // descriptor-rooted protocol is available.
  if (!safePublicationProtocolAvailable())
    throw new Error('Atomic-create owner publication requires operator reconciliation');
  const pathname = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
  const pending = `${pathname}.pending-${owner.fence}${owner.released ? '-released' : ''}`;
  if (replaceReleasedOwner && !expectedReplacedIdentity) return null;
  try {
    return await writeAndPublishOwner(
      pathname,
      pending,
      owner,
      [directory],
      expectedReplacedIdentity,
      budget
    );
  } catch (error) {
    if (codeOf(error) === 'EEXIST') return null;
    throw error;
  }
}

export async function publishLeaseOwner(
  directory: string,
  lease: string,
  owner: AtomicCreateLeaseOwner,
  budget?: AtomicCreateRecoveryBudget
): Promise<DurableFileIdentity> {
  if (!safePublicationProtocolAvailable())
    throw new Error('Atomic-create owner publication requires operator reconciliation');
  const pathname = path.join(directory, lease, 'owner.json');
  const identity = await writeAndPublishOwner(
    pathname,
    `${pathname}.pending-${owner.fence}`,
    owner,
    [path.dirname(pathname), directory],
    undefined,
    budget
  );
  if (!identity) throw new Error('Atomic-create cleanup lease owner publication raced');
  return identity;
}

export type StaleAdmissionRetirement = 'retired' | 'changed';

/** Authenticate a stale admission generation before exact retirement. */
export async function retireStaleAdmissionOwner(
  directory: string,
  expectedRaw: string,
  expectedIdentity: DurableFileIdentity,
  budget?: AtomicCreateRecoveryBudget
): Promise<StaleAdmissionRetirement> {
  // rename(2) acts on a mutable source and destination. In particular, a
  // substituted retirement-directory symlink can overwrite an unrelated B.
  // No Node API here binds both names to the observed generations.
  if (!safePublicationProtocolAvailable())
    throw new Error('Atomic-create stale-owner retirement requires operator reconciliation');
  const owner = path.join(directory, '.atomic-create-cleanup-admission-owner.json');
  const retirementPrefix = path.join(
    directory,
    `.atomic-create-cleanup-admission-retired-${randomUUID()}-`
  );
  const createRetirementDirectory = () => fs.promises.mkdtemp(retirementPrefix);
  const retirementDirectory = budget
    ? await withinAtomicCreateRecoveryBudget(
        budget,
        'stale-admission-retirement-directory-create',
        createRetirementDirectory,
        (pending) => {
          void pending.then(
            (lateDirectory) => fs.promises.rmdir(lateDirectory).catch(() => undefined),
            () => undefined
          );
        }
      )
    : await createRetirementDirectory();
  const retired = path.join(retirementDirectory, 'owner.json');
  let retiredPresent = false;
  try {
    try {
      // Detach into a fresh private directory, then authenticate the exact
      // generation that moved. A successor at `owner` is never unlinked.
      await ownerIo(
        budget,
        'stale-admission-detach',
        () => fs.promises.rename(owner, retired),
        () => {
          // A late rename may still place A in the private directory. Retain
          // the directory as its recovery authority.
          retiredPresent = true;
        }
      );
      retiredPresent = true;
    } catch (error) {
      if (isMissing(error)) return 'changed';
      throw error;
    }
    const retiredRecord = await readBoundedRegularTextWithIdentity(
      retired,
      MAX_OWNER_RECORD_BYTES,
      budget
    );
    if (
      retiredRecord.text !== expectedRaw ||
      !isSameDurableFileIdentity(retiredRecord.identity, expectedIdentity)
    ) {
      try {
        // A hardlink is a no-clobber restore for regular files. If a successor
        // already owns the public name, retain the detached B rather than
        // overwriting either generation.
        await ownerIo(budget, 'stale-admission-restore', () => fs.promises.link(retired, owner));
        // The private pathname is mutable too. Only an exact-generation
        // release may remove it after the authenticated descriptor read.
        const release = exactGenerationOperations().unlinkExactGeneration;
        if (release) {
          await ownerIo(budget, 'stale-admission-replacement-release', () =>
            release(retired, retiredRecord.identity)
          );
          retiredPresent = false;
        }
      } catch (error) {
        if (codeOf(error) !== 'EEXIST') throw error;
      }
      return 'changed';
    }
    const release = exactGenerationOperations().unlinkExactGeneration;
    if (release) {
      await ownerIo(budget, 'stale-admission-retired-release', () =>
        release(retired, retiredRecord.identity)
      );
      retiredPresent = false;
    }
    return 'retired';
  } catch (error) {
    if (isMissing(error)) return 'changed';
    throw error;
  } finally {
    if (!retiredPresent) {
      await ownerIo(budget, 'stale-admission-directory-rmdir', () =>
        fs.promises.rmdir(retirementDirectory)
      ).catch((error) => {
        if (!isMissing(error)) throw error;
      });
    }
  }
}

function safePublicationProtocolAvailable(): boolean {
  return false;
}
