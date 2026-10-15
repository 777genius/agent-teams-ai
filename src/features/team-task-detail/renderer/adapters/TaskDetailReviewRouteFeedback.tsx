import { useEffect } from 'react';

import { useStore } from '@renderer/store';
import { isTaskDetailReadScopeCurrent } from '@renderer/store/team/taskDetailReadAuthority';
import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import { TaskDetailReviewRouteBanner } from '../ui/TaskDetailReviewRouteBanner';

/** A request remains recoverable even if its target tab is hidden or closed. */
export const TaskDetailReviewRouteFeedback = (): React.JSX.Element | null => {
  const request = useStore((state) => state.pendingReviewRequest);
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const layout = useStore((state) => state.paneLayout);
  const selectedTeamName = useStore((state) => state.selectedTeamName);
  const currentContext = request?.contextId === contextId && !switching;
  useEffect(() => {
    if (!request || !currentContext || request.status === 'blocked') return;
    const state = useStore.getState();
    const targetActive = layout.panes.some(
      (pane) =>
        pane.activeTabId === request.targetTeamTabId &&
        pane.tabs.some(
          (tab) =>
            tab.id === request.targetTeamTabId &&
            isOrdinaryTeamTab(tab) &&
            tab.teamName === request.teamName
        )
    );
    if (
      (!targetActive ||
        (request.status === 'opening' && selectedTeamName !== request.teamName) ||
        !isTaskDetailReadScopeCurrent(request, state.activeContextId, request.teamName)) &&
      state.pendingReviewRequest?.nonce === request.nonce
    )
      state.setPendingReviewRequest({ ...request, status: 'blocked' });
  }, [currentContext, layout, request, selectedTeamName]);
  if (!request || !currentContext || request.status !== 'blocked') return null;
  return (
    <TaskDetailReviewRouteBanner
      blocked
      retry={() => {
        useStore.getState().retryPendingTaskDetailReview(request.nonce);
      }}
      close={() => {
        useStore.getState().closePendingTaskDetailReview(request.nonce);
      }}
    />
  );
};
