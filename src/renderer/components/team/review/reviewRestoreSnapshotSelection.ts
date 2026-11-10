import { getReviewEntryKey, normalizeReviewPathForIdentity } from '@renderer/utils/reviewKey';

import type {
  FileChangeSummary,
  ReviewDiskUndoAction,
  ReviewDiskUndoSnapshot,
} from '@shared/types';

export function selectReviewRestoreSnapshots(
  files: readonly FileChangeSummary[],
  selectedFile: FileChangeSummary,
  diskHistory: readonly ReviewDiskUndoAction[]
): {
  latestDiskSnapshot: ReviewDiskUndoSnapshot | undefined;
  sessionSnapshot: ReviewDiskUndoSnapshot | undefined;
} {
  const path = normalizeReviewPathForIdentity(selectedFile.filePath);
  const hasPathSibling =
    files.filter((file) => normalizeReviewPathForIdentity(file.filePath) === path).length > 1;
  const selectedEntryKey = getReviewEntryKey(files, selectedFile);
  const matches = (action: ReviewDiskUndoAction): boolean => {
    const snapshot = action.snapshot;
    if (normalizeReviewPathForIdentity(snapshot.filePath) !== path) return false;
    if (snapshot.file && normalizeReviewPathForIdentity(snapshot.file.filePath) !== path) {
      return false;
    }
    if (action.file && normalizeReviewPathForIdentity(action.file.filePath) !== path) return false;
    const snapshotKey = snapshot.file?.changeKey;
    const actionKey = action.file?.changeKey;
    if (snapshotKey !== undefined && actionKey !== undefined && snapshotKey !== actionKey) {
      return false;
    }
    const persistedKey = snapshotKey ?? actionKey;
    if (hasPathSibling) return persistedKey === selectedEntryKey;
    return !persistedKey || !selectedFile.changeKey || persistedKey === selectedFile.changeKey;
  };
  const matching = diskHistory.filter(matches);
  return {
    latestDiskSnapshot: matching.at(-1)?.snapshot,
    sessionSnapshot: matching.findLast((action) => action.originalIndex === undefined)?.snapshot,
  };
}
