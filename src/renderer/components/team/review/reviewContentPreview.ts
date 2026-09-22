import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';

import type { FileChangeWithContent, HunkDecision } from '@shared/types';
import type { FileChangeSummary } from '@shared/types/review';

export type ReviewRejectBlockReason =
  | 'missing-on-disk'
  | 'content-unavailable'
  | 'manual-ledger-review'
  | 'baseline-unavailable';

type ReviewContentAvailability = Pick<
  FileChangeWithContent,
  'contentSource' | 'originalFullContent' | 'modifiedFullContent'
>;

export function getEffectiveReviewFileDecision(
  file: FileChangeSummary,
  hunkCount: number,
  hunkDecisions: Record<string, HunkDecision>,
  fileDecision: HunkDecision | undefined
): HunkDecision | undefined {
  if (fileDecision === 'accepted' || fileDecision === 'rejected' || hunkCount === 0) {
    return fileDecision;
  }
  const reviewKey = getFileReviewKey(file);
  const allRejected = Array.from({ length: hunkCount }, (_, index) => {
    return (
      hunkDecisions[buildHunkDecisionKey(reviewKey, index)] ??
      hunkDecisions[buildHunkDecisionKey(file.filePath, index)] ??
      'pending'
    );
  }).every((decision) => decision === 'rejected');
  return allRejected ? 'rejected' : fileDecision;
}

export function hasReviewSnippetText(file: Pick<FileChangeSummary, 'snippets'>): boolean {
  return file.snippets.some(
    (snippet) => !snippet.isError && (snippet.oldString.length > 0 || snippet.newString.length > 0)
  );
}

export function getLastWriteSnippetContent(
  file: Pick<FileChangeSummary, 'snippets'>
): string | null {
  const writeSnippets = file.snippets.filter(
    (snippet) =>
      !snippet.isError && (snippet.type === 'write-new' || snippet.type === 'write-update')
  );
  if (writeSnippets.length === 0) return null;
  return writeSnippets[writeSnippets.length - 1]?.newString ?? null;
}

export function getResolvedReviewModifiedContent(
  file: Pick<FileChangeSummary, 'snippets'>,
  fileContent: Pick<FileChangeWithContent, 'modifiedFullContent'> | null
): string | null {
  return fileContent?.modifiedFullContent ?? getLastWriteSnippetContent(file);
}

export function isReviewFileExpectedDeleted(
  file: Pick<FileChangeSummary, 'ledgerSummary' | 'snippets'> | undefined
): boolean {
  if (!file) return false;
  const latestOperation = file.ledgerSummary?.latestOperation;
  if (latestOperation) return latestOperation === 'delete';
  const finalExists = file.ledgerSummary?.afterState?.exists;
  if (finalExists !== undefined) return !finalExists;
  const ledgerSnippets = file.snippets.filter((snippet) => snippet.ledger && !snippet.isError);
  const lastLedger = ledgerSnippets.at(-1)?.ledger;
  if (lastLedger?.operation) return lastLedger.operation === 'delete';
  if (lastLedger?.afterState?.exists !== undefined) return !lastLedger.afterState.exists;
  return file.ledgerSummary?.deletedInTask === true;
}

export function isReviewFileMissingOnDisk(
  fileContent: Pick<FileChangeWithContent, 'modifiedFullContent'> | null
): boolean {
  return fileContent ? fileContent.modifiedFullContent == null : false;
}

export function isReviewTextContentUnavailable(
  file: Pick<FileChangeSummary, 'snippets'>,
  fileContent: Pick<FileChangeWithContent, 'contentSource' | 'modifiedFullContent'> | null
): boolean {
  return (
    fileContent?.contentSource === 'unavailable' &&
    getResolvedReviewModifiedContent(file, fileContent) === null
  );
}

export function requiresManualLedgerReview(file: Pick<FileChangeSummary, 'snippets'>): boolean {
  return file.snippets.some(
    (snippet) =>
      !!snippet.ledger &&
      (!!snippet.ledger.beforeState?.unavailableReason ||
        !!snippet.ledger.afterState?.unavailableReason) &&
      (snippet.ledger.originalFullContent == null || snippet.ledger.modifiedFullContent == null)
  );
}

export function getReviewRejectBlockReason(
  file: Pick<FileChangeSummary, 'snippets' | 'isNewFile'>,
  fileContent: ReviewContentAvailability | null
): ReviewRejectBlockReason | null {
  if (isReviewFileMissingOnDisk(fileContent)) return 'missing-on-disk';
  if (isReviewTextContentUnavailable(file, fileContent)) return 'content-unavailable';
  if (requiresManualLedgerReview(file)) return 'manual-ledger-review';

  if (!fileContent) {
    return 'baseline-unavailable';
  }

  const modified = getResolvedReviewModifiedContent(file, fileContent);
  if (modified == null) return 'baseline-unavailable';
  if (file.isNewFile) return fileContent.originalFullContent === '' ? null : 'baseline-unavailable';
  return fileContent.originalFullContent == null ? 'baseline-unavailable' : null;
}

export function isReviewRejectable(
  file: Pick<FileChangeSummary, 'snippets' | 'isNewFile'>,
  fileContent: ReviewContentAvailability | null
): boolean {
  return getReviewRejectBlockReason(file, fileContent) === null;
}

export function isReviewAcceptDisabled(input: {
  hasEdits: boolean;
  isMissingOnDisk: boolean;
  isContentUnavailable: boolean;
  fileDecision: HunkDecision | undefined;
}): boolean {
  return (
    input.hasEdits ||
    input.isContentUnavailable ||
    (input.isMissingOnDisk && input.fileDecision !== 'rejected')
  );
}

export function shouldRenderCurrentDiskContextPreview(
  file: Pick<FileChangeSummary, 'snippets' | 'isNewFile'>,
  fileContent: ReviewContentAvailability | null
): boolean {
  return (
    fileContent?.contentSource === 'disk-current' &&
    fileContent.modifiedFullContent != null &&
    getReviewRejectBlockReason(file, fileContent) === 'baseline-unavailable'
  );
}
