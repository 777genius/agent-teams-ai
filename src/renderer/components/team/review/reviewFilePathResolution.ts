import { findReviewFileByPath, getReviewEntryKey } from '@renderer/utils/reviewKey';

import type { FileChangeSummary } from '@shared/types';

export function resolveReviewFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath' | 'changeKey'>[],
  requestedPath: string | null | undefined
): string | null {
  if (!requestedPath) return null;
  const file = findReviewFileByPath(files, requestedPath);
  return file ? getReviewEntryKey(files, file) : null;
}
