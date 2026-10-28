import { queueTaskDetailReview } from './taskDetailReviewRoute';

import type { AppState } from '../types';
import type { StoreApi } from 'zustand';

type ActivationFeedbackActions = Pick<
  AppState,
  | 'retryTaskDetailEditorActivationFailure'
  | 'closeTaskDetailEditorActivationFailure'
  | 'retryTaskDetailReviewActivationFailure'
  | 'closeTaskDetailReviewActivationFailure'
  | 'retryPendingTaskDetailReview'
  | 'closePendingTaskDetailReview'
>;

export function createTaskDetailActivationFeedbackActions(
  set: StoreApi<AppState>['setState'],
  get: () => AppState
): ActivationFeedbackActions {
  return {
    retryTaskDetailEditorActivationFailure: (nonce) => {
      const state = get();
      const failure = state.taskDetailEditorActivationFailure;
      return failure?.nonce === nonce
        ? state.openTaskDetailEditor(failure.identity, failure.intent)
        : false;
    },
    closeTaskDetailEditorActivationFailure: (nonce) => {
      const failure = get().taskDetailEditorActivationFailure;
      if (failure?.nonce === nonce) set({ taskDetailEditorActivationFailure: null });
    },
    retryTaskDetailReviewActivationFailure: (nonce) => {
      const state = get();
      const failure = state.taskDetailReviewActivationFailure;
      return failure?.nonce === nonce
        ? state.openTaskDetailReview(failure.identity, failure.options)
        : false;
    },
    closeTaskDetailReviewActivationFailure: (nonce) => {
      const failure = get().taskDetailReviewActivationFailure;
      if (failure?.nonce === nonce) set({ taskDetailReviewActivationFailure: null });
    },
    retryPendingTaskDetailReview: (nonce) => {
      const request = get().pendingReviewRequest;
      if (!request || request.nonce !== nonce) return false;
      return queueTaskDetailReview(
        get,
        { contextId: request.contextId, teamName: request.teamName, taskId: request.taskId },
        { filePath: request.filePath, requestOptions: request.requestOptions }
      );
    },
    closePendingTaskDetailReview: (nonce) => {
      const state = get();
      const request = state.pendingReviewRequest;
      if (
        request?.nonce === nonce &&
        request.contextId === state.activeContextId &&
        !state.isContextSwitching
      )
        state.setPendingReviewRequest(null);
    },
  };
}
