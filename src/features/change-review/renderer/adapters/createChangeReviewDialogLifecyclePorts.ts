import type {
  ChangeReviewDialogLifecycleCommandPort,
  ChangeReviewDialogLifecycleStatePort,
  ChangeReviewDialogLifecycleStateSnapshot,
} from '../ports/changeReviewDialogLifecyclePorts';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { ApplyReviewResult } from '@shared/types';
import type { ReviewAPI } from '@shared/types/api';

interface ChangeReviewDialogLifecycleStore extends ChangeReviewDialogLifecycleStateSnapshot {
  applyError: string | null;
  resetAllReviewState(): void;
  clearChangeReviewCache(): void;
  fetchAgentChanges(teamName: string, memberName: string): Promise<void>;
  fetchTaskChanges(
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ): Promise<void>;
  clearDecisionsFromDisk(
    teamName: string,
    scopeKey: string,
    scopeToken?: string,
    forceDiscard?: boolean
  ): Promise<boolean>;
  applyReview(
    teamName: string,
    taskId?: string,
    memberName?: string
  ): Promise<ApplyReviewResult | null>;
}

interface CreateChangeReviewDialogLifecycleStatePortInput {
  getStore: () => ChangeReviewDialogLifecycleStore;
  reportError: (message: string | null) => void;
  completeSavedStateDiscard: (markDecisionHydrationLoaded: boolean) => void;
}

export function createChangeReviewDialogLifecycleStatePort({
  getStore,
  reportError,
  completeSavedStateDiscard,
}: CreateChangeReviewDialogLifecycleStatePortInput): ChangeReviewDialogLifecycleStatePort {
  return {
    getSnapshot: () => {
      const state = getStore();
      return {
        editedContents: state.editedContents,
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
        reviewActionHistory: state.reviewActionHistory,
        reviewRedoHistory: state.reviewRedoHistory,
        fileContents: state.fileContents,
        fileChunkCounts: state.fileChunkCounts,
        decisionHydrationScopeKey: state.decisionHydrationScopeKey,
        decisionHydrationStatus: state.decisionHydrationStatus,
        applying: state.applying,
      };
    },
    reportError,
    completeSavedStateDiscard,
  };
}

type ChangeReviewDialogLifecycleReviewApi = Pick<ReviewAPI, 'retryMutationRecovery'>;

interface CreateChangeReviewDialogLifecycleCommandPortInput {
  getStore: () => ChangeReviewDialogLifecycleStore;
  getReviewApi: () => ChangeReviewDialogLifecycleReviewApi;
  hydrateDecisions: ChangeReviewDialogLifecycleCommandPort['hydrateDecisions'];
}

export function createChangeReviewDialogLifecycleCommandPort({
  getStore,
  getReviewApi,
  hydrateDecisions,
}: CreateChangeReviewDialogLifecycleCommandPortInput): ChangeReviewDialogLifecycleCommandPort {
  return {
    resetAllReviewState: () => getStore().resetAllReviewState(),
    clearChangeReviewCache: () => getStore().clearChangeReviewCache(),
    fetchAgentChanges: (teamName, memberName) => {
      void getStore().fetchAgentChanges(teamName, memberName);
    },
    fetchTaskChanges: (teamName, taskId, options) => {
      void getStore().fetchTaskChanges(teamName, taskId, options);
    },
    hydrateDecisions,
    clearDecisions: ({ teamName, scopeKey, scopeToken }, forceDiscard) =>
      getStore().clearDecisionsFromDisk(teamName, scopeKey, scopeToken, forceDiscard),
    applyReview: async (teamName, taskId, memberName) => {
      const result = await getStore().applyReview(teamName, taskId, memberName);
      if (result?.errors.length === 0) {
        return { status: 'applied', result };
      }
      return {
        status: 'failed',
        result,
        errorMessage:
          result?.errors.map((entry) => entry.error).join('\n') ||
          getStore().applyError ||
          'Unable to apply this review. Changes remains open; retry Apply.',
      };
    },
    retryMutationRecovery: (request) => getReviewApi().retryMutationRecovery(request),
  };
}
