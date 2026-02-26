import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { ExternalLink } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';

import { TaskDetailDialog } from './TaskDetailDialog';

import type { TeamTaskWithKanban } from '@shared/types';

/**
 * Global wrapper around TaskDetailDialog.
 * Mounted at layout level so it can be opened from anywhere (e.g. sidebar)
 * without navigating to the team page first.
 */
export const GlobalTaskDetailDialog = (): React.JSX.Element | null => {
  const {
    globalTaskDetail,
    closeGlobalTaskDetail,
    selectedTeamData,
    selectedTeamLoading,
    openTeamTab,
    setPendingReviewRequest,
  } = useStore(
    useShallow((s) => ({
      globalTaskDetail: s.globalTaskDetail,
      closeGlobalTaskDetail: s.closeGlobalTaskDetail,
      selectedTeamData: s.selectedTeamData,
      selectedTeamLoading: s.selectedTeamLoading,
      openTeamTab: s.openTeamTab,
      setPendingReviewRequest: s.setPendingReviewRequest,
    }))
  );

  const taskMap = useMemo(() => {
    const map = new Map<string, TeamTaskWithKanban>();
    if (!selectedTeamData) return map;
    for (const t of selectedTeamData.tasks) map.set(t.id, t);
    return map;
  }, [selectedTeamData]);

  const activeMembers = useMemo(
    () => selectedTeamData?.members.filter((m) => !m.removedAt) ?? [],
    [selectedTeamData]
  );

  const teamName = globalTaskDetail?.teamName ?? '';
  const taskId = globalTaskDetail?.taskId ?? '';

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

  const task = taskMap.get(taskId) ?? null;
  const kanbanTaskState = selectedTeamData?.kanbanState.tasks[taskId];

  return (
    <TaskDetailDialog
      open
      task={selectedTeamLoading ? null : task}
      teamName={teamName}
      kanbanTaskState={kanbanTaskState}
      taskMap={taskMap}
      members={activeMembers}
      onClose={closeGlobalTaskDetail}
      onOwnerChange={undefined}
      onViewChanges={handleViewChanges}
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
