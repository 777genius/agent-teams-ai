import { lazy, Suspense, useCallback, useMemo, useState } from 'react';

import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { useShallow } from 'zustand/react/shallow';

const TaskDetailDialog = lazy(() =>
  import('@renderer/components/team/dialogs/TaskDetailDialog').then((m) => ({
    default: m.TaskDetailDialog,
  }))
);

interface UseGraphTaskDetailDialogInput {
  onDeleteTask?: (taskId: string) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
}

interface UseGraphTaskDetailDialogResult {
  dialog: React.ReactNode;
  openTaskDetail: (taskId: string) => void;
}

export function useGraphTaskDetailDialog(
  teamName: string,
  { onDeleteTask, onViewChanges }: UseGraphTaskDetailDialogInput
): UseGraphTaskDetailDialogResult {
  const [selectedTaskId, setSelectedTaskId] = useState<string | null>(null);
  const { activeMembers, teamData, updateTaskOwner } = useStore(
    useShallow((state) => ({
      activeMembers: selectResolvedMembersForTeamName(state, teamName).filter(
        (member) => !member.removedAt
      ),
      teamData: selectTeamDataForName(state, teamName),
      updateTaskOwner: state.updateTaskOwner,
    }))
  );

  const taskMap = useMemo(
    () => new Map((teamData?.tasks ?? []).map((task) => [task.id, task])),
    [teamData?.tasks]
  );
  const selectedTask = selectedTaskId ? (taskMap.get(selectedTaskId) ?? null) : null;

  const openTaskDetail = useCallback((taskId: string): void => {
    setSelectedTaskId(taskId);
  }, []);

  const closeTaskDetail = useCallback((): void => {
    setSelectedTaskId(null);
  }, []);

  return {
    openTaskDetail,
    dialog:
      selectedTaskId && teamData ? (
        <Suspense fallback={null}>
          <TaskDetailDialog
            open
            task={selectedTask}
            teamName={teamName}
            kanbanTaskState={teamData.kanbanState.tasks[selectedTaskId]}
            taskMap={taskMap}
            members={activeMembers}
            onClose={closeTaskDetail}
            onScrollToTask={openTaskDetail}
            onOwnerChange={(taskId, owner) => {
              void updateTaskOwner(teamName, taskId, owner).catch(() => undefined);
            }}
            onViewChanges={onViewChanges}
            onDeleteTask={onDeleteTask}
          />
        </Suspense>
      ) : null,
  };
}
