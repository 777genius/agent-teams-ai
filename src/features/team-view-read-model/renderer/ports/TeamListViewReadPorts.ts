import type { TeamGetDataOptions, TeamViewSnapshot } from '@shared/types';

/**
 * Provider-neutral read capabilities consumed by the team-list presentation.
 * The list intentionally receives only the snapshot read it needs instead of
 * the renderer's legacy aggregate API.
 */
export interface TeamListViewReadPorts {
  readTeamData(teamName: string, options?: TeamGetDataOptions): Promise<TeamViewSnapshot>;
}
