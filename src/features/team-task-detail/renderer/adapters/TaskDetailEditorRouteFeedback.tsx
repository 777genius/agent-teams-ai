import { useEffect } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { useStore } from '@renderer/store';
import { isTaskDetailReadScopeCurrent } from '@renderer/store/team/taskDetailReadAuthority';
import { isOrdinaryTeamTab } from '@renderer/types/tabs';

import { TaskDetailReviewRouteBanner } from '../ui/TaskDetailReviewRouteBanner';

export const TaskDetailEditorRouteFeedback = (): React.JSX.Element | null => {
  const request = useStore((state) => state.pendingTaskDetailEditorRequest);
  const contextId = useStore((state) => state.activeContextId);
  const switching = useStore((state) => state.isContextSwitching);
  const layout = useStore((state) => state.paneLayout);
  const { t } = useAppTranslation('team');
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
        !isTaskDetailReadScopeCurrent(request, state.activeContextId, request.teamName)) &&
      state.pendingTaskDetailEditorRequest?.nonce === request.nonce
    )
      state.setPendingTaskDetailEditorRequest({ ...request, status: 'blocked' });
  }, [currentContext, layout, request]);
  if (!request || !currentContext || request.status !== 'blocked') return null;
  return (
    <TaskDetailReviewRouteBanner
      blocked
      message={t('taskDetail.navigation.editorRefused')}
      retry={() => useStore.getState().retryPendingTaskDetailEditor(request.nonce)}
      close={() => useStore.getState().closePendingTaskDetailEditor(request.nonce)}
    />
  );
};
