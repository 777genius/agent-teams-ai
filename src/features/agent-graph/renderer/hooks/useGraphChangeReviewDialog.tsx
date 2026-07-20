import { lazy, Suspense, useCallback, useId, useState } from 'react';

import { useOptionalTabId } from '@renderer/hooks/useOptionalTabId';
import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import {
  buildChangeReviewLifecycleSessionId,
  requestChangeReviewLifecycleReservation,
} from '@renderer/utils/changeReviewLifecycleCoordinator';
import {
  buildTaskChangeRequestOptions,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { useShallow } from 'zustand/react/shallow';

const ChangeReviewDialog = lazy(() =>
  import('@renderer/components/team/review/ChangeReviewDialog').then((m) => ({
    default: m.ChangeReviewDialog,
  }))
);

interface GraphChangeReviewDialogState {
  open: boolean;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  initialFilePath?: string;
  taskChangeRequestOptions?: TaskChangeRequestOptions;
}

interface UseGraphChangeReviewDialogResult {
  dialog: React.ReactNode;
  openMemberChanges: (memberName: string, filePath?: string) => void;
  openTaskChanges: (taskId: string, filePath?: string) => void;
}

export function useGraphChangeReviewDialog(teamName: string): UseGraphChangeReviewDialogResult {
  const lifecycleHostId = useId();
  const tabId = useOptionalTabId();
  const [dialogState, setDialogState] = useState<GraphChangeReviewDialogState>({
    open: false,
    mode: 'task',
  });
  const { teamData, selectReviewFile } = useStore(
    useShallow((state) => ({
      teamData: selectTeamDataForName(state, teamName),
      selectReviewFile: state.selectReviewFile,
    }))
  );
  const focusLifecycleHost = useCallback((): void => {
    if (tabId) useStore.getState().setActiveTab(tabId);
  }, [tabId]);
  const requestOpenChangeReview = useCallback(
    async (next: Omit<GraphChangeReviewDialogState, 'open'>): Promise<boolean> => {
      const sessionId = buildChangeReviewLifecycleSessionId({ teamName, ...next });
      const reserved = await requestChangeReviewLifecycleReservation({
        hostId: lifecycleHostId,
        sessionId,
        tabId: tabId ?? undefined,
      });
      if (!reserved) return false;
      setDialogState({ ...next, open: true });
      if (next.initialFilePath) selectReviewFile(next.initialFilePath);
      return true;
    },
    [lifecycleHostId, selectReviewFile, tabId, teamName]
  );

  const openTaskChanges = useCallback(
    (taskId: string, filePath?: string): void => {
      const task = teamData?.tasks.find((candidate) => candidate.id === taskId);
      void requestOpenChangeReview({
        mode: 'task',
        taskId,
        memberName: undefined,
        initialFilePath: filePath,
        taskChangeRequestOptions: task ? buildTaskChangeRequestOptions(task) : {},
      });
    },
    [requestOpenChangeReview, teamData?.tasks]
  );

  const openMemberChanges = useCallback(
    (memberName: string, filePath?: string): void => {
      void requestOpenChangeReview({
        mode: 'agent',
        memberName,
        taskId: undefined,
        initialFilePath: filePath,
        taskChangeRequestOptions: undefined,
      });
    },
    [requestOpenChangeReview]
  );

  const handleOpenChange = useCallback((open: boolean): void => {
    setDialogState((previous) => ({
      ...previous,
      open,
      ...(open ? {} : { initialFilePath: undefined, taskChangeRequestOptions: undefined }),
    }));
  }, []);

  return {
    openMemberChanges,
    openTaskChanges,
    dialog: dialogState.open ? (
      <Suspense fallback={null}>
        <ChangeReviewDialog
          open={dialogState.open}
          onOpenChange={handleOpenChange}
          teamName={teamName}
          mode={dialogState.mode}
          memberName={dialogState.memberName}
          taskId={dialogState.taskId}
          initialFilePath={dialogState.initialFilePath}
          taskChangeRequestOptions={dialogState.taskChangeRequestOptions}
          projectPath={teamData?.config.projectPath}
          lifecycleHostId={lifecycleHostId}
          lifecycleTabId={tabId ?? undefined}
          onLifecycleFocus={focusLifecycleHost}
        />
      </Suspense>
    ) : null,
  };
}
