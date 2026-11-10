import { findReviewFileByPath, normalizeReviewPathForIdentity } from '@renderer/utils/reviewKey';

import type { FileChangeSummary, ReviewUndoAction } from '@shared/types';

/** Keep case-distinct paths separate, even on Windows. */
export function getReviewPhysicalPathEntries(
  files: readonly FileChangeSummary[],
  filePath: string
): FileChangeSummary[] {
  const path = normalizeReviewPathForIdentity(filePath);
  return files.filter((file) => normalizeReviewPathForIdentity(file.filePath) === path);
}

/** Durable history must name the exact lifecycle entry when a disk path has siblings. */
export function resolveReviewHistoryActionFile(
  files: readonly FileChangeSummary[],
  filePath: string,
  action: ReviewUndoAction
): FileChangeSummary | null {
  const persisted = action.kind === 'disk' ? [action.action.file, action.action.snapshot.file] : [];
  const keys = new Set(persisted.flatMap((file) => (file?.changeKey ? [file.changeKey] : [])));
  if (keys.size > 1) return null;
  const candidates = getReviewPhysicalPathEntries(files, filePath);
  const key = [...keys][0];
  const matches = key
    ? candidates.filter((file) => file.changeKey === key)
    : candidates.length === 1
      ? candidates
      : [];
  if (matches.length !== 1) return null;
  const selected = matches[0];
  return persisted.every(
    (file) =>
      !file ||
      (normalizeReviewPathForIdentity(file.filePath) ===
        normalizeReviewPathForIdentity(selected.filePath) &&
        (file.changeKey === undefined || file.changeKey === selected.changeKey))
  )
    ? selected
    : null;
}

/** Editor slots use entry keys while manual drafts are stored by the disk path. */
export function hasReviewDraftForEntry(
  files: FileChangeSummary[],
  editedContents: Readonly<Record<string, string>>,
  entryKey: string
): boolean {
  const diskPath = findReviewFileByPath(files, entryKey)?.filePath;
  return diskPath !== undefined && diskPath in editedContents;
}
