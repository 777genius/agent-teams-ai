import { useCallback, useEffect, useMemo, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';
import { taskDetailKey, useTaskDetailSession } from '@features/team-task-detail/renderer';
import { useStore } from '@renderer/store';
import {
  selectResolvedMembersForTeamName,
  selectTeamDataForName,
} from '@renderer/store/slices/teamSlice';
import { buildTaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import { ExternalLink } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { shouldKeepGlobalTaskDialogLoading } from './globalTaskDetailDialogLoading';
import { TaskDetailDialog } from './TaskDetailDialog';

import type { ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

const EMPTY_TARGET_MEMBERS: readonly ResolvedTeamMember[] = [];

/**
 * Global wrapper around TaskDetailDialog.
 * Mounted at layout level so it can be opened from anywhere (e.g. sidebar)
 * without navigating to the team page first.
 */
export const GlobalTaskDetailDialog = (): React.JSX.Element | null => {
  const { t } = useAppTranslation('team');
  const {
    globalTaskDetail,
    closeGlobalTaskDetail,
    targetTeamData,
    targetMembers,
    setTaskDetailSurfaceInterest,
    taskDetailEntry,
    openTeamTab,
    setPendingReviewRequest,
  } = useStore(
    useShallow((s) => {
      const detail =
        s.globalTaskDetail?.contextId === s.activeContextId ? s.globalTaskDetail : null;
      return {
        globalTaskDetail: detail,
        closeGlobalTaskDetail: s.closeGlobalTaskDetail,
        targetTeamData: detail ? selectTeamDataForName(s, detail.teamName) : null,
        targetMembers: detail
          ? selectResolvedMembersForTeamName(s, detail.teamName)
          : EMPTY_TARGET_MEMBERS,
        setTaskDetailSurfaceInterest: s.setTaskDetailSurfaceInterest,
        taskDetailEntry: detail ? s.taskDetailById[taskDetailKey(detail)] : undefined,
        openTeamTab: s.openTeamTab,
        setPendingReviewRequest: s.setPendingReviewRequest,
      };
    })
  );

  const teamName = globalTaskDetail?.teamName ?? '';
  const taskId = globalTaskDetail?.taskId ?? '';
  const commentId = globalTaskDetail?.commentId;
  const hasTargetTeamData = Boolean(targetTeamData);
  const identity = useMemo(
    () =>
      globalTaskDetail
        ? {
            contextId: globalTaskDetail.contextId,
            teamName: globalTaskDetail.teamName,
            taskId: globalTaskDetail.taskId,
          }
        : null,
    [globalTaskDetail]
  );
  const fallbackIdentity = useMemo(() => ({ contextId: '', teamName: '', taskId: '' }), []);
  const surfaceIdRef = useRef(crypto.randomUUID());
  const sessionController = useTaskDetailSession({
    identity: identity ?? fallbackIdentity,
    surfaceId: surfaceIdRef.current,
    currentTask: taskDetailEntry?.full ?? null,
    enabled: Boolean(identity),
  });

  useEffect(() => {
    const surfaceId = surfaceIdRef.current;
    setTaskDetailSurfaceInterest(surfaceId, identity);
    return () => setTaskDetailSurfaceInterest(surfaceId, null);
  }, [identity, setTaskDetailSurfaceInterest]);

  const isFullTeamLoaded = hasTargetTeamData;

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    if (!globalTaskDetail) return map;
    for (const preview of targetTeamData?.tasks ?? []) map.set(preview.id, preview);
    if (taskDetailEntry?.full) map.set(taskDetailEntry.full.id, taskDetailEntry.full);
    return map;
  }, [globalTaskDetail, targetTeamData?.tasks, taskDetailEntry?.full]);

  const activeMembers = useMemo(() => targetMembers.filter((m) => !m.removedAt), [targetMembers]);

  const handleOpenTeam = useCallback((): void => {
    if (!identity || identity.contextId !== useStore.getState().activeContextId) return;
    closeGlobalTaskDetail();
    openTeamTab(identity.teamName, undefined, identity.taskId);
  }, [closeGlobalTaskDetail, identity, openTeamTab]);

  const handleOpenTaskTab = useCallback((): void => {
    if (sessionController.openInTaskTab()) closeGlobalTaskDetail();
  }, [closeGlobalTaskDetail, sessionController]);

  const handleViewChanges = useCallback(
    (viewTaskId: string, filePath?: string) => {
      if (!identity || identity.contextId !== useStore.getState().activeContextId) return;
      const targetTask = taskMap.get(viewTaskId);
      if (!targetTask) return;
      setPendingReviewRequest({
        taskId: viewTaskId,
        filePath,
        requestOptions: buildTaskChangeRequestOptions(targetTask),
      });
      closeGlobalTaskDetail();
      openTeamTab(teamName);
    },
    [closeGlobalTaskDetail, identity, openTeamTab, setPendingReviewRequest, taskMap, teamName]
  );

  if (!globalTaskDetail) return null;

  const task = taskDetailEntry?.full ?? null;
  const kanbanTaskState = targetTeamData?.kanbanState.tasks[taskId];
  const loading = shouldKeepGlobalTaskDialogLoading({
    teamName,
    taskId,
    selectedTeamName: teamName,
    selectedTeamDataPresent: hasTargetTeamData,
    selectedTeamLoading: taskDetailEntry?.loading ?? false,
    selectedTeamError: taskDetailEntry?.error ?? null,
    hasTaskInMap: Boolean(taskDetailEntry?.full),
  });

  return (
    <TaskDetailDialog
      open
      variant={isFullTeamLoaded ? 'team' : 'global'}
      loading={!isFullTeamLoaded && loading}
      task={task}
      teamName={teamName}
      projectPath={targetTeamData?.config.projectPath ?? null}
      sessionController={sessionController}
      kanbanTaskState={kanbanTaskState}
      taskMap={taskMap}
      members={activeMembers}
      onClose={closeGlobalTaskDetail}
      onOwnerChange={undefined}
      onViewChanges={isFullTeamLoaded ? handleViewChanges : undefined}
      onOpenInTaskTab={identity ? handleOpenTaskTab : undefined}
      focusCommentId={commentId}
      headerExtra={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
          onClick={handleOpenTeam}
        >
          <ExternalLink size={12} />
          {t('dialogs.actions.openTeam')}
        </button>
      }
    />
  );
};
