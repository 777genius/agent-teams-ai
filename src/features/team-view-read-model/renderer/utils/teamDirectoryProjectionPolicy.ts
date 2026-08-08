import type { AppConfig, GlobalTask, TeamSummary } from '@shared/types';

export interface TeamSummaryIndexes {
  teamByName: Record<string, TeamSummary>;
  teamBySessionId: Record<string, TeamSummary>;
}

export interface GlobalTaskProjectionNotification {
  oldTasks: GlobalTask[];
  newTasks: GlobalTask[];
  appConfig: AppConfig | null;
  teamByName: Record<string, TeamSummary>;
  isInitialFetch: false;
}

export function buildTeamSummaryIndexes(teams: readonly TeamSummary[]): TeamSummaryIndexes {
  const teamByName: Record<string, TeamSummary> = {};
  const teamBySessionId: Record<string, TeamSummary> = {};

  for (const team of teams) {
    teamByName[team.teamName] = team;
    if (team.leadSessionId) {
      teamBySessionId[team.leadSessionId] = team;
    }
    if (Array.isArray(team.sessionHistory)) {
      for (const sessionId of team.sessionHistory) {
        if (typeof sessionId === 'string' && sessionId) {
          teamBySessionId[sessionId] = team;
        }
      }
    }
  }

  return { teamByName, teamBySessionId };
}

export function removeProvisioningSnapshotsForTeams(
  snapshots: Record<string, TeamSummary>,
  teams: readonly TeamSummary[]
): Record<string, TeamSummary> {
  let nextSnapshots = snapshots;

  for (const team of teams) {
    if (!Object.prototype.hasOwnProperty.call(nextSnapshots, team.teamName)) {
      continue;
    }
    if (nextSnapshots === snapshots) {
      nextSnapshots = { ...snapshots };
    }
    delete nextSnapshots[team.teamName];
  }

  return nextSnapshots;
}

export function buildGlobalTaskProjectionNotification(
  state: {
    appConfig: AppConfig | null;
    globalTasks: GlobalTask[];
    globalTasksInitialized: boolean;
    teamByName: Record<string, TeamSummary>;
  },
  nextGlobalTasks: GlobalTask[]
): GlobalTaskProjectionNotification | null {
  if (!state.globalTasksInitialized || nextGlobalTasks === state.globalTasks) {
    return null;
  }

  return {
    oldTasks: state.globalTasks,
    newTasks: nextGlobalTasks,
    appConfig: state.appConfig,
    teamByName: state.teamByName,
    isInitialFetch: false,
  };
}
