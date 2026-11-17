/**
 * Persistent history mode of a *logical team*.
 *
 * A team's working directory or a teammate's worktree isolation is not this mode.
 */
export type { TeamProjectContextMode } from '@shared/types/team';
import type { TeamProjectContextMode } from '@shared/types/team';

/** Navigation must not expose a native team alias before its owner is verified. */
export type TeamProjectContextView =
  | { mode: 'shared'; state: 'ready'; executionTeamName: string }
  | { mode: 'per_project'; state: 'needs_project' | 'empty' | 'pending' }
  | {
      mode: 'per_project';
      state: 'ready';
      executionTeamName: string;
      workContextId: string;
      projectPath: string;
    };

export const TEAM_PROJECT_CONTEXT_VIEW_CHANNEL = 'team:projectContextView';

export interface TeamProjectContextViewApi {
  getProjectContextView(
    logicalTeamName: string,
    projectPath?: string | null
  ): Promise<TeamProjectContextView>;
  setProjectContextMode(logicalTeamName: string, mode: TeamProjectContextMode): Promise<void>;
}

export const TEAM_PROJECT_CONTEXT_SET_MODE_CHANNEL = 'team:projectContextMode:set';
