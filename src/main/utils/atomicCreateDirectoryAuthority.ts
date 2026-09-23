import * as fs from 'node:fs';

import {
  type AtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryOpenBudget,
} from './atomicCreateCleanupRecoveryIo';
import {
  type DurablePathIdentity,
  getDurablePathIdentity,
  hasTrustworthyDurablePathIdentity,
  isSameDurablePathIdentity,
} from './durablePathIdentity';

export interface AtomicCreateDirectoryAuthority {
  /** Descriptor-rooted pathname, never re-resolved through the public name. */
  stablePath: string;
  identity: DurablePathIdentity;
  /** Detect descriptor replacement or closure before each destructive phase. */
  assertStillOwned: () => Promise<void>;
}

function directoryOpenFlags(): number {
  return (
    fs.constants.O_RDONLY |
    (typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0) |
    (typeof fs.constants.O_DIRECTORY === 'number' ? fs.constants.O_DIRECTORY : 0)
  );
}

/**
 * Bind cleanup to an open parent-directory generation. Linux /proc fd paths
 * keep all later child operations rooted at that generation; platforms without
 * this facility decline cleanup rather than re-authorizing a swapped pathname.
 */
export async function withAtomicCreateDirectoryAuthority<T>(
  directoryPath: string,
  operation: (authority: AtomicCreateDirectoryAuthority) => Promise<T>,
  budget?: AtomicCreateRecoveryBudget
): Promise<T | undefined> {
  if (process.platform !== 'linux') return undefined;

  const handle = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'public-directory-open', () =>
        fs.promises.open(directoryPath, directoryOpenFlags())
      )
    : await fs.promises.open(directoryPath, directoryOpenFlags());
  let result: T | undefined;
  let primaryError: unknown = null;
  let closeAfterPendingStat = false;
  const stat = (): Promise<fs.Stats> =>
    budget
      ? withinAtomicCreateRecoveryBudget(
          budget,
          'public-directory-fstat',
          () => handle.stat(),
          (pending) => {
            closeAfterPendingStat = true;
            void pending.catch(() => undefined).then(() => handle.close().catch(() => undefined));
          }
        )
      : handle.stat();
  try {
    const stats = await stat();
    const identity = getDurablePathIdentity(stats);
    if (!stats.isDirectory() || !hasTrustworthyDurablePathIdentity(identity)) {
      throw new Error('Atomic-create cleanup directory cannot be authenticated');
    }
    const assertStillOwned = async (): Promise<void> => {
      const current = await stat();
      if (
        !current.isDirectory() ||
        !isSameDurablePathIdentity(getDurablePathIdentity(current), identity) ||
        current.birthtimeMs !== identity.birthtimeMs
      ) {
        throw new Error('Atomic-create cleanup directory authority was lost');
      }
    };
    await assertStillOwned();
    result = await operation({
      stablePath: `/proc/self/fd/${handle.fd}/.`,
      identity,
      assertStillOwned,
    });
  } catch (error) {
    primaryError = error;
  }
  try {
    if (!closeAfterPendingStat) await handle.close();
  } catch (closeError) {
    if (primaryError) {
      throw new AggregateError(
        [primaryError, closeError],
        'Atomic-create cleanup directory operation and close both failed'
      );
    }
    throw closeError;
  }
  if (primaryError) throw primaryError instanceof Error ? primaryError : new Error(String(primaryError));
  return result;
}
