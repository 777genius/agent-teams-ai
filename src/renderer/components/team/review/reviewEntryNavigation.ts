import { getFileHunkCount } from '@renderer/store/slices/changeReviewSlice';
import {
  findReviewFileByPath,
  getReviewEntryKey,
  normalizeReviewPathForIdentity,
} from '@renderer/utils/reviewKey';

import type { FileChangeSummary } from '@shared/types';

/** Section and editor keys must distinguish lifecycle entries sharing a disk path. */
export function getReviewNavigationFiles(files: FileChangeSummary[]): FileChangeSummary[] {
  return files.map((file) => ({ ...file, filePath: getReviewEntryKey(files, file) }));
}

export function getReviewFileLabels(files: FileChangeSummary[]): Map<string, string> {
  return new Map(
    files.map((file) => [
      normalizeReviewPathForIdentity(file.filePath),
      file.relativePath || file.filePath,
    ])
  );
}

export function getReviewDiskPath(files: FileChangeSummary[], entryKey: string): string | null {
  return findReviewFileByPath(files, entryKey)?.filePath ?? null;
}

/** Hunk decisions still target a disk path, so duplicate destinations are unsafe. */
export function canMutateReviewHunk(files: FileChangeSummary[], filePath: string): boolean {
  const path = normalizeReviewPathForIdentity(filePath);
  return (
    files.filter((file) => normalizeReviewPathForIdentity(file.filePath) === path).length === 1
  );
}

export function getReviewHunkOrder(
  files: FileChangeSummary[],
  fileChunkCounts: Record<string, number>
): { offsets: Record<string, number>; total: number } {
  const offsets: Record<string, number> = {};
  let total = 0;
  for (const file of files) {
    const entryKey = getReviewEntryKey(files, file);
    offsets[entryKey] = total;
    total += getFileHunkCount(entryKey, file.snippets.length, fileChunkCounts);
  }
  return { offsets, total };
}
