import type {
  ChangeReviewConflictCommandPort,
  ChangeReviewConflictQueryPort,
} from '../ports/changeReviewConflictPorts';
import type { ReviewAPI } from '@shared/types/api';

type ReviewConflictQueryApi = Pick<
  ReviewAPI,
  'loadDecisionConflictCandidates' | 'loadDraftHistoryConflictCandidates'
>;

type ReviewConflictCommandApi = Pick<ReviewAPI, 'resolveDecisionConflictCandidate'>;

export function createChangeReviewConflictQueryPort(
  getReviewApi: () => ReviewConflictQueryApi
): ChangeReviewConflictQueryPort {
  return {
    loadDecisionCandidates: ({ teamName, scopeKey, scopeToken }) =>
      getReviewApi().loadDecisionConflictCandidates(teamName, scopeKey, scopeToken),
    loadDraftHistoryCandidates: ({ teamName, scopeKey, scopeToken }) =>
      getReviewApi().loadDraftHistoryConflictCandidates(teamName, scopeKey, scopeToken),
  };
}

export function createChangeReviewConflictCommandPort(
  getReviewApi: () => ReviewConflictCommandApi
): ChangeReviewConflictCommandPort {
  return {
    resolveDecisionCandidate: ({ scope, candidateId, resolution, observedCurrentRevision }) =>
      getReviewApi().resolveDecisionConflictCandidate(
        scope.teamName,
        scope.scopeKey,
        scope.scopeToken,
        candidateId,
        resolution,
        observedCurrentRevision
      ),
  };
}
