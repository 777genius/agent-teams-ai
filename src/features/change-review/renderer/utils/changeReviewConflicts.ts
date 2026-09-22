import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type { ReviewDecisionConflictCandidateSummary } from '@shared/types';

export const CHANGE_REVIEW_CONFLICT_LOAD_ERROR_PREFIX = 'Unable to load durable recovery copies:';

export type ReviewConflictCandidateSelection =
  | { kind: 'decision'; value: ReviewDecisionConflictCandidateSummary }
  | { kind: 'draft'; value: ReviewDraftHistoryConflictCandidateSummary };

export function selectLatestReviewConflictCandidate(
  decisions: readonly ReviewDecisionConflictCandidateSummary[],
  drafts: readonly ReviewDraftHistoryConflictCandidateSummary[]
): ReviewConflictCandidateSelection | null {
  const decision = decisions[0];
  const draft = drafts[0];
  if (!decision) return draft ? { kind: 'draft', value: draft } : null;
  if (!draft) return { kind: 'decision', value: decision };
  return Date.parse(decision.capturedAt) >= Date.parse(draft.capturedAt)
    ? { kind: 'decision', value: decision }
    : { kind: 'draft', value: draft };
}

export function describeReviewConflictCandidate(
  selected: ReviewConflictCandidateSelection
): string {
  if (selected.kind === 'decision') {
    return selected.value.origin === 'prior-snapshot'
      ? `An earlier review snapshot has a saved branch with ${selected.value.undoDepth} Undo and ${selected.value.redoDepth} Redo actions. It cannot be applied to this changed diff.`
      : `Another window saved a different review branch. Local copy: ${selected.value.undoDepth} Undo and ${selected.value.redoDepth} Redo actions.`;
  }
  if (selected.value.recoverability === 'file-not-in-current-review') {
    return `An earlier manual-edit branch targets ${selected.value.filePath}, which is not part of the current review.`;
  }
  return selected.value.entryRevision === null
    ? `The recovery branch has no saved manual edits for ${selected.value.filePath}.`
    : `Another window saved different manual edit history for ${selected.value.filePath}.`;
}

export function describeReviewConflictDiscard(
  selected: ReviewConflictCandidateSelection | null
): string {
  if (!selected) return '';
  return selected.kind === 'decision'
    ? `Captured ${new Date(selected.value.capturedAt).toLocaleString()} with ${selected.value.undoDepth} Undo and ${selected.value.redoDepth} Redo actions.`
    : `Captured ${new Date(selected.value.capturedAt).toLocaleString()} for ${selected.value.filePath}.`;
}
