/**
 * Persistent history mode of a *logical team*.
 *
 * A team's working directory or a teammate's worktree isolation is not this mode.
 */
export type { TeamProjectContextMode } from '@shared/types/team';

/** Navigation must not expose a native team alias before its owner is verified. */
export type TeamProjectContextView =
  | { mode: 'shared'; state: 'ready'; executionTeamName: string }
  | { mode: 'per_project'; state: 'redirect'; logicalTeamName: string; projectPath: string }
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
}

/**
 * What a team name is for edits, schedules and launch:
 * - `logical`: the user-visible team of the per-project mode; its definition is the only authority.
 * - `alias`: a native project copy; a projection, never edited or launched directly.
 * - `native`: any other team (legacy/shared); unchanged behavior.
 */
export type TeamKind = 'logical' | 'alias' | 'native';
