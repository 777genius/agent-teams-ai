import { getReviewDiskMutationExpectedContent } from '@features/change-review/renderer';

import type { ReviewDiskUndoSnapshot, ReviewMutationDiskPostimage } from '@shared/types';

export type { ReviewHistoryRecoveryDisposition } from '@features/change-review/renderer';
export {
  areReviewPersistedStatesEqual,
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  getReviewDiskMutationExpectedContent,
} from '@features/change-review/renderer';

export function markReviewMutationDiskPostimages(
  postimages: readonly ReviewMutationDiskPostimage[] | undefined,
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void
): void {
  for (const postimage of postimages ?? []) {
    markExpectedWrite(postimage.filePath, postimage.content);
  }
}

export {
  buildForwardDiskMutationSteps,
  buildRedoDiskMutationSteps,
  buildReviewHistoryRestoreDiskImpact,
  buildReviewHistoryRestoreDiskSteps,
  buildReviewHistoryRestorePlan,
  buildUndoDiskMutationSteps,
  getReviewActionDiskSnapshots,
} from '@features/review-mutations';

export async function executeWithPreparedReviewWriteExpectations<T>(
  snapshots: readonly ReviewDiskUndoSnapshot[],
  direction: 'undo' | 'redo',
  markExpectedWrite: (filePath: string, expectedContent: string | null) => void,
  execute: () => Promise<T>
): Promise<T> {
  for (const snapshot of snapshots) {
    markExpectedWrite(snapshot.filePath, getReviewDiskMutationExpectedContent(snapshot, direction));
  }
  return execute();
}
