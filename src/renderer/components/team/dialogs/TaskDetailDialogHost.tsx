import {
  forwardRef,
  lazy,
  memo,
  Suspense,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useState,
} from 'react';

import type { TeamTaskDetailRendererPorts } from '@features/team-task-board/renderer';
import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

type TaskDetailDialogComponent = typeof import('./TaskDetailDialog').TaskDetailDialog;

let loadedTaskDetailDialogComponent: TaskDetailDialogComponent | null = null;
let taskDetailDialogImportPromise: Promise<{ default: TaskDetailDialogComponent }> | null = null;

function loadTaskDetailDialog(): Promise<{ default: TaskDetailDialogComponent }> {
  taskDetailDialogImportPromise ??= import('./TaskDetailDialog')
    .then((module) => {
      loadedTaskDetailDialogComponent = module.TaskDetailDialog;
      return { default: module.TaskDetailDialog };
    })
    .catch((error) => {
      taskDetailDialogImportPromise = null;
      throw error;
    });
  return taskDetailDialogImportPromise;
}

export function preloadTaskDetailDialog(): void {
  void loadTaskDetailDialog().catch(() => undefined);
}

const LazyTaskDetailDialog = lazy(loadTaskDetailDialog);

export interface TaskDetailDialogHostHandle {
  openTask(task: TeamTaskWithKanban): void;
  close(): void;
}

interface TaskDetailDialogHostProps {
  teamName: string;
  taskPorts: Pick<TeamTaskDetailRendererPorts, 'readTask'>;
  kanbanTaskStateByTaskId: Record<string, KanbanTaskState>;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onOwnerChange(taskId: string, owner: string | null): void;
  onViewChanges(taskId: string, filePath?: string): void;
  onOpenInEditor(filePath: string): void;
  onDeleteTask(taskId: string): void;
}

export const TaskDetailDialogHost = memo(
  forwardRef<TaskDetailDialogHostHandle, TaskDetailDialogHostProps>(function TaskDetailDialogHost(
    {
      teamName,
      taskPorts,
      kanbanTaskStateByTaskId,
      taskMap,
      members,
      onOwnerChange,
      onViewChanges,
      onOpenInEditor,
      onDeleteTask,
    },
    ref
  ) {
    const [selectedTask, setSelectedTask] = useState<TeamTaskWithKanban | null>(null);
    const [loadedTask, setLoadedTask] = useState<TeamTaskWithKanban | null>(null);
    const selectedTaskId = selectedTask?.id ?? null;
    const selectedTaskSnapshot =
      selectedTaskId !== null ? (taskMap.get(selectedTaskId) ?? selectedTask) : null;
    const selectedTaskUpdatedAt = selectedTaskSnapshot?.updatedAt ?? null;
    const currentTask =
      loadedTask && loadedTask.id === selectedTaskId ? loadedTask : selectedTaskSnapshot;
    const dialogTaskMap = useMemo(() => {
      if (!currentTask) return taskMap;
      const next = new Map(taskMap);
      next.set(currentTask.id, currentTask);
      return next;
    }, [currentTask, taskMap]);

    useImperativeHandle(
      ref,
      () => ({
        openTask: (task) => {
          setLoadedTask(null);
          setSelectedTask(task);
        },
        close: () => {
          setLoadedTask(null);
          setSelectedTask(null);
        },
      }),
      []
    );

    useEffect(() => {
      if (!selectedTaskId) {
        setLoadedTask(null);
        return undefined;
      }
      let cancelled = false;
      setLoadedTask(null);
      void taskPorts
        .readTask(teamName, selectedTaskId)
        .then((task) => {
          if (!cancelled && task?.id === selectedTaskId) setLoadedTask(task);
        })
        .catch(() => undefined);
      return () => {
        cancelled = true;
      };
    }, [selectedTaskId, selectedTaskUpdatedAt, taskPorts, teamName]);

    const handleScrollToTask = useCallback((taskId: string) => {
      setSelectedTask(null);
      setLoadedTask(null);
      const element = document.querySelector(`[data-task-id="${taskId}"]`);
      if (!element) return;
      element.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      element.classList.remove('kanban-card-focus-pulse');
      void (element as HTMLElement).offsetWidth;
      element.classList.add('kanban-card-focus-pulse');
      element.addEventListener('animationend', () => element.classList.remove('kanban-card-focus-pulse'), {
        once: true,
      });
    }, []);

    if (!currentTask) return null;

    const DialogComponent = loadedTaskDetailDialogComponent ?? LazyTaskDetailDialog;
    const dialog = (
      <DialogComponent
        open
        task={currentTask}
        teamName={teamName}
        kanbanTaskState={kanbanTaskStateByTaskId[currentTask.id]}
        taskMap={dialogTaskMap}
        members={members}
        onClose={() => {
          setLoadedTask(null);
          setSelectedTask(null);
        }}
        onScrollToTask={handleScrollToTask}
        onOwnerChange={onOwnerChange}
        onViewChanges={onViewChanges}
        onOpenInEditor={onOpenInEditor}
        onDeleteTask={onDeleteTask}
      />
    );
    return loadedTaskDetailDialogComponent ? dialog : <Suspense fallback={null}>{dialog}</Suspense>;
  })
);

TaskDetailDialogHost.displayName = 'TaskDetailDialogHost';
