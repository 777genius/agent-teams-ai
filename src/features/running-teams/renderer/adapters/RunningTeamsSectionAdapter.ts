import { getTeamColorSet } from '@renderer/constants/teamColors';
import { getBaseName } from '@renderer/utils/pathUtils';
import { nameColorSet } from '@renderer/utils/projectColor';

import type { RunningTeamDashboardEntry } from '../../core/domain/policies/buildRunningTeamsDashboard';
import type { TaskStatusCounts } from '@renderer/utils/pathNormalize';

export interface RunningTeamRowModel {
  id: string;
  teamName: string;
  displayName: string;
  projectPath?: string;
  projectLabel: string;
  status: RunningTeamDashboardEntry['status'];
  statusLabel: string;
  iconColor: string;
  taskCounts?: TaskStatusCounts;
}

function getStatusLabel(status: RunningTeamDashboardEntry['status']): string {
  switch (status) {
    case 'active':
      return 'Active';
    case 'provisioning':
      return 'Launching';
    case 'idle':
      return 'Running';
  }
}

function getProjectLabel(projectPath?: string): string {
  if (!projectPath) {
    return 'No project';
  }

  return getBaseName(projectPath) || projectPath;
}

export function adaptRunningTeamsSection(
  teams: RunningTeamDashboardEntry[]
): RunningTeamRowModel[] {
  return teams.map((team) => ({
    id: team.teamName,
    teamName: team.teamName,
    displayName: team.displayName,
    projectPath: team.projectPath,
    projectLabel: getProjectLabel(team.projectPath),
    status: team.status,
    statusLabel: getStatusLabel(team.status),
    iconColor: team.color
      ? getTeamColorSet(team.color).border
      : nameColorSet(team.displayName).border,
    taskCounts: team.taskCounts,
  }));
}
