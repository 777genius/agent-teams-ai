import type {
  HunkDecision,
  ReviewDiskUndoSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export {
  buildForwardDiskMutationSteps,
  buildRedoDiskMutationSteps,
  buildReviewHistoryRestoreDiskImpact,
  buildReviewHistoryRestorePlan,
  buildUndoDiskMutationSteps,
  getReviewActionDiskSnapshots,
} from '@features/review-mutations';

export function getReviewDiskMutationExpectedContent(
  snapshot: ReviewDiskUndoSnapshot,
  direction: 'undo' | 'redo'
): string | null {
  const restoreMode =
    snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
  if (direction === 'undo') {
    return restoreMode === 'delete-file' || restoreMode === 'reapply-rejected-rename'
      ? null
      : snapshot.beforeContent;
  }
  return restoreMode === 'create-file' || restoreMode === 'restore-rejected-rename'
    ? null
    : snapshot.afterContent;
}

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

export function createReviewRedoAction(
  action: ReviewUndoAction,
  state: {
    hunkDecisions: Record<string, HunkDecision>;
    fileDecisions: Record<string, HunkDecision>;
    hunkContextHashesByFile: Record<string, Record<number, string>>;
  }
): ReviewRedoAction {
  return {
    action: structuredClone(action),
    decisionSnapshot: {
      hunkDecisions: { ...state.hunkDecisions },
      fileDecisions: { ...state.fileDecisions },
    },
    hunkContextHashesByFile: structuredClone(state.hunkContextHashesByFile),
  };
}
