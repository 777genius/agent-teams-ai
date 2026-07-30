import type { ReviewMutationUndoAction } from './ReviewMutationJournalTypes';

export interface ReviewMutationApplyResult {
  applied: number;
  skipped: number;
  conflicts: number;
  errors: {
    filePath: string;
    error: string;
    code?: 'conflict' | 'unavailable' | 'manual-review-required' | 'io-error';
  }[];
  decisionRevision?: number;
  committedReviewAction?: ReviewMutationUndoAction;
  diskPostimages?: { filePath: string; content: string | null }[];
}

export class ReviewMutationApplyResultError extends Error {
  constructor(readonly result: ReviewMutationApplyResult) {
    super(result.errors[0]?.error ?? 'Review mutation could not be applied safely');
  }
}
