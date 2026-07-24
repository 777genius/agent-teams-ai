import {
  partitionReviewFilesByApplyErrors,
  reconcileReviewDecisionRecordsAfterApply,
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
} from '@features/review-mutations';
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import {
  getEffectiveReviewFileDecision,
  isReviewFileExpectedDeleted,
} from './reviewContentPreview';

import type { ReviewActionPersistenceStatus } from '@features/change-review/renderer';
import type {
  ConflictCheckResult,
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  ReviewRenameRecoveryExpectation,
} from '@shared/types';

export type { ReviewOperationScopeToken } from '@features/change-review/renderer';
export type { ReviewConflictCandidateSelection } from '@features/change-review/renderer';
export type { ReviewActionPersistenceStatus } from '@features/change-review/renderer';
export {
  createReviewOperationScopeToken,
  getReviewDecisionHydrationGuard,
  isReviewOperationScopeCurrent,
  selectLatestReviewConflictCandidate,
} from '@features/change-review/renderer';

export interface ReviewDecisionRecords {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export function shouldRequestReviewCloseForEscape(input: {
  key: string;
  defaultPrevented: boolean;
  hasOpenModalLayer: boolean;
}): boolean {
  return input.key === 'Escape' && !input.defaultPrevented && !input.hasOpenModalLayer;
}

export function replaceReviewScopedRecord<T>(
  current: Readonly<Record<string, T>>,
  scopeFilePaths: Iterable<string>,
  recovered: Readonly<Record<string, T>>
): Record<string, T> {
  const normalizedScopePaths = new Set(
    [...scopeFilePaths].map((filePath) => normalizePathForComparison(filePath))
  );
  const next = { ...current };
  for (const filePath of Object.keys(next)) {
    if (normalizedScopePaths.has(normalizePathForComparison(filePath))) {
      delete next[filePath];
    }
  }
  return { ...next, ...recovered };
}

export {
  partitionReviewFilesByApplyErrors,
  reconcileReviewDecisionRecordsAfterApply,
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
};

export function isReviewActionLocked(state: {
  applying: boolean;
  fileApplyCount: number;
  undoing: boolean;
  closing: boolean;
}): boolean {
  return state.applying || state.fileApplyCount > 0 || state.undoing || state.closing;
}

/** True when a retried Undo finds that its guarded disk preimage was already restored. */
export function isReviewDiskPreimageRestored(
  conflict: ConflictCheckResult,
  expectedContent: string | null
): boolean {
  return expectedContent === null
    ? conflict.hasConflict && conflict.conflictContent === null
    : !conflict.hasConflict;
}

export function getReviewCloseBlockReason(input: {
  busy: boolean;
  draftCount: number;
}): string | null {
  if (input.busy) return 'Wait for the current review action to finish.';
  if (input.draftCount > 0) return 'Save or discard manual edits before closing Changes.';
  return null;
}

export function hasUnscopedLocalReviewState(input: {
  editedContentCount: number;
  hunkDecisionCount: number;
  fileDecisionCount: number;
  undoHistoryCount: number;
  redoHistoryCount: number;
  pendingDraftWriteCount: number;
  draftWriteChainCount: number;
  draftWriteErrorCount: number;
  pendingApplyCleanup: boolean;
  pendingDecisionClear: boolean;
  persistenceStatus: ReviewActionPersistenceStatus;
}): boolean {
  return (
    input.editedContentCount > 0 ||
    input.hunkDecisionCount > 0 ||
    input.fileDecisionCount > 0 ||
    input.undoHistoryCount > 0 ||
    input.redoHistoryCount > 0 ||
    input.pendingDraftWriteCount > 0 ||
    input.draftWriteChainCount > 0 ||
    input.draftWriteErrorCount > 0 ||
    input.pendingApplyCleanup ||
    input.pendingDecisionClear ||
    input.persistenceStatus !== 'saved'
  );
}

/** A draft that survives an async Save must rebase onto the bytes that Save published. */
export function resolveDraftBaselineAfterSave(
  savedContent: string,
  remainingDraft: string | undefined
): string | undefined {
  return remainingDraft === undefined ? undefined : savedContent;
}

export function resolveReviewFileIsNew(
  file: FileChangeSummary,
  content: FileChangeWithContent | null | undefined
): boolean {
  return content?.isNewFile ?? file.isNewFile;
}

export function hasReviewFileRejections(
  file: FileChangeSummary,
  hunkCount: number,
  decisions: ReviewDecisionRecords
): boolean {
  const reviewKey = getFileReviewKey(file);
  const fileDecision = decisions.fileDecisions[reviewKey] ?? decisions.fileDecisions[file.filePath];
  if (fileDecision === 'rejected') return true;
  if (fileDecision === 'accepted' || hunkCount === 0) return false;
  return Array.from({ length: hunkCount }, (_, index) => {
    return (
      decisions.hunkDecisions[buildHunkDecisionKey(reviewKey, index)] ??
      decisions.hunkDecisions[buildHunkDecisionKey(file.filePath, index)] ??
      'pending'
    );
  }).some((decision) => decision === 'rejected');
}

export function shouldDeleteFileWhenUndoingReject(
  file: FileChangeSummary | undefined,
  hunkCount: number,
  decisions: ReviewDecisionRecords
): boolean {
  return Boolean(
    file &&
    isReviewFileExpectedDeleted(file) &&
    !hasReviewFileRejections(file, hunkCount, decisions)
  );
}

export function isReviewFileFullyRejected(
  file: FileChangeSummary,
  hunkCount: number,
  decisions: ReviewDecisionRecords
): boolean {
  const reviewKey = getFileReviewKey(file);
  const fileDecision = decisions.fileDecisions[reviewKey] ?? decisions.fileDecisions[file.filePath];
  return (
    getEffectiveReviewFileDecision(file, hunkCount, decisions.hunkDecisions, fileDecision) ===
    'rejected'
  );
}

export function shouldCreateFileWhenUndoingReject(
  file: FileChangeSummary | undefined,
  isNewFile: boolean,
  hunkCount: number,
  decisions: ReviewDecisionRecords
): boolean {
  return Boolean(file && isNewFile && isReviewFileFullyRejected(file, hunkCount, decisions));
}

export function hasUnresolvedReviewExternalChange(
  filePath: string,
  changes: Record<string, unknown>
): boolean {
  const normalizedFilePath = normalizePathForComparison(filePath);
  return Object.keys(changes).some(
    (candidatePath) => normalizePathForComparison(candidatePath) === normalizedFilePath
  );
}

export function getReviewRenameRecoveryExpectation(
  file: FileChangeSummary | undefined
): ReviewRenameRecoveryExpectation | null {
  const ledger = file?.snippets.find(
    (snippet) => snippet.ledger?.relation?.kind === 'rename'
  )?.ledger;
  if (
    ledger?.relation?.kind !== 'rename' ||
    typeof ledger.eventId !== 'string' ||
    ledger.eventId.length === 0
  ) {
    return null;
  }
  return {
    eventId: ledger.eventId,
    beforeHash: ledger.beforeHash ?? null,
    afterHash: ledger.afterHash ?? null,
    relation: ledger.relation,
  };
}
