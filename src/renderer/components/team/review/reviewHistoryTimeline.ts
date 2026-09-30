import { getReviewDiskMutationExpectedContent } from '@features/change-review/renderer';

import type { ReviewDiskUndoSnapshot } from '@shared/types';

export type { ReviewHistoryRecoveryDisposition } from '@features/change-review/renderer';
export {
  areReviewPersistedStatesEqual,
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  getReviewDiskMutationExpectedContent,
  markChangeReviewMutationDiskPostimages as markReviewMutationDiskPostimages,
} from '@features/change-review/renderer';
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
