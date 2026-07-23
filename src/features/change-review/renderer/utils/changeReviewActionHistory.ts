import { normalizePathForComparison } from '@shared/utils/platformPath';

import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

export type ReviewActionPersistenceStatus = 'saved' | 'saving' | 'error';

export function isReviewActionPersistenceBlocking(status: ReviewActionPersistenceStatus): boolean {
  return status !== 'saved';
}

export type ReviewUndoActionInput =
  | Omit<Extract<ReviewUndoAction, { kind: 'bulk' }>, 'id' | 'createdAt'>
  | Omit<Extract<ReviewUndoAction, { kind: 'disk' }>, 'id' | 'createdAt'>
  | Omit<Extract<ReviewUndoAction, { kind: 'hunk' }>, 'id' | 'createdAt'>;

let reviewActionIdSequence = 0;

export function createReviewUndoAction(input: ReviewUndoActionInput): ReviewUndoAction {
  reviewActionIdSequence += 1;
  const randomId = globalThis.crypto?.randomUUID?.();
  return {
    ...input,
    id: randomId ?? `${Date.now().toString(36)}-${reviewActionIdSequence.toString(36)}`,
    createdAt: new Date().toISOString(),
  } as ReviewUndoAction;
}

export function appendOrderedReviewAction<T>(
  stack: readonly T[],
  action: T,
  _legacyMaxDepth?: number
): T[] {
  return [...stack, action];
}

export function popOrderedReviewAction<T>(
  stack: readonly T[],
  expected: T
): { stack: T[]; popped: boolean } {
  if (stack.at(-1) !== expected) return { stack: [...stack], popped: false };
  return { stack: stack.slice(0, -1), popped: true };
}

export function replaceLatestReviewAction(
  stack: readonly ReviewUndoAction[],
  optimistic: ReviewUndoAction,
  committed: ReviewUndoAction
): { stack: ReviewUndoAction[]; replaced: boolean } {
  if (optimistic.id !== committed.id || stack.at(-1)?.id !== optimistic.id) {
    return { stack: [...stack], replaced: false };
  }
  return { stack: [...stack.slice(0, -1), committed], replaced: true };
}

export function filterReviewActionHistoryForFile(input: {
  undoHistory: readonly ReviewUndoAction[];
  redoHistory: readonly ReviewRedoAction[];
  filePath: string;
}): { clearAll: boolean; undoHistory: ReviewUndoAction[]; redoHistory: ReviewRedoAction[] } {
  if (
    input.undoHistory.some((action) => action.kind === 'bulk') ||
    input.redoHistory.some((entry) => entry.action.kind === 'bulk')
  ) {
    return { clearAll: true, undoHistory: [], redoHistory: [] };
  }
  const normalizedPath = normalizePathForComparison(input.filePath);
  const undoHistory = input.undoHistory.filter((action) => {
    const actionPath =
      action.kind === 'disk'
        ? action.action.snapshot.filePath
        : action.kind === 'hunk'
          ? action.action.filePath
          : null;
    return actionPath === null || normalizePathForComparison(actionPath) !== normalizedPath;
  });
  // Redo entries contain full-scope post-action snapshots. Retaining even an
  // apparently unrelated entry could replay stale decisions for this file.
  return { clearAll: false, undoHistory, redoHistory: [] };
}
