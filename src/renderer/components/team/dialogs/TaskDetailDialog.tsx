import { useCallback, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import {
  TaskDetailContent,
  TaskDetailEditorActivationFeedback,
  type TaskDetailIdentity,
  taskDetailKey,
  type TaskDetailReadPhase,
  TaskDetailReviewActivationFeedback,
  type TaskDetailSessionController,
  useTaskDetailPresentation,
} from '@features/team-task-detail/renderer';
import { LightboxLockProvider } from '@renderer/components/team/attachments/ImageLightbox';
import { Button } from '@renderer/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@renderer/components/ui/dialog';
import { useStore } from '@renderer/store';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import { RefreshCw } from 'lucide-react';

import { TaskDetailLoadingDialog } from './TaskDetailLoadingDialog';

import type { TaskDetailHeadingProps } from '@features/team-task-detail/renderer';
import type { TaskDetailFileLinkIntent } from '@features/team-task-detail/renderer';
import type { KanbanTaskState, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

export interface TaskDetailDialogProps {
  open: boolean;
  loading?: boolean;
  variant?: 'team' | 'global';
  task: TeamTaskWithKanban | null;
  readPhase?: TaskDetailReadPhase;
  readError?: string | null;
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
  onRetryRead?: (identity: TaskDetailIdentity) => void;
  focusCommentId?: string;
  headerExtra?: React.ReactNode;
}

export const TaskDetailDialog = ({
  open,
  loading = false,
  variant = 'team',
  task,
  readPhase,
  readError,
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
  onRetryRead,
  focusCommentId,
  headerExtra,
}: TaskDetailDialogProps): React.JSX.Element => {
  const readEntry = useStore(
    (state) => state.taskDetailById[taskDetailKey(sessionController.identity)]
  );
  const ensureTaskDetail = useStore((state) => state.ensureTaskDetail);
  const effectiveReadPhase = readPhase ?? readEntry?.phase ?? (loading ? 'hydrating' : 'missing');
  const effectiveReadError = readError === undefined ? (readEntry?.error ?? null) : readError;
  const retryIdentity = sessionController.identity;
  const retryRead = useCallback(() => {
    if (!sessionController.isOriginCurrent()) return;
    if (onRetryRead) onRetryRead(retryIdentity);
    else void ensureTaskDetail(retryIdentity);
  }, [ensureTaskDetail, onRetryRead, retryIdentity, sessionController]);

  if (!task && effectiveReadPhase === 'hydrating') {
    return <TaskDetailLoadingDialog open={open} onClose={onClose} />;
  }

  if (!task) {
    return (
      <TaskDetailReadStateDialog
        open={open}
        phase={effectiveReadPhase}
        error={effectiveReadError}
        onClose={onClose}
        onRetry={retryRead}
      />
    );
  }

  return (
    <LoadedTaskDetailDialog
      open={open}
      variant={variant}
      task={task}
      readPhase={effectiveReadPhase}
      readError={effectiveReadError}
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
      retryRead={retryRead}
      focusCommentId={focusCommentId}
      headerExtra={headerExtra}
    />
  );
};

type LoadedTaskDetailDialogProps = Omit<
  TaskDetailDialogProps,
  'loading' | 'task' | 'onRetryRead'
> & {
  task: TeamTaskWithKanban;
  retryRead: () => void;
};

const LoadedTaskDetailDialog = ({
  open,
  variant,
  task,
  readPhase,
  readError,
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
  retryRead,
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
          {presentation.model.editingSubject ? (
            <DialogTitle className="sr-only">{task.subject}</DialogTitle>
          ) : null}
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
          {readPhase === 'unavailable' || readPhase === 'provisioning' ? (
            <TaskDetailReadStateBanner
              phase={readPhase}
              error={readError ?? null}
              onRetry={retryRead}
            />
          ) : null}
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

const TASK_DETAIL_STATE_LABEL_KEYS = {
  deleted: 'taskDetail.page.deleted',
  hydrating: 'taskDetail.loading.title',
  missing: 'taskDetail.notFound',
  provisioning: 'taskDetail.page.provisioning',
  ready: 'taskDetail.loading.title',
  unavailable: 'taskDetail.page.unavailable',
} as const;

const TaskDetailReadStateBanner = ({
  phase,
  error,
  onRetry,
}: {
  phase: TaskDetailReadPhase;
  error: string | null;
  onRetry?: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <section
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm"
      role={phase === 'unavailable' ? 'alert' : 'status'}
    >
      <div className="flex items-center gap-2">
        <strong>{t(TASK_DETAIL_STATE_LABEL_KEYS[phase])}</strong>
        {error ? <span className="min-w-0 text-xs text-red-400">{error}</span> : null}
        {onRetry && (phase === 'unavailable' || phase === 'provisioning') ? (
          <Button
            variant="ghost"
            size="sm"
            className="ml-auto h-7 gap-1 text-xs"
            onClick={onRetry}
            aria-label={t('taskDetail.changes.refreshShort')}
          >
            <RefreshCw size={12} />
            {t('taskDetail.changes.refreshShort')}
          </Button>
        ) : null}
      </div>
    </section>
  );
};

const TaskDetailReadStateDialog = ({
  open,
  phase,
  error,
  onClose,
  onRetry,
}: {
  open: boolean;
  phase: TaskDetailReadPhase;
  error: string | null;
  onClose: () => void;
  onRetry: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  return (
    <Dialog open={open} onOpenChange={(nextOpen) => !nextOpen && onClose()}>
      <DialogContent className="sm:max-w-4xl">
        <DialogHeader>
          <DialogTitle>{t(TASK_DETAIL_STATE_LABEL_KEYS[phase])}</DialogTitle>
          {error ? <DialogDescription>{error}</DialogDescription> : null}
        </DialogHeader>
        {phase === 'unavailable' || phase === 'provisioning' ? (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-7 gap-1 text-xs"
            onClick={onRetry}
            aria-label={t('taskDetail.changes.refreshShort')}
          >
            <RefreshCw size={12} />
            {t('taskDetail.changes.refreshShort')}
          </Button>
        ) : null}
      </DialogContent>
    </Dialog>
  );
};
