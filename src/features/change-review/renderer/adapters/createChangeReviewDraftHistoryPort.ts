import type { ChangeReviewDraftHistoryPort } from '../ports/changeReviewDraftHistoryPort';
import type { ReviewAPI } from '@shared/types/api';

type ReviewDraftHistoryApi = Pick<
  ReviewAPI,
  | 'loadDraftHistory'
  | 'saveDraftHistoryEntry'
  | 'clearDraftHistory'
  | 'checkConflict'
  | 'replaceDraftHistoryConflictCandidate'
  | 'resolveDraftHistoryConflictCandidate'
>;

export function createChangeReviewDraftHistoryPort(
  getReviewApi: () => ReviewDraftHistoryApi
): ChangeReviewDraftHistoryPort {
  return {
    load: ({ teamName, scopeKey, scopeToken }) =>
      getReviewApi().loadDraftHistory(teamName, scopeKey, scopeToken),
    saveEntry: ({ scope, entry, expectedVersion }) =>
      getReviewApi().saveDraftHistoryEntry(
        scope.teamName,
        scope.scopeKey,
        scope.scopeToken,
        entry,
        expectedVersion.revision,
        expectedVersion.generation
      ),
    clear: ({ scope, filePath, expectedVersion }) =>
      getReviewApi().clearDraftHistory(
        scope.teamName,
        scope.scopeKey,
        scope.scopeToken,
        filePath,
        expectedVersion?.revision,
        expectedVersion?.generation
      ),
    checkConflict: ({ reviewScope, filePath, expectedModified }) =>
      getReviewApi().checkConflict(reviewScope, filePath, expectedModified),
    replaceConflictCandidate: ({ scope, expectedEntry, replacementEntry, observedVersion }) =>
      getReviewApi().replaceDraftHistoryConflictCandidate(
        scope.teamName,
        scope.scopeKey,
        scope.scopeToken,
        expectedEntry,
        replacementEntry,
        observedVersion.revision,
        observedVersion.generation
      ),
    resolveConflictCandidate: ({ scope, candidateId, resolution, observedVersion }) =>
      getReviewApi().resolveDraftHistoryConflictCandidate(
        scope.teamName,
        scope.scopeKey,
        scope.scopeToken,
        candidateId,
        resolution,
        observedVersion.revision,
        observedVersion.generation
      ),
  };
}
