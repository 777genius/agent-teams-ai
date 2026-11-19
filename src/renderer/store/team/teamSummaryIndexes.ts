import type { TeamSummary } from '@shared/types';

/**
 * Visible team rows remain logical, but sessions from verified physical histories
 * retain their native owner identity for navigation and runtime context metrics.
 */
export function buildTeamSummaryIndexes(teams: readonly TeamSummary[]): {
  teamByName: Record<string, TeamSummary>;
  teamBySessionId: Record<string, TeamSummary>;
} {
  const teamByName: Record<string, TeamSummary> = {};
  const teamBySessionId: Record<string, TeamSummary> = {};
  const indexSessions = (
    owner: TeamSummary,
    leadSessionId?: string,
    sessionHistory?: readonly string[]
  ): void => {
    if (leadSessionId) teamBySessionId[leadSessionId] = owner;
    for (const sid of sessionHistory ?? []) {
      if (typeof sid === 'string' && sid) teamBySessionId[sid] = owner;
    }
  };
  for (const team of teams) {
    teamByName[team.teamName] = team;
    indexSessions(team, team.leadSessionId, team.sessionHistory);
    for (const context of team.projectHistoryContexts ?? []) {
      if (!context.leadSessionId && !context.sessionHistory?.length) continue;
      const nativeOwner: TeamSummary = {
        ...team,
        teamName: context.executionTeamName,
        projectPath: context.projectPath,
      };
      indexSessions(nativeOwner, context.leadSessionId, context.sessionHistory);
    }
  }
  return { teamByName, teamBySessionId };
}
