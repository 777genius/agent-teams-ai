import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  FileChangeSummary,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewHistoryRestoreTarget,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

export interface ReviewDecisionRecords {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export interface ReviewHistoryRestorePlan {
  direction: 'undo' | 'redo' | 'none';
  actionCount: number;
  orderedActions: ReviewUndoAction[];
  persistedState: ReviewPersistedStateSnapshot;
}

function getFileReviewKey(file: Pick<FileChangeSummary, 'filePath' | 'changeKey'>): string {
  return file.changeKey ?? file.filePath;
}

function buildHunkDecisionKey(reviewKey: string, index: number): string {
  return `${reviewKey}:${index}`;
}

export function restoreReviewDecisionRecordsForFile(
  file: FileChangeSummary,
  current: ReviewDecisionRecords,
  snapshot: ReviewDecisionRecords
): ReviewDecisionRecords {
  const aliases = [getFileReviewKey(file), file.filePath];
  const matchesHunkAlias = (key: string): boolean =>
    aliases.some((alias) => {
      const prefix = `${alias}:`;
      return key.startsWith(prefix) && /^\d+$/.test(key.slice(prefix.length));
    });
  const hunkDecisions = { ...current.hunkDecisions };
  for (const key of Object.keys(hunkDecisions)) {
    if (matchesHunkAlias(key)) delete hunkDecisions[key];
  }
  for (const [key, decision] of Object.entries(snapshot.hunkDecisions)) {
    if (matchesHunkAlias(key)) hunkDecisions[key] = decision;
  }

  const fileDecisions = { ...current.fileDecisions };
  for (const alias of aliases) delete fileDecisions[alias];
  for (const alias of aliases) {
    const decision = snapshot.fileDecisions[alias];
    if (decision) fileDecisions[alias] = decision;
  }
  return { hunkDecisions, fileDecisions };
}

export function restoreReviewDecisionRecordsForFiles(
  files: readonly FileChangeSummary[],
  current: ReviewDecisionRecords,
  snapshot: ReviewDecisionRecords
): ReviewDecisionRecords {
  return files.reduce(
    (restored, file) => restoreReviewDecisionRecordsForFile(file, restored, snapshot),
    current
  );
}

export function partitionReviewFilesByApplyErrors(
  files: readonly FileChangeSummary[],
  errorPaths: readonly string[] | null
): { successful: FileChangeSummary[]; failed: FileChangeSummary[] } {
  if (errorPaths === null) return { successful: [], failed: [...files] };
  const normalizedErrors = new Set(errorPaths.map(normalizePathForComparison));
  const requestedPaths = new Set(files.map((file) => normalizePathForComparison(file.filePath)));
  const hasUnknownError = [...normalizedErrors].some((filePath) => !requestedPaths.has(filePath));
  if (hasUnknownError) {
    return { successful: [], failed: [...files] };
  }
  return {
    successful: files.filter(
      (file) => !normalizedErrors.has(normalizePathForComparison(file.filePath))
    ),
    failed: files.filter((file) => normalizedErrors.has(normalizePathForComparison(file.filePath))),
  };
}

/**
 * Keeps successful decisions while restoring the exact pre-apply records for
 * every failed file. Unknown failures fail closed for the complete request.
 */
export function reconcileReviewDecisionRecordsAfterApply(
  files: readonly FileChangeSummary[],
  errorPaths: readonly string[] | null,
  current: ReviewDecisionRecords,
  snapshot: ReviewDecisionRecords
): ReviewDecisionRecords & {
  successful: FileChangeSummary[];
  failed: FileChangeSummary[];
} {
  const partition = partitionReviewFilesByApplyErrors(files, errorPaths);
  const reconciled = restoreReviewDecisionRecordsForFiles(partition.failed, current, snapshot);
  return { ...partition, ...reconciled };
}

/** Produces the canonical post-Restore decision state for one reviewed file. */
export function buildReviewRestoreDecisionState(
  file: FileChangeSummary,
  current: ReviewDecisionRecords
): ReviewDecisionRecords {
  return restoreReviewDecisionRecordsForFile(file, current, {
    hunkDecisions: {},
    fileDecisions: { [getFileReviewKey(file)]: 'accepted' },
  });
}

/**
 * Derives the only decision state a durable Undo action is allowed to commit.
 * A null result means legacy/corrupt metadata cannot safely describe its inverse.
 */
export function buildReviewUndoDecisionState(
  action: ReviewUndoAction,
  current: ReviewDecisionRecords,
  resolveFile: (filePath: string) => FileChangeSummary | null
): ReviewDecisionSnapshot | null {
  if (action.kind === 'bulk') {
    return {
      hunkDecisions: { ...action.decisionSnapshot.hunkDecisions },
      fileDecisions: { ...action.decisionSnapshot.fileDecisions },
    };
  }

  const filePath =
    action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
  const file = resolveFile(filePath);
  if (!file) return null;

  const originalIndex = action.action.originalIndex;
  if (action.kind === 'hunk' || originalIndex !== undefined) {
    if (originalIndex === undefined) return null;
    const hunkDecisions = { ...current.hunkDecisions };
    delete hunkDecisions[buildHunkDecisionKey(getFileReviewKey(file), originalIndex)];
    return { hunkDecisions, fileDecisions: { ...current.fileDecisions } };
  }

  const decisionSnapshot = action.action.decisionSnapshot;
  if (!decisionSnapshot) return null;
  return restoreReviewDecisionRecordsForFile(file, current, decisionSnapshot);
}

function cloneDecisionSnapshot(snapshot: ReviewDecisionRecords): ReviewDecisionSnapshot {
  return {
    hunkDecisions: { ...snapshot.hunkDecisions },
    fileDecisions: { ...snapshot.fileDecisions },
  };
}

function assertUniqueReviewHistoryIds(current: ReviewPersistedStateSnapshot): void {
  const ids = [
    ...current.reviewActionHistory.map((action) => action.id),
    ...current.reviewRedoHistory.map((entry) => entry.action.id),
  ];
  if (new Set(ids).size !== ids.length) {
    throw new Error('Review history contains duplicate action ids');
  }
}

/**
 * Builds the exact final stacks and decision state for one history jump.
 * A row denotes the checkpoint after that action: Undo keeps the target applied,
 * while Redo replays through the target inclusively.
 */
export function buildReviewHistoryRestorePlan(
  current: ReviewPersistedStateSnapshot,
  target: ReviewHistoryRestoreTarget,
  resolveFile: (filePath: string) => FileChangeSummary | null
): ReviewHistoryRestorePlan {
  assertUniqueReviewHistoryIds(current);
  const undoHistory = current.reviewActionHistory.map((action) => structuredClone(action));
  const redoHistory = current.reviewRedoHistory.map((entry) => structuredClone(entry));
  let hunkDecisions = { ...current.hunkDecisions };
  let fileDecisions = { ...current.fileDecisions };
  let hunkContextHashesByFile = structuredClone(current.hunkContextHashesByFile ?? {});
  let direction: ReviewHistoryRestorePlan['direction'];
  let undoCount = 0;
  let redoCount = 0;

  if (target.kind === 'start') {
    direction = undoHistory.length > 0 ? 'undo' : 'none';
    undoCount = undoHistory.length;
  } else if (target.stack === 'undo') {
    const targetIndex = undoHistory.findIndex((action) => action.id === target.actionId);
    if (targetIndex < 0) throw new Error('The selected Undo checkpoint is no longer available');
    undoCount = undoHistory.length - targetIndex - 1;
    direction = undoCount > 0 ? 'undo' : 'none';
  } else {
    const targetIndex = redoHistory.findIndex((entry) => entry.action.id === target.actionId);
    if (targetIndex < 0) throw new Error('The selected Redo checkpoint is no longer available');
    redoCount = redoHistory.length - targetIndex;
    direction = redoCount > 0 ? 'redo' : 'none';
  }

  const orderedActions: ReviewUndoAction[] = [];
  for (let index = 0; index < undoCount; index++) {
    const action = undoHistory.at(-1);
    if (!action) throw new Error('Review Undo history changed while building the restore plan');
    const nextDecisions = buildReviewUndoDecisionState(
      action,
      { hunkDecisions, fileDecisions },
      resolveFile
    );
    if (!nextDecisions) {
      throw new Error('The selected history range cannot be restored safely');
    }
    const redoEntry: ReviewRedoAction = {
      action: structuredClone(action),
      decisionSnapshot: cloneDecisionSnapshot({ hunkDecisions, fileDecisions }),
      hunkContextHashesByFile: structuredClone(hunkContextHashesByFile),
    };
    undoHistory.pop();
    redoHistory.push(redoEntry);
    orderedActions.push(action);
    hunkDecisions = nextDecisions.hunkDecisions;
    fileDecisions = nextDecisions.fileDecisions;
  }

  for (let index = 0; index < redoCount; index++) {
    const entry = redoHistory.at(-1);
    if (!entry) throw new Error('Review Redo history changed while building the restore plan');
    redoHistory.pop();
    undoHistory.push(structuredClone(entry.action));
    orderedActions.push(entry.action);
    hunkDecisions = { ...entry.decisionSnapshot.hunkDecisions };
    fileDecisions = { ...entry.decisionSnapshot.fileDecisions };
    hunkContextHashesByFile = structuredClone(
      entry.hunkContextHashesByFile ?? hunkContextHashesByFile
    );
  }

  return {
    direction,
    actionCount: orderedActions.length,
    orderedActions,
    persistedState: {
      hunkDecisions,
      fileDecisions,
      hunkContextHashesByFile,
      reviewActionHistory: undoHistory,
      reviewRedoHistory: redoHistory,
    },
  };
}

function reviewActionTouchesFile(action: ReviewUndoAction, filePath: string): boolean {
  if (action.kind === 'bulk') return true;
  const actionPath =
    action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
  return normalizePathForComparison(actionPath) === normalizePathForComparison(filePath);
}

/**
 * Canonical state after the user explicitly reloads a file changed outside Changes.
 * Redo is scope-wide because every entry contains a full decision snapshot, while a
 * bulk action cannot be split safely. Independent per-file Undo actions are retained.
 */
export function buildReviewExternalReloadState(
  file: FileChangeSummary,
  current: ReviewPersistedStateSnapshot
): ReviewPersistedStateSnapshot {
  const decisions = restoreReviewDecisionRecordsForFile(file, current, {
    hunkDecisions: {},
    fileDecisions: {},
  });
  const hasBulkHistory =
    current.reviewActionHistory.some((action) => action.kind === 'bulk') ||
    current.reviewRedoHistory.some((entry) => entry.action.kind === 'bulk');
  const reviewActionHistory = hasBulkHistory
    ? []
    : current.reviewActionHistory.filter(
        (action) => !reviewActionTouchesFile(action, file.filePath)
      );
  const hunkContextHashesByFile = { ...(current.hunkContextHashesByFile ?? {}) };
  delete hunkContextHashesByFile[getFileReviewKey(file)];
  delete hunkContextHashesByFile[file.filePath];

  return {
    ...decisions,
    hunkContextHashesByFile,
    reviewActionHistory,
    reviewRedoHistory: [],
  };
}
