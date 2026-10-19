import { useCallback, useMemo } from 'react';

import { useStore } from '@renderer/store';
import { selectTeamDataForName } from '@renderer/store/slices/teamSlice';
import {
  captureTaskDetailReadScope,
  isTaskDetailReadScopeCurrent,
} from '@renderer/store/team/taskDetailReadAuthority';
import {
  resolveTaskReferenceCandidate,
  type TaskIdClickHandler,
} from '@renderer/utils/taskReferenceUtils';

import type { TeamTaskWithKanban } from '@shared/types';

/** Preserve the ordinary team dialog and address foreign references explicitly. */
export function useTeamTaskReferenceNavigation(
  teamName: string,
  tasks: readonly TeamTaskWithKanban[],
  openLocalTask: (task: TeamTaskWithKanban) => void
): TaskIdClickHandler {
  const contextId = useStore((state) => state.activeContextId);
  const { contextEpoch, teamStateEpoch } = captureTaskDetailReadScope(teamName, contextId);
  const scope = useMemo(
    () => ({ contextId, teamName, contextEpoch, teamStateEpoch }),
    [contextId, teamName, contextEpoch, teamStateEpoch]
  );
  return useCallback<TaskIdClickHandler>(
    (taskId, referencedTeamName, kind = 'canonical') => {
      const state = useStore.getState();
      if (
        state.isContextSwitching ||
        !isTaskDetailReadScopeCurrent(scope, state.activeContextId, teamName)
      )
        return;
      const targetTeamName = referencedTeamName?.trim() || teamName;
      const candidates =
        targetTeamName === teamName
          ? tasks
          : (selectTeamDataForName(state, targetTeamName)?.tasks ?? []);
      const task = resolveTaskReferenceCandidate(candidates, taskId, kind);
      if (task && targetTeamName === teamName) openLocalTask(task);
      else if (task || (kind === 'canonical' && targetTeamName !== teamName)) {
        state.openGlobalTaskDetail(targetTeamName, task?.id ?? taskId);
      }
    },
    [openLocalTask, scope, tasks, teamName]
  );
}
