import { useCallback, useEffect, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { ExternalLink } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TaskDetailDialog } from './TaskDetailDialog';

import type { GlobalTask, TeamTaskWithKanban } from '@shared/types';

/**
 * Global wrapper around TaskDetailDialog.
 * Mounted at layout level so it can be opened from anywhere (e.g. sidebar)
 * without navigating to the team page first.
 */
export const GlobalTaskDetailDialog = (): React.JSX.Element | null => {
  const {
    globalTaskDetail,
    closeGlobalTaskDetail,
    selectedTeamName,
    selectedTeamData,
    selectedTeamLoading,
    selectTeam,
    openTeamTab,
    setPendingReviewRequest,
    globalTasks,
  } = useStore(
    useShallow((s) => ({
      globalTaskDetail: s.globalTaskDetail,
      closeGlobalTaskDetail: s.closeGlobalTaskDetail,
      selectedTeamName: s.selectedTeamName,
      selectedTeamData: s.selectedTeamData,
      selectedTeamLoading: s.selectedTeamLoading,
      selectTeam: s.selectTeam,
      openTeamTab: s.openTeamTab,
      setPendingReviewRequest: s.setPendingReviewRequest,
      globalTasks: s.globalTasks,
    }))
  );

  const teamName = globalTaskDetail?.teamName ?? '';
  const taskId = globalTaskDetail?.taskId ?? '';

  // Load full team data in the background to enable "as before" details (logs/changes/members).
  useEffect(() => {
    if (!globalTaskDetail) return;
    if (!teamName) return;

    // Avoid re-triggering selectTeam in a loop while the fetch is in flight.
    // selectedTeamName is set immediately by selectTeam(), but selectedTeamData
    // remains null until IPC resolves.
    if (selectedTeamName === teamName) {
      if (selectedTeamData || selectedTeamLoading) return;
      // Retry once if we are on the right team but have no data and not loading (e.g. prior error).
    }

    void selectTeam(teamName, { skipProjectAutoSelect: true });
  }, [
    globalTaskDetail,
    selectTeam,
    selectedTeamData,
    selectedTeamLoading,
    selectedTeamName,
    teamName,
  ]);

  const isFullTeamLoaded = selectedTeamName === teamName && !!selectedTeamData;
  const isThisTeamLoading =
    selectedTeamName === teamName && selectedTeamLoading && !selectedTeamData;

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    if (!globalTaskDetail) return map;
    if (isFullTeamLoaded && selectedTeamData) {
      for (const t of selectedTeamData.tasks) map.set(t.id, t);
      return map;
    }
    for (const t of globalTasks) {
      if (t.teamName === globalTaskDetail.teamName) {
        map.set(t.id, t);
      }
    }
    return map;
  }, [globalTaskDetail, globalTasks, isFullTeamLoaded, selectedTeamData]);

  const activeMembers = useMemo(
    () => (isFullTeamLoaded ? (selectedTeamData?.members.filter((m) => !m.removedAt) ?? []) : []),
    [isFullTeamLoaded, selectedTeamData]
  );

  const handleOpenTeam = useCallback((): void => {
    closeGlobalTaskDetail();
    openTeamTab(teamName, undefined, taskId);
  }, [closeGlobalTaskDetail, openTeamTab, teamName, taskId]);

  const handleViewChanges = useCallback(
    (viewTaskId: string, filePath?: string) => {
      setPendingReviewRequest({ taskId: viewTaskId, filePath });
      closeGlobalTaskDetail();
      openTeamTab(teamName);
    },
    [closeGlobalTaskDetail, openTeamTab, setPendingReviewRequest, teamName]
  );

  if (!globalTaskDetail) return null;

  const task = (taskMap.get(taskId) as GlobalTask | undefined) ?? null;
  const kanbanTaskState = isFullTeamLoaded
    ? selectedTeamData?.kanbanState.tasks[taskId]
    : undefined;

  return (
    <TaskDetailDialog
      open
      variant={isFullTeamLoaded ? 'team' : 'global'}
      loading={!isFullTeamLoaded && isThisTeamLoading}
      task={task}
      teamName={teamName}
      kanbanTaskState={kanbanTaskState}
      taskMap={taskMap}
      members={activeMembers}
      onClose={closeGlobalTaskDetail}
      onOwnerChange={undefined}
      onViewChanges={isFullTeamLoaded ? handleViewChanges : undefined}
      headerExtra={
        <button
          type="button"
          className="inline-flex items-center gap-1.5 rounded-md border border-[var(--color-border)] px-3 py-1.5 text-xs text-[var(--color-text-secondary)] transition-colors hover:bg-[var(--color-surface-raised)] hover:text-[var(--color-text)]"
          onClick={handleOpenTeam}
        >
          <ExternalLink size={12} />
          Open team
        </button>
      }
    />
  );
};
