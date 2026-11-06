import type { ApplyReviewDiskTransition } from '../../contracts.js';
import type { ReviewFileTransactionDescriptor } from '../io/index.js';

/** Exact captured transition identity; never reconstruct a preimage from a ledger or current bytes. */
export function getReviewFileTransactionFromTransition(
  transition: ApplyReviewDiskTransition
): ReviewFileTransactionDescriptor | null {
  const { operation, transactionId, beforeContent, afterContent } = transition;
  if (!operation || !transactionId || beforeContent === null) return null;
  if (operation === 'move') {
    if (!transition.relatedFilePath || afterContent === null) return null;
    return {
      id: transactionId,
      kind: 'move',
      sourcePath: transition.filePath,
      targetPath: transition.relatedFilePath,
      expectedContent: beforeContent,
      nextContent: afterContent,
    };
  }
  return {
    id: transactionId,
    kind: operation,
    sourcePath: transition.filePath,
    targetPath: transition.filePath,
    expectedContent: beforeContent,
    nextContent: operation === 'delete' ? null : afterContent,
  };
}
