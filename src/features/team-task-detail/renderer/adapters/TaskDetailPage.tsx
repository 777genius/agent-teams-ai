import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { confirm } from '@renderer/components/common/ConfirmDialog';
import { Button } from '@renderer/components/ui/button';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import { deriveTaskDisplayId } from '@shared/utils/taskIdentity';
import { RefreshCw } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { taskDetailKey } from '../../core';
import { useTaskDetailPresentation } from '../hooks/useTaskDetailPresentation';
import { useTaskDetailSession } from '../hooks/useTaskDetailSession';
import { TaskDetailContent } from '../ui/TaskDetailContent';

import type { TaskDetailIdentity, TaskDetailReadPhase } from '../../contracts';
import type { TeamTaskWithKanban } from '@shared/types';

const FALLBACK_TASK: TeamTaskWithKanban = {
  id: '',
  subject: '',
  status: 'pending',
};

export interface TaskDetailPageProps {
  identity: TaskDetailIdentity;
  isActive: boolean;
  isPaneFocused: boolean;
  surfaceId: string;
}

export const TaskDetailPage = ({
  identity,
  isActive,
  surfaceId,
}: TaskDetailPageProps): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const { contextId, teamName, taskId } = identity;
  const identityRef = useRef(identity);
  identityRef.current = identity;
  const {
    activeContextId,
    ensureTaskDetail,
    entry,
    openTaskDetailTab,
    openTeamTab,
    setPendingReviewRequest,
    softDeleteTask,
    teamData,
    updateTaskOwner,
  } = useStore(
    useShallow((state) => ({
      activeContextId: state.activeContextId,
      ensureTaskDetail: state.ensureTaskDetail,
      entry: state.taskDetailById[taskDetailKey(identity)],
      openTaskDetailTab: state.openTaskDetailTab,
      openTeamTab: state.openTeamTab,
      setPendingReviewRequest: state.setPendingReviewRequest,
      softDeleteTask: state.softDeleteTask,
      teamData: selectTeamDataForName(state, identity.teamName),
      updateTaskOwner: state.updateTaskOwner,
    }))
  );
  const members = useStore(
    useShallow((state) =>
      selectResolvedMembersForTeamName(state, teamName).filter((member) => !member.removedAt)
    )
  );
  const currentTask = activeContextId === contextId ? (entry?.full ?? null) : null;
  const sessionController = useTaskDetailSession({
    identity,
    surfaceId,
    currentTask,
    enabled:
      isActive &&
      activeContextId === identity.contextId &&
      Boolean(identity.teamName.trim() && identity.taskId.trim()),
  });

  useEffect(() => {
    if (!isActive || activeContextId !== contextId) return;
    void ensureTaskDetail({ contextId, teamName, taskId });
  }, [activeContextId, contextId, ensureTaskDetail, isActive, taskId, teamName]);

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    for (const task of teamData?.tasks ?? []) map.set(task.id, task);
    if (currentTask) map.set(currentTask.id, currentTask);
    return map;
  }, [currentTask, teamData?.tasks]);
  const presentationTask = currentTask ?? FALLBACK_TASK;

  const handleTaskNavigate = useCallback(
    (taskId: string) => {
      if (!sessionController.isOriginCurrent()) return;
      openTaskDetailTab({ ...identityRef.current, taskId });
    },
    [openTaskDetailTab, sessionController]
  );
  const handleViewChanges = useCallback(
    (taskId: string, filePath?: string) => {
      if (!sessionController.isOriginCurrent()) return;
      const task = taskMap.get(taskId);
      if (!task) return;
      setPendingReviewRequest({
        taskId,
        filePath,
        requestOptions: buildTaskChangeRequestOptions(task),
      });
      openTeamTab(identity.teamName);
    },
    [identity.teamName, openTeamTab, sessionController, setPendingReviewRequest, taskMap]
  );
  const handleDeleteTask = useCallback(
    (taskId: string) => {
      void (async () => {
        const confirmed = await confirm({
          title: t('tasks.deleteConfirm.title'),
          message: t('tasks.deleteConfirm.message', { taskId: deriveTaskDisplayId(taskId) }),
          confirmLabel: t('tasks.deleteConfirm.confirmLabel'),
          cancelLabel: t('tasks.deleteConfirm.cancelLabel'),
          variant: 'danger',
        });
        if (!confirmed || !sessionController.canEditNow()) return;
        try {
          await softDeleteTask(identity.teamName, taskId);
        } catch {
          // Store exposes the mutation error without adding a second error source.
        }
      })();
    },
    [identity.teamName, sessionController, softDeleteTask, t]
  );

  const phase = activeContextId !== contextId ? 'unavailable' : (entry?.phase ?? 'hydrating');
  const headingText =
    currentTask?.subject ?? `${identity.teamName} #${deriveTaskDisplayId(identity.taskId)}`;
  const presentation = useTaskDetailPresentation({
    active: isActive,
    currentTask: presentationTask,
    enabled: isActive && Boolean(currentTask),
    kanbanTaskState: teamData?.kanbanState.tasks[identity.taskId],
    members,
    onOpenChangeFile: (filePath) => handleViewChanges(presentationTask.id, filePath),
    onTaskNavigate: handleTaskNavigate,
    projectPath: teamData?.config.projectPath ?? null,
    sessionController,
    taskMap,
    teamName: identity.teamName,
  });

  if (!currentTask) {
    return (
      <TaskPageState
        heading={headingText}
        phase={phase}
        error={activeContextId === contextId ? (entry?.error ?? null) : null}
        onRetry={() => void ensureTaskDetail(identity)}
      />
    );
  }

  return (
    <div
      ref={presentation.actions.setRootElement}
      className="min-h-0 flex-1 overflow-y-auto bg-surface px-6 py-5"
      data-task-detail-page
      data-origin-current={sessionController.isOriginCurrent() ? 'true' : 'false'}
    >
      {phase === 'deleted' || phase === 'unavailable' || phase === 'provisioning' ? (
        <PageStateBanner
          phase={phase}
          error={entry?.error ?? null}
          onRetry={() => void ensureTaskDetail(identity)}
        />
      ) : null}
      <TaskDetailContent
        key={taskDetailKey(identity)}
        actions={presentation.actions}
        model={presentation.model}
        onDeleteTask={handleDeleteTask}
        onOwnerChange={(taskId, owner) => {
          if (sessionController.canEditNow()) {
            void updateTaskOwner(identity.teamName, taskId, owner).catch(() => undefined);
          }
        }}
        onViewChanges={handleViewChanges}
        renderDescription={(content) => (
          <p className="text-sm text-[var(--color-text-secondary)]">{content}</p>
        )}
        renderHeading={(props) => (
          <h1 {...props} className={`${props.className} text-xl`}>
            {props.children}
          </h1>
        )}
        sessionController={sessionController}
        showTeamIO
      />
    </div>
  );
};

