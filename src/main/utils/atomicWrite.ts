import { atomicWriteSync as writeSync } from '@agent-teams/legacy-agent-host/lifecycle';
import {
  atomicWriteAsync as writeAsync,
  type AtomicWriteOptions,
} from '@agent-teams/task-change-ledger/review-io';
import {
  beginOriginalRuntimeSourceWrite,
  readOriginalRuntimeScope,
} from '@main/services/runtime/OriginalRuntimeScope';

export * from './durablePathOperations';
export { renamePathWithRetrySync } from '@agent-teams/legacy-agent-host/lifecycle';
export type {
  AtomicCreateResult,
  ExpectedTextFileIdentity,
  ReviewFileTransactionDescriptor,
  ReviewFileTransactionKind,
} from '@agent-teams/task-change-ledger/review-io';
export type { AtomicWriteOptions } from '@agent-teams/task-change-ledger/review-io';
export {
  atomicCreateAsync,
  cleanupAtomicCreateTempLinks,
  executeReviewFileTransaction,
  finalizePreparedReviewFileTransaction,
  finalizeReviewFileTransaction,
  inspectReviewFileTransaction,
  isOwnedReviewFileTransactionHardlink,
  prepareReviewFileTransaction,
  resumePreparedReviewFileTransaction,
} from '@agent-teams/task-change-ledger/review-io';
export {
  renamePathWithRetry,
  syncDirectoryDurably,
  unlinkPathDurably,
} from '@agent-teams/task-change-ledger/review-io';

export async function atomicWriteAsync(
  targetPath: string,
  data: string | Buffer,
  options: AtomicWriteOptions = {}
): Promise<void> {
  const witness = beginOriginalRuntimeSourceWrite(targetPath, data);
  if (!witness) return writeAsync(targetPath, data, options);
  let success = false;
  try {
    await writeAsync(targetPath, data, {
      ...options,
      assertCurrent() {
        options.assertCurrent?.();
        readOriginalRuntimeScope();
        witness.beforeCommit();
      },
      async beforeCommit() {
        await options.beforeCommit?.();
        readOriginalRuntimeScope();
        witness.beforeCommit();
      },
    });
    success = true;
  } finally {
    witness.finish(success);
  }
}

export function atomicWriteSync(
  targetPath: string,
  data: string | Buffer,
  options: { mode?: number } = {}
): void {
  const witness = beginOriginalRuntimeSourceWrite(targetPath, data);
  if (!witness) return writeSync(targetPath, data, options);
  let success = false;
  try {
    witness.beforeCommit();
    writeSync(targetPath, data, options);
    success = true;
  } finally {
    witness.finish(success);
  }
}
