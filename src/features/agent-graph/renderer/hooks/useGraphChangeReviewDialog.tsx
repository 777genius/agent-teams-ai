import { lazy, Suspense, useCallback, useState } from 'react';

import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
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

  const openTaskChanges = useCallback(
    (taskId: string, filePath?: string): void => {
      const task = teamData?.tasks.find((candidate) => candidate.id === taskId);
      setDialogState({
        open: true,
        mode: 'task',
        taskId,
        memberName: undefined,
        initialFilePath: filePath,
        taskChangeRequestOptions: task ? buildTaskChangeRequestOptions(task) : {},
      });
      if (filePath) {
        selectReviewFile(filePath);
      }
    },
    [selectReviewFile, teamData?.tasks]
  );

  const openMemberChanges = useCallback(
    (memberName: string, filePath?: string): void => {
      setDialogState({
        open: true,
        mode: 'agent',
        memberName,
        taskId: undefined,
        initialFilePath: filePath,
        taskChangeRequestOptions: undefined,
      });
      if (filePath) {
        selectReviewFile(filePath);
      }
    },
    [selectReviewFile]
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
        />
      </Suspense>
    ) : null,
  };
}
