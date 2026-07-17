import type {
  HunkDecision,
  ReviewDirectDiskMutationStep,
  ReviewDiskUndoSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export function buildUndoDiskMutationSteps(
  actionId: string,
  snapshots: readonly ReviewDiskUndoSnapshot[]
): ReviewDirectDiskMutationStep[] {
  return snapshots.map((snapshot, index) => {
    if (snapshot.restoreConflict) throw new Error(snapshot.restoreConflict);
    const id = `${actionId}:${index}`;
    const restoreMode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
    if (restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename') {
      if (!snapshot.renameExpectation) {
        throw new Error('Rename recovery metadata is unavailable; refusing an unsafe Undo.');
      }
      return {
        id,
        type: restoreMode,
        filePath: snapshot.filePath,
        expectation: snapshot.renameExpectation,
      };
    }
    if (restoreMode === 'delete-file') {
      if (snapshot.afterContent === null) {
        throw new Error('Undo delete snapshot is missing the expected file content.');
      }
      return {
        id,
        type: 'delete',
        filePath: snapshot.filePath,
        expectedContent: snapshot.afterContent,
      };
    }
    if (restoreMode === 'create-file') {
      return {
        id,
        type: 'write',
        filePath: snapshot.filePath,
        expectedContent: null,
        content: snapshot.beforeContent,
      };
    }
    if (snapshot.afterContent === null) {
      throw new Error('Undo snapshot is missing the expected disk postimage.');
    }
    return {
      id,
      type: 'write',
      filePath: snapshot.filePath,
      expectedContent: snapshot.afterContent,
      content: snapshot.beforeContent,
    };
  });
}

export function buildRedoDiskMutationSteps(
  actionId: string,
  snapshots: readonly ReviewDiskUndoSnapshot[]
): ReviewDirectDiskMutationStep[] {
  return snapshots.map((snapshot, index) => {
    if (snapshot.restoreConflict) throw new Error(snapshot.restoreConflict);
    const id = `${actionId}:redo:${index}`;
    const restoreMode =
      snapshot.restoreMode ?? (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
    if (restoreMode === 'restore-rejected-rename' || restoreMode === 'reapply-rejected-rename') {
      if (!snapshot.renameExpectation) {
        throw new Error('Rename recovery metadata is unavailable; refusing an unsafe Redo.');
      }
      return {
        id,
        type:
          restoreMode === 'restore-rejected-rename'
            ? 'reapply-rejected-rename'
            : 'restore-rejected-rename',
        filePath: snapshot.filePath,
        expectation: snapshot.renameExpectation,
      };
    }
    if (restoreMode === 'create-file') {
      return {
        id,
        type: 'delete',
        filePath: snapshot.filePath,
        expectedContent: snapshot.beforeContent,
      };
    }
    if (restoreMode === 'delete-file') {
      if (snapshot.afterContent === null) {
        throw new Error('Redo create snapshot is missing the expected file content.');
      }
      return {
        id,
        type: 'write',
        filePath: snapshot.filePath,
        expectedContent: null,
        content: snapshot.afterContent,
      };
    }
    if (snapshot.afterContent === null) {
      throw new Error('Redo snapshot is missing the expected disk postimage.');
    }
    return {
      id,
      type: 'write',
      filePath: snapshot.filePath,
      expectedContent: snapshot.beforeContent,
      content: snapshot.afterContent,
    };
  });
}

export function getReviewActionDiskSnapshots(action: ReviewUndoAction): ReviewDiskUndoSnapshot[] {
  if (action.kind === 'bulk') return action.diskSnapshots;
  if (action.kind === 'disk') return [action.action.snapshot];
  return [];
}

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
