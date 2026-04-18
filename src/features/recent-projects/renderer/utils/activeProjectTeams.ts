import { normalizePath } from '@renderer/utils/pathNormalize';

import type { TeamSummary } from '@shared/types';

interface BuildActiveTeamsByProjectInput {
  teams: TeamSummary[];
  aliveTeamNames: readonly string[];
  provisioningTeamNames: readonly string[];
  provisioningSnapshotByTeam: Record<string, TeamSummary>;
}

export function buildActiveTeamsByProject({
  teams,
  aliveTeamNames,
  provisioningTeamNames,
  provisioningSnapshotByTeam,
}: BuildActiveTeamsByProjectInput): Map<string, TeamSummary[]> {
  const activeTeamNames = new Set<string>([...aliveTeamNames, ...provisioningTeamNames]);
  if (activeTeamNames.size === 0) {
    return new Map();
  }

  const existingTeamNames = new Set(teams.map((team) => team.teamName));
  const syntheticProvisioningTeams = provisioningTeamNames
    .filter((teamName) => !existingTeamNames.has(teamName))
    .map((teamName) => provisioningSnapshotByTeam[teamName])
    .filter((team): team is TeamSummary => Boolean(team));

  const teamsByProject = new Map<string, TeamSummary[]>();
  const visibleTeams =
    syntheticProvisioningTeams.length > 0 ? [...teams, ...syntheticProvisioningTeams] : teams;

  for (const team of visibleTeams) {
    if (!team.projectPath || !activeTeamNames.has(team.teamName)) {
      continue;
    }

    const key = normalizePath(team.projectPath);
    const existing = teamsByProject.get(key);
    if (existing) {
      existing.push(team);
    } else {
      teamsByProject.set(key, [team]);
    }
  }

  return teamsByProject;
}
