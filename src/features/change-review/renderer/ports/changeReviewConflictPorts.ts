import type { ReviewDraftHistoryConflictCandidateSummary } from '@features/change-review-history/contracts';
import type {
  ReviewConflictResolution,
  ReviewDecisionConflictCandidateSummary,
} from '@shared/types';

export interface ChangeReviewConflictScope {
  teamName: string;
  scopeKey: string;
  scopeToken: string;
}

export interface ChangeReviewConflictQueryPort {
  loadDecisionCandidates(
    scope: ChangeReviewConflictScope
  ): Promise<ReviewDecisionConflictCandidateSummary[]>;
  loadDraftHistoryCandidates(
    scope: ChangeReviewConflictScope
  ): Promise<ReviewDraftHistoryConflictCandidateSummary[]>;
}

export interface ChangeReviewConflictCommandPort {
  resolveDecisionCandidate(input: {
    scope: ChangeReviewConflictScope;
    candidateId: string;
    resolution: ReviewConflictResolution;
    observedCurrentRevision: number;
  }): Promise<{ revision: number }>;
}
