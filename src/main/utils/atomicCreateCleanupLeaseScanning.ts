import * as fs from 'fs';

import {
  type AtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryBudget,
  withinAtomicCreateRecoveryOpenBudget,
} from './atomicCreateCleanupRecoveryIo';

/** Enumerate at most one more lease than capacity so overload fails closed. */
export async function boundedLeaseDirectories(
  directoryPath: string,
  prefixes: readonly string[],
  capacity: number,
  budget?: AtomicCreateRecoveryBudget
): Promise<string[]> {
  const directory = budget
    ? await withinAtomicCreateRecoveryOpenBudget(budget, 'lease-directory-open', () =>
        fs.promises.opendir(directoryPath)
      )
    : await fs.promises.opendir(directoryPath);
  const names: string[] = [];
  let closeAfterPendingRead = false;
  try {
    while (true) {
      const entry = budget
        ? await withinAtomicCreateRecoveryBudget(
            budget,
            'lease-directory-read',
            () => directory.read(),
            (pending) => {
              closeAfterPendingRead = true;
              void pending
                .catch(() => undefined)
                .then(() => directory.close().catch(() => undefined));
            }
          )
        : await directory.read();
      if (!entry) break;
      if (!entry.isDirectory() || !prefixes.some((prefix) => entry.name.startsWith(prefix)))
        continue;
      names.push(entry.name);
      if (names.length > capacity) break;
    }
  } finally {
    if (!closeAfterPendingRead) await directory.close().catch(() => undefined);
  }
  return names;
}
