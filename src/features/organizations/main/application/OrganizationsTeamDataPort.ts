import type { GlobalTask, TeamSummary } from '@shared/types';

/** Team data capabilities needed to project organization directory entries. */
export interface OrganizationsTeamDataPort {
  listTeams(): Promise<TeamSummary[]>;
  getAllTasks(): Promise<GlobalTask[]>;
  listAliveProcessTeams(): Promise<string[]>;
}
