import { useCallback, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  TaskDetailContent,
  TaskDetailEditorActivationFeedback,
  taskDetailKey,
  TaskDetailReviewActivationFeedback,
  type TaskDetailSessionController,
  useTaskDetailPresentation,
} from '@features/team-task-detail/renderer';
import { LightboxLockProvider } from '@renderer/components/team/attachments/ImageLightbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';

import { TaskDetailLoadingDialog } from './TaskDetailLoadingDialog';

import type { TaskDetailHeadingProps } from '@features/team-task-detail/renderer';
import type { TaskDetailFileLinkIntent } from '@features/team-task-detail/renderer';
import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

export interface TaskDetailDialogProps {
  open: boolean;
  loading?: boolean;
  variant?: 'team' | 'global';
  task: TeamTaskWithKanban | null;
  teamName: string;
  sessionController: TaskDetailSessionController;
  projectPath: string | null;
  kanbanTaskState?: KanbanTaskState;
  taskMap: Map<string, TeamTaskWithKanban>;
  members: ResolvedTeamMember[];
  onClose: () => void;
  onScrollToTask?: (taskId: string) => void;
  onOwnerChange?: (taskId: string, owner: string | null) => void;
  onViewChanges?: (taskId: string, filePath?: string) => void;
  onOpenInEditor?: (intent: TaskDetailFileLinkIntent) => void;
  onDeleteTask?: (taskId: string) => void;
  onOpenInTaskTab?: () => void | Promise<void>;
  focusCommentId?: string;
  headerExtra?: React.ReactNode;
}

export const TaskDetailDialog = ({
  open,
  loading = false,
  variant = 'team',
  task,
  teamName,
  sessionController,
  projectPath,
  kanbanTaskState,
  taskMap,
  members,
  onClose,
  onScrollToTask,
  onOwnerChange,
  onViewChanges,
  onOpenInEditor,
  onDeleteTask,
  onOpenInTaskTab,
  focusCommentId,
  headerExtra,
}: TaskDetailDialogProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');

  if (loading) {
    return <TaskDetailLoadingDialog open={open} onClose={onClose} />;
  }

  if (!task) {
    return (
      <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
        <DialogContent className="sm:max-w-4xl">
          <DialogHeader>
            <DialogTitle>{t('taskDetail.notFound')}</DialogTitle>
          </DialogHeader>
        </DialogContent>
      </Dialog>
    );
  }

  return (
    <LoadedTaskDetailDialog
      open={open}
      variant={variant}
      task={task}
      teamName={teamName}
      sessionController={sessionController}
      projectPath={projectPath}
      kanbanTaskState={kanbanTaskState}
      taskMap={taskMap}
      members={members}
      onClose={onClose}
      onScrollToTask={onScrollToTask}
      onOwnerChange={onOwnerChange}
      onViewChanges={onViewChanges}
      onOpenInEditor={onOpenInEditor}
      onDeleteTask={onDeleteTask}
      onOpenInTaskTab={onOpenInTaskTab}
      focusCommentId={focusCommentId}
      headerExtra={headerExtra}
    />
  );
};

type LoadedTaskDetailDialogProps = Omit<TaskDetailDialogProps, 'loading' | 'task'> & {
  task: TeamTaskWithKanban;
};

const LoadedTaskDetailDialog = ({
  open,
  variant,
  task,
  teamName,
  sessionController,
  projectPath,
  kanbanTaskState,
  taskMap,
  members,
  onClose,
  onScrollToTask,
  onOwnerChange,
  onDeleteTask,
  onOpenInTaskTab,
  focusCommentId,
  headerExtra,
}: LoadedTaskDetailDialogProps): React.JSX.Element => {
  const lightboxOpenRef = useRef(false);
  const setLightboxLocked = useCallback((isOpen: boolean) => {
    lightboxOpenRef.current = isOpen;
  }, []);
  const flushCommentReadRef = useRef<() => void>(() => undefined);
  const presentationClose = useCallback(() => {
    flushCommentReadRef.current();
    onClose();
  }, [onClose]);
  const handleEditorIntent = useCallback(
    (intent: TaskDetailFileLinkIntent) => {
      if (!sessionController.isOriginCurrent()) return;
      if (
        useStore
          .getState()
          .openTaskDetailEditor(
            { contextId: intent.contextId, teamName: intent.teamName, taskId: intent.taskId },
            { projectPath: intent.projectPath, filePath: intent.filePath, line: intent.line }
          )
      )
        presentationClose();
    },
    [presentationClose, sessionController]
  );
  const handleReview = useCallback(
    (taskId: string, filePath?: string) => {
      if (!sessionController.isOriginCurrent()) return;
      const target = taskMap.get(taskId);
      if (!target) return;
      if (
        useStore
          .getState()
          .openTaskDetailReview(
            { ...sessionController.identity, taskId },
            { filePath, requestOptions: buildTaskChangeRequestOptions(target) }
          )
      )
        presentationClose();
    },
    [presentationClose, sessionController, taskMap]
  );
  const presentation = useTaskDetailPresentation({
    active: open,
    currentTask: task,
    enabled: open,
    focusCommentId,
    kanbanTaskState,
    members,
    onOpenChangeFile: (filePath) => {
      handleReview(task.id, filePath);
    },
    onTaskNavigate: (taskId, targetTeamName) => {
      if (!sessionController.isOriginCurrent()) return;
      if (targetTeamName && targetTeamName !== teamName) {
        if (
          useStore.getState().openTaskDetailTab({
            ...sessionController.identity,
            teamName: targetTeamName,
            taskId,
          })
        )
          presentationClose();
      } else if (onScrollToTask) {
        onScrollToTask(taskId);
        presentationClose();
      }
    },
    projectPath,
    sessionController,
    taskMap,
    teamName,
  });
  flushCommentReadRef.current = presentation.actions.flushCommentRead;

  const renderHeading = useCallback(
    (props: TaskDetailHeadingProps) => (
      <DialogTitle className={props.className}>{props.children}</DialogTitle>
    ),
    []
  );

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && lightboxOpenRef.current) return;
        if (!nextOpen) presentationClose();
      }}
    >
      <DialogContent
        ref={presentation.actions.setRootElement}
        className="sm:min-w-[500px] sm:max-w-4xl"
        onInteractOutside={(event) => {
          if (lightboxOpenRef.current) event.preventDefault();
        }}
        onEscapeKeyDown={(event) => {
          if (lightboxOpenRef.current) event.preventDefault();
        }}
      >
        <LightboxLockProvider value={setLightboxLocked}>
          <TaskDetailReviewActivationFeedback
            identity={sessionController.identity}
            active={open}
            onAccepted={presentationClose}
          />
          <TaskDetailEditorActivationFeedback
            identity={sessionController.identity}
            active={open}
            onAccepted={presentationClose}
          />
          <TaskDetailContent
            key={taskDetailKey(sessionController.identity)}
            actions={presentation.actions}
            headerExtra={headerExtra}
            model={presentation.model}
            onDeleteTask={onDeleteTask}
            onOpenInEditor={handleEditorIntent}
            onOpenInTaskTab={onOpenInTaskTab}
            onOwnerChange={onOwnerChange}
            onViewChanges={handleReview}
            renderDescription={(content) => <DialogDescription>{content}</DialogDescription>}
            renderHeading={renderHeading}
            renderHeader={(children) => <DialogHeader>{children}</DialogHeader>}
            sessionController={sessionController}
            showTeamIO={variant === 'team'}
          />
        </LightboxLockProvider>
      </DialogContent>
    </Dialog>
  );
};
