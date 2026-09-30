import { useMemo } from 'react';

import { resolveChangeReviewFileHunkCount } from '@features/change-review';
import {
  getFileReviewKey,
  getReviewEntryKey,
  hasDuplicateReviewFilePaths,
} from '@renderer/utils/reviewKey';

import { isReviewFileFullyRejected } from './reviewActionState';
import {
  isReviewAcceptDisabled,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
  isReviewTextContentUnavailable,
} from './reviewContentPreview';

import type { FileChangeSummary, FileChangeWithContent, HunkDecision } from '@shared/types';

interface UseChangeReviewActionAvailabilityInput {
  files: readonly FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  editedContents: Readonly<Record<string, string>>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  fileChunkCounts: Record<string, number>;
}

interface ChangeReviewActionAvailability {
  rejectableFiles: FileChangeSummary[];
  canAcceptAll: boolean;
  canRejectAll: boolean;
}

export function useChangeReviewActionAvailability({
  files,
  fileContents,
  editedContents,
  hunkDecisions,
  fileDecisions,
  fileChunkCounts,
}: UseChangeReviewActionAvailabilityInput): ChangeReviewActionAvailability {
  const rejectableFiles = useMemo(
    () =>
      files.filter((file) => {
        const reviewKey = getFileReviewKey(file);
        const fileDecision = fileDecisions[reviewKey] ?? fileDecisions[file.filePath] ?? 'pending';
        if (fileDecision !== 'pending' || file.filePath in editedContents) return false;
        const count = resolveChangeReviewFileHunkCount(
          getReviewEntryKey(files, file),
          file.snippets.length,
          fileChunkCounts
        );
        if (isReviewFileFullyRejected(file, count, { hunkDecisions, fileDecisions })) return false;
        return isReviewRejectable(file, fileContents[getReviewEntryKey(files, file)] ?? null);
      }),
    [editedContents, fileChunkCounts, fileContents, fileDecisions, files, hunkDecisions]
  );
  const canAcceptAll = useMemo(
    () =>
      files.length > 0 &&
      !hasDuplicateReviewFilePaths(files) &&
      files.every((file) => {
        const entryKey = getReviewEntryKey(files, file);
        if (!(entryKey in fileContents) || file.filePath in editedContents) return false;
        const content = fileContents[entryKey] ?? null;
        const reviewKey = getFileReviewKey(file);
        const fileDecision = fileDecisions[reviewKey] ?? fileDecisions[file.filePath];
        return !isReviewAcceptDisabled({
          hasEdits: false,
          isMissingOnDisk: isReviewFileMissingOnDisk(content),
          isContentUnavailable: isReviewTextContentUnavailable(file, content),
          fileDecision,
        });
      }),
    [editedContents, fileContents, fileDecisions, files]
  );

  return {
    rejectableFiles,
    canAcceptAll,
    canRejectAll: rejectableFiles.length > 0 && !hasDuplicateReviewFilePaths(files),
  };
}