const TaskPageState = ({
  heading,
  phase,
  error,
  onRetry,
}: {
  heading: string;
  phase: TaskDetailReadPhase;
  error: string | null;
  onRetry: () => void;
}): React.JSX.Element => {
  return (
    <main className="flex min-h-0 flex-1 flex-col overflow-y-auto bg-surface px-6 py-5">
      <h1 className="text-xl">{heading}</h1>
      <PageStateBanner phase={phase} error={error} onRetry={onRetry} />
    </main>
  );
};

const PageStateBanner = ({
  phase,
  error,
  onRetry,
}: {
  phase: TaskDetailReadPhase;
  error: string | null;
  onRetry?: () => void;
}): React.JSX.Element => {
  const { t } = useAppTranslation('team');
  const labels = {
    deleted: t('taskDetail.page.deleted'),
    hydrating: t('taskDetail.loading.title'),
    missing: t('taskDetail.notFound'),
    provisioning: t('taskDetail.page.provisioning'),
    ready: t('taskDetail.loading.title'),
    unavailable: t('taskDetail.page.unavailable'),
  } as const;
  return (
    <section
      className="mb-4 rounded-md border border-[var(--color-border)] bg-[var(--color-surface-raised)] px-3 py-2 text-sm"
      role={phase === 'unavailable' ? 'alert' : 'status'}
    >
      <div className="flex items-center gap-2">
        <strong>{labels[phase]}</strong>
        {error ? <span className="min-w-0 text-xs text-red-400">{error}</span> : null}
        {onRetry && (phase === 'unavailable' || phase === 'hydrating') ? (
          <Button variant="ghost" size="sm" className="ml-auto h-7 gap-1 text-xs" onClick={onRetry}>
            <RefreshCw size={12} />
            {t('taskDetail.changes.refreshShort')}
          </Button>
        ) : null}
      </div>
    </section>
  );
};
