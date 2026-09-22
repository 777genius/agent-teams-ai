import { isWindowsishPath, normalizePathForComparison } from '@shared/utils/platformPath';

import type { FileChangeSummary } from '@shared/types';

export function resolveReviewFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath'>[],
  requestedPath: string | null | undefined
): string | null {
  if (!requestedPath) return null;
  return files.find((file) => reviewFilePathsEqual(file.filePath, requestedPath))?.filePath ?? null;
}

function reviewFilePathsEqual(left: string, right: string): boolean {
  const caseInsensitive = isWindowsReviewPath(left) || isWindowsReviewPath(right);
  return (
    normalizeReviewPathForComparison(left, caseInsensitive) ===
    normalizeReviewPathForComparison(right, caseInsensitive)
  );
}

function normalizeReviewPathForComparison(filePath: string, caseInsensitive: boolean): string {
  const normalized = normalizePathForComparison(filePath);
  return caseInsensitive ? normalized.toLowerCase() : normalized;
}

function isWindowsReviewPath(filePath: string): boolean {
  return isWindowsishPath(filePath) || filePath.includes('\\');
}
