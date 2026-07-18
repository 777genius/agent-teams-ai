import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ReviewDirectDiskMutationStep,
  ReviewDiskUndoSnapshot,
  ReviewUndoAction,
} from '@shared/types';

interface ReviewHistoryDiskAction {
  direction: 'undo' | 'redo';
  action: ReviewUndoAction;
}

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

/**
 * Builds the original forward Restore/Rename transition from the same durable
 * snapshot Redo uses. Only the journal step identity differs from a Redo.
 */
export function buildForwardDiskMutationSteps(
  actionId: string,
  snapshots: readonly ReviewDiskUndoSnapshot[]
): ReviewDirectDiskMutationStep[] {
  return buildRedoDiskMutationSteps(actionId, snapshots).map((step, index) => ({
    ...step,
    id: `${actionId}:${index}`,
  }));
}

export function getReviewActionDiskSnapshots(action: ReviewUndoAction): ReviewDiskUndoSnapshot[] {
  if (action.kind === 'bulk') return action.diskSnapshots;
  if (action.kind === 'disk') return [action.action.snapshot];
  return [];
}

/**
 * Collapses a history range into one current-to-target CAS transition per path.
 * This is required when several actions touch the same file: concatenating their
 * individual Undo steps would preflight every intermediate state against the same disk image.
 */
export function buildReviewHistoryRestoreDiskSteps(
  actions: readonly ReviewHistoryDiskAction[]
): ReviewDirectDiskMutationStep[] {
  const logicalSteps = actions.flatMap(({ action, direction }) => {
    const snapshots = getReviewActionDiskSnapshots(action);
    return direction === 'undo'
      ? buildUndoDiskMutationSteps(action.id, snapshots)
      : buildRedoDiskMutationSteps(action.id, snapshots);
  });
  const renameSteps = logicalSteps.filter(
    (step) => step.type === 'restore-rejected-rename' || step.type === 'reapply-rejected-rename'
  );
  if (renameSteps.length > 0) {
    if (logicalSteps.length !== 1) {
      throw new Error(
        'History ranges that combine Rename with other disk changes must be restored one action at a time.'
      );
    }
    return logicalSteps;
  }

  const byPath = new Map<string, { filePath: string; steps: ReviewDirectDiskMutationStep[] }>();
  for (const step of logicalSteps) {
    const key = normalizePathForComparison(step.filePath);
    const existing = byPath.get(key) ?? { filePath: step.filePath, steps: [] };
    existing.steps.push(step);
    byPath.set(key, existing);
  }

  const netSteps: ReviewDirectDiskMutationStep[] = [];
  let index = 0;
  for (const { filePath, steps } of byPath.values()) {
    const first = steps[0];
    if (!first || (first.type !== 'write' && first.type !== 'delete')) continue;
    const initialContent = first.expectedContent;
    let targetContent: string | null = first.type === 'write' ? first.content : null;
    for (const step of steps.slice(1)) {
      if (step.type !== 'write' && step.type !== 'delete') {
        throw new Error('Unsupported Rename transition in a composed history range');
      }
      if (step.expectedContent !== targetContent) {
        throw new Error('Review history disk snapshots do not form one continuous transition');
      }
      targetContent = step.type === 'write' ? step.content : null;
    }
    if (initialContent === targetContent) continue;
    const id = `history-restore:${index++}`;
    if (targetContent === null) {
      if (initialContent !== null) {
        netSteps.push({ id, type: 'delete', filePath, expectedContent: initialContent });
      }
    } else {
      netSteps.push({
        id,
        type: 'write',
        filePath,
        expectedContent: initialContent,
        content: targetContent,
      });
    }
  }
  return netSteps;
}
