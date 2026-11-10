import type { TaskDetailReadEntry } from '@features/team-task-detail/core';

type GlobalTaskDialogReadState = Pick<
  TaskDetailReadEntry,
  'identity' | 'phase' | 'full' | 'error' | 'loading' | 'refreshPending'
>;

interface GlobalTaskDialogLoadingParams {
  identity: GlobalTaskDialogReadState['identity'] | null;
  taskDetail: GlobalTaskDialogReadState | null;
}

export function hasSelectedTargetTeamData(
  targetTeamName: string,
  selectedTeamName: string | null,
  selectedDataTeamName: string | null | undefined
): boolean {
  return selectedTeamName === targetTeamName && selectedDataTeamName === targetTeamName;
}

export function shouldKeepGlobalTaskDialogLoading({
  identity,
  taskDetail,
}: GlobalTaskDialogLoadingParams): boolean {
  if (!identity?.teamName || !identity.taskId) return false;
  if (!taskDetail) return true;
  if (
    taskDetail.identity.contextId !== identity.contextId ||
    taskDetail.identity.teamName !== identity.teamName ||
    taskDetail.identity.taskId !== identity.taskId
  )
    return true;
  if (taskDetail.full) return false;
  if (
    taskDetail.error ||
    taskDetail.phase === 'missing' ||
    taskDetail.phase === 'deleted' ||
    taskDetail.phase === 'unavailable'
  )
    return false;
  return (
    taskDetail.loading ||
    taskDetail.refreshPending ||
    taskDetail.phase === 'hydrating' ||
    taskDetail.phase === 'provisioning'
  );
}
