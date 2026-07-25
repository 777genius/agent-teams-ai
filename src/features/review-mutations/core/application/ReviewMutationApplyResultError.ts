import type { ApplyReviewResult } from '@shared/types/review';

export class ReviewMutationApplyResultError extends Error {
  constructor(readonly result: ApplyReviewResult) {
    super(result.errors[0]?.error ?? 'Review mutation could not be applied safely');
  }
}
