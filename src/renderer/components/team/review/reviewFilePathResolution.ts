import { findReviewFileByPath } from '@renderer/utils/reviewKey';

import type { FileChangeSummary } from '@shared/types';

export function resolveReviewFilePath(
  files: readonly Pick<FileChangeSummary, 'filePath'>[],
  requestedPath: string | null | undefined
): string | null {
  if (!requestedPath) return null;
  return findReviewFileByPath(files, requestedPath)?.filePath ?? null;
}
