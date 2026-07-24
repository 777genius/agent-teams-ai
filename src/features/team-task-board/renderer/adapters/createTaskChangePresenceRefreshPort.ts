import {
  buildTaskChangePresenceKey,
  buildTaskChangeRequestOptions,
  canDisplayTaskChangesForOptions,
} from '@renderer/utils/taskChangeRequest';

import type { TeamTaskBoardPresenceRefreshPort } from '../../core/application/ports/TeamTaskBoardInteractionPorts';
import type { TaskChangeRequestOptions, TeamViewSnapshot } from '@shared/types';

interface TaskChangePresenceState {
  selectedTeamName: string | null;
  selectedTeamData: TeamViewSnapshot | null;
  invalidateTaskChangePresence?: (cacheKeys: string[]) => void;
  checkTaskHasChanges?: (
    teamName: string,
    taskId: string,
    options: TaskChangeRequestOptions
  ) => Promise<unknown>;
}

export function createTaskChangePresenceRefreshPort(
  getState: () => TaskChangePresenceState
): TeamTaskBoardPresenceRefreshPort {
  return {
    refreshAfterTaskTransition: async (teamName, taskId) => {
      const state = getState();
      if (state.selectedTeamName !== teamName || !state.selectedTeamData) return;

      const task = state.selectedTeamData.tasks.find((candidate) => candidate.id === taskId);
      if (!task) return;

      const options = buildTaskChangeRequestOptions(task);
      if (!canDisplayTaskChangesForOptions(options)) return;
      if (!state.invalidateTaskChangePresence || !state.checkTaskHasChanges) return;

      state.invalidateTaskChangePresence([buildTaskChangePresenceKey(teamName, taskId, options)]);
      try {
        await state.checkTaskHasChanges(teamName, taskId, options);
      } catch {
        // Best-effort refresh after an explicit task transition.
      }
    },
  };
}
