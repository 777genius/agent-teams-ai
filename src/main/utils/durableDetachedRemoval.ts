import * as fs from 'node:fs';
import * as path from 'node:path';

import { type DurablePathIdentity, getDurablePathIdentity } from './durablePathIdentity';

import type {
  AtomicPathRemovalResult,
  DurablePathRemovalProofHooks,
} from './durablePathOperations';

interface DeterministicDetachedRemovalOptions {
  readonly detachedPath: string;
  readonly removalOptions: {
    recursive?: boolean;
    force?: boolean;
    maxRetries?: number;
    retryDelay?: number;
  };
  readonly validateDetached?: DurableDetachedPathValidator;
  readonly proofHooks: DurablePathRemovalProofHooks;
  readonly syncParentDirectory: () => Promise<void>;
}

type DurableDetachedPathValidator = (
  detachedPath: string,
  identity: DurablePathIdentity
) => Promise<boolean>;

function isMissing(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException).code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

/**
 * Reconciles a public-name reservation junction left behind when a process
 * died between publishing the reservation and closing it. Without this, a
 * resumed removal deletes the detached object but leaves the public name
 * pointing at an orphaned reservation directory, so a later same-name create
 * collides with a phantom entry. Only a symlink that provably targets this
 * removal's own `.<name>.replacement.<uuid>` sibling is touched.
 */
export async function reconcileDetachedRemovalPublicReservation(input: {
  readonly targetPath: string;
  readonly parentDirectory: string;
  readonly settleReservation: (reservationPath: string) => Promise<void>;
}): Promise<void> {
  let linkStats: fs.Stats;
  try {
    linkStats = await fs.promises.lstat(input.targetPath);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return;
  }
  if (!linkStats.isSymbolicLink()) return;
  const reservationPrefix = `.${path.basename(input.targetPath)}.replacement.`;
  const resolved = path.resolve(
    input.parentDirectory,
    await fs.promises.readlink(input.targetPath)
  );
  if (
    path.dirname(resolved) !== path.resolve(input.parentDirectory) ||
    !path.basename(resolved).startsWith(reservationPrefix)
  ) {
    return;
  }
  await fs.promises.unlink(input.targetPath);
  await input.settleReservation(resolved);
}

/**
 * Resumes a deterministic proof-backed removal. A target rename can report
 * ENOENT because another finalizer already published this detached artifact;
 * only durable absence after exact validation counts as deleted.
 */
export async function resumeDeterministicDetachedRemoval(
  options: DeterministicDetachedRemovalOptions
): Promise<AtomicPathRemovalResult> {
  let stats: fs.Stats;
  try {
    stats = await fs.promises.lstat(options.detachedPath);
  } catch (error) {
    if (isMissing(error)) return 'missing';
    throw error;
  }

  const identity = getDurablePathIdentity(stats);
  if (
    options.validateDetached &&
    !(await options.validateDetached(options.detachedPath, identity))
  ) {
    return 'changed';
  }
  await options.proofHooks.onDetachedValidated(options.detachedPath, identity);
  try {
    await fs.promises.rm(options.detachedPath, options.removalOptions);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  try {
    await fs.promises.lstat(options.detachedPath);
    return 'changed';
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  await options.syncParentDirectory();
  await options.proofHooks.onRemovalDurable(options.detachedPath, identity);
  return 'deleted';
}
