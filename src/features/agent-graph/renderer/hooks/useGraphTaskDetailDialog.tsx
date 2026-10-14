import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';

import {
  type TaskDetailIdentity,
  taskDetailKey,
  useTaskDetailSession,
} from '@features/team-task-detail/renderer';
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
  const [selectedIdentity, setSelectedIdentity] = useState<TaskDetailIdentity | null>(null);
  const selectedTaskId = selectedIdentity?.taskId ?? null;
  const {
    activeContextId,
    activeMembers,
    detailEntry,
    setTaskDetailSurfaceInterest,
    teamData,
    updateTaskOwner,
  } = useStore(
    useShallow((state) => ({
      activeContextId: state.activeContextId,
      activeMembers: selectResolvedMembersForTeamName(state, teamName).filter(
        (member) => !member.removedAt
      ),
      detailEntry: selectedTaskId
        ? state.taskDetailById[taskDetailKey(selectedIdentity!)]
        : undefined,
      setTaskDetailSurfaceInterest: state.setTaskDetailSurfaceInterest,
      teamData: selectTeamDataForName(state, teamName),
      updateTaskOwner: state.updateTaskOwner,
    }))
  );

  const taskMap = useMemo(
    () => new Map((teamData?.tasks ?? []).map((task) => [task.id, task])),
    [teamData?.tasks]
  );
  const identity = useMemo(
    () => selectedIdentity ?? { contextId: activeContextId, teamName, taskId: '' },
    [activeContextId, selectedIdentity, teamName]
  );
  const selectedTask = detailEntry?.full ?? null;
  const surfaceIdRef = useRef(crypto.randomUUID());
  const sessionController = useTaskDetailSession({
    identity,
    surfaceId: surfaceIdRef.current,
    currentTask: selectedTask,
    enabled: Boolean(
      selectedIdentity &&
      selectedIdentity.contextId === activeContextId &&
      selectedIdentity.teamName === teamName
    ),
  });

  useEffect(() => {
    if (
      selectedIdentity &&
      (selectedIdentity.contextId !== activeContextId || selectedIdentity.teamName !== teamName)
    ) {
      setSelectedIdentity(null);
    }
  }, [activeContextId, selectedIdentity, teamName]);

  useEffect(() => {
    const surfaceId = surfaceIdRef.current;
    setTaskDetailSurfaceInterest(surfaceId, selectedIdentity);
    return () => setTaskDetailSurfaceInterest(surfaceId, null);
  }, [selectedIdentity, setTaskDetailSurfaceInterest]);

  const openTaskDetail = useCallback(
    (taskId: string): void => {
      if (
        activeContextId !== useStore.getState().activeContextId ||
        useStore.getState().isContextSwitching
      )
        return;
      setSelectedIdentity({ contextId: activeContextId, teamName, taskId });
    },
    [activeContextId, teamName]
  );

  const closeTaskDetail = useCallback((): void => {
    setSelectedIdentity(null);
  }, []);

  const handleOpenTaskTab = useCallback((): void => {
    if (sessionController.openInTaskTab()) setSelectedIdentity(null);
  }, [sessionController]);

  return {
    openTaskDetail,
    dialog:
      selectedIdentity?.contextId === activeContextId &&
      selectedIdentity.teamName === teamName &&
      selectedTaskId ? (
        <Suspense fallback={null}>
          <TaskDetailDialog
            open
            loading={
              !selectedTask &&
              ['hydrating', 'provisioning'].includes(detailEntry?.phase ?? 'hydrating')
            }
            task={selectedTask}
            teamName={teamName}
            projectPath={teamData?.config.projectPath ?? null}
            sessionController={sessionController}
            kanbanTaskState={teamData?.kanbanState.tasks[selectedTaskId]}
            taskMap={taskMap}
            members={activeMembers}
            onClose={closeTaskDetail}
            onScrollToTask={openTaskDetail}
            onOwnerChange={(taskId, owner) => {
              if (sessionController.canEditNow())
                void updateTaskOwner(teamName, taskId, owner).catch(() => undefined);
            }}
            onViewChanges={(...args) => {
              if (sessionController.isOriginCurrent()) onViewChanges?.(...args);
            }}
            onDeleteTask={(...args) => {
              if (sessionController.canEditNow()) onDeleteTask?.(...args);
            }}
            onOpenInTaskTab={handleOpenTaskTab}
          />
        </Suspense>
      ) : null,
  };
}
