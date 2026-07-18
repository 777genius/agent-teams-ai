import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  FileChangeSummary,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewPersistedStateSnapshot,
  ReviewUndoAction,
} from '@shared/types';

export interface ReviewDecisionRecords {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
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

  const filePath = action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
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
