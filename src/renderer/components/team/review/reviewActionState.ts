import {
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
} from '@features/review-mutations';
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import {
  getEffectiveReviewFileDecision,
  isReviewFileExpectedDeleted,
} from './reviewContentPreview';

import type {
  ConflictCheckResult,
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
} from '@shared/types';

export interface ReviewDecisionRecords {
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
}

export { restoreReviewDecisionRecordsForFile, restoreReviewDecisionRecordsForFiles };

export function isReviewActionLocked(state: {
  applying: boolean;
  fileApplyCount: number;
  undoing: boolean;
  closing: boolean;
}): boolean {
  return state.applying || state.fileApplyCount > 0 || state.undoing || state.closing;
}

export type ReviewActionPersistenceStatus = 'saved' | 'saving' | 'error';

export function isReviewActionPersistenceBlocking(
  status: ReviewActionPersistenceStatus
): boolean {
  return status !== 'saved';
}

export function appendOrderedReviewAction<T>(
  stack: readonly T[],
  action: T,
  _legacyMaxDepth?: number
): T[] {
  return [...stack, action];
}

export function popOrderedReviewAction<T>(
  stack: readonly T[],
  expected: T
): { stack: T[]; popped: boolean } {
  if (stack.at(-1) !== expected) return { stack: [...stack], popped: false };
  return { stack: stack.slice(0, -1), popped: true };
}

export function replaceLatestReviewAction(
  stack: readonly ReviewUndoAction[],
  optimistic: ReviewUndoAction,
  committed: ReviewUndoAction
): { stack: ReviewUndoAction[]; replaced: boolean } {
  if (optimistic.id !== committed.id || stack.at(-1)?.id !== optimistic.id) {
    return { stack: [...stack], replaced: false };
  }
  return { stack: [...stack.slice(0, -1), committed], replaced: true };
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

export function getReviewDecisionHydrationGuard(input: {
  expectedScopeKey: string | null;
  hydratedScopeKey: string | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
}): 'not-required' | 'pending' | 'ready' | 'error' {
  if (input.expectedScopeKey === null) return 'not-required';
  if (input.hydratedScopeKey !== input.expectedScopeKey) return 'pending';
  if (input.status === 'loaded') return 'ready';
  if (input.status === 'error') return 'error';
  return 'pending';
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

export function partitionReviewFilesByApplyErrors(
  files: readonly FileChangeSummary[],
  errorPaths: readonly string[] | null
): { successful: FileChangeSummary[]; failed: FileChangeSummary[] } {
  if (errorPaths === null) return { successful: [], failed: [...files] };
  const normalizedErrors = new Set(errorPaths.map(normalizePathForComparison));
  const requestedPaths = new Set(files.map((file) => normalizePathForComparison(file.filePath)));
  const hasUnknownError = [...normalizedErrors].some((filePath) => !requestedPaths.has(filePath));
  if (hasUnknownError) {
    return { successful: [], failed: [...files] };
  }
  return {
    successful: files.filter(
      (file) => !normalizedErrors.has(normalizePathForComparison(file.filePath))
    ),
    failed: files.filter((file) => normalizedErrors.has(normalizePathForComparison(file.filePath))),
  };
}

export function reconcileReviewDecisionRecordsAfterApply(
  files: readonly FileChangeSummary[],
  errorPaths: readonly string[] | null,
  current: ReviewDecisionRecords,
  snapshot: ReviewDecisionRecords
): ReviewDecisionRecords & {
  successful: FileChangeSummary[];
  failed: FileChangeSummary[];
} {
  const partition = partitionReviewFilesByApplyErrors(files, errorPaths);
  let reconciled: ReviewDecisionRecords = {
    hunkDecisions: { ...current.hunkDecisions },
    fileDecisions: { ...current.fileDecisions },
  };
  for (const file of partition.failed) {
    reconciled = restoreReviewDecisionRecordsForFile(file, reconciled, snapshot);
  }
  return { ...partition, ...reconciled };
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
