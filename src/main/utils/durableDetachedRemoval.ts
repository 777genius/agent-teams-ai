import * as fs from 'node:fs';

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
