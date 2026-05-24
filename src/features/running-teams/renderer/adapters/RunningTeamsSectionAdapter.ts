import { getTeamColorSet } from '@renderer/constants/teamColors';
import { getBaseName } from '@renderer/utils/pathUtils';
import { nameColorSet } from '@renderer/utils/projectColor';

import type { RunningTeamDashboardEntry } from '../../core/domain/policies/buildRunningTeamsDashboard';
import type { useAppTranslation } from '@features/localization/renderer';
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

type TeamT = ReturnType<typeof useAppTranslation>['t'];

function getStatusLabel(status: RunningTeamDashboardEntry['status'], t: TeamT): string {
  switch (status) {
    case 'active':
      return t('runningTeams.status.active');
    case 'provisioning':
      return t('runningTeams.status.launching');
    case 'idle':
      return t('runningTeams.status.running');
  }
}

function getProjectLabel(projectPath: string | undefined, t: TeamT): string {
  if (!projectPath) {
    return t('runningTeams.noProject');
  }

  return getBaseName(projectPath) || projectPath;
}

export function adaptRunningTeamsSection(
  teams: RunningTeamDashboardEntry[],
  t: TeamT
): RunningTeamRowModel[] {
  return teams.map((team) => ({
    id: team.teamName,
    teamName: team.teamName,
    displayName: team.displayName,
    projectPath: team.projectPath,
    projectLabel: getProjectLabel(team.projectPath, t),
    status: team.status,
    statusLabel: getStatusLabel(team.status, t),
    iconColor: team.color
      ? getTeamColorSet(team.color).border
      : nameColorSet(team.displayName).border,
    taskCounts: team.taskCounts,
  }));
}
