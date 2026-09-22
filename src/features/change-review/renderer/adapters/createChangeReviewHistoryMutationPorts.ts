import type {
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryPersistenceScope,
  ChangeReviewHistoryStateSnapshot,
} from '../ports/changeReviewHistoryMutationPorts';
import type { ReviewPersistedStateSnapshot } from '@shared/types';
import type { ReviewAPI } from '@shared/types/api';

type ChangeReviewHistoryMutationApi = Pick<
  ReviewAPI,
  'executeMutation' | 'restoreHistory' | 'retryMutationRecovery'
>;

export function createChangeReviewHistoryMutationCommandPort(
  getReviewApi: () => ChangeReviewHistoryMutationApi
): ChangeReviewHistoryMutationCommandPort {
  return {
    executeMutation: (request) => getReviewApi().executeMutation(request),
    restoreHistory: (request) => getReviewApi().restoreHistory(request),
    retryRecovery: (request) => getReviewApi().retryMutationRecovery(request),
  };
}

interface CreateChangeReviewHistoryMutationStatePortInput {
  getSnapshot: () => ChangeReviewHistoryStateSnapshot;
  quiesceDecisionPersistence: (scope: ChangeReviewHistoryPersistenceScope) => Promise<boolean>;
  recordDecisionRevision: (scope: ChangeReviewHistoryPersistenceScope, revision: number) => void;
  applyDecisionState: ChangeReviewHistoryMutationStatePort['applyDecisionState'];
  applyPersistedState: (state: ReviewPersistedStateSnapshot, applyError: string | null) => void;
  reportError: (message: string) => void;
  clearExternalChange: (filePath: string) => void;
  invalidateResolvedFileContent: (filePath: string) => void;
}

export function createChangeReviewHistoryMutationStatePort({
  getSnapshot,
  quiesceDecisionPersistence,
  recordDecisionRevision,
  applyDecisionState,
  applyPersistedState,
  reportError,
  clearExternalChange,
  invalidateResolvedFileContent,
}: CreateChangeReviewHistoryMutationStatePortInput): ChangeReviewHistoryMutationStatePort {
  return {
    getSnapshot,
    quiesceDecisionPersistence,
    recordDecisionRevision,
    applyDecisionState,
    applyPersistedState,
    reportError,
    clearExternalChange,
    invalidateResolvedFileContent,
  };
}
