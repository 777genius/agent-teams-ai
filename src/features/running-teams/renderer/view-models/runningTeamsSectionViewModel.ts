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

export interface RunningTeamsSectionText {
  status: Record<RunningTeamDashboardEntry['status'], string>;
  noProject: string;
}

const DEFAULT_TEXT: RunningTeamsSectionText = {
  status: {
    active: 'Active',
    provisioning: 'Launching',
    idle: 'Running',
  },
  noProject: 'No project',
};

function getStatusLabel(
  status: RunningTeamDashboardEntry['status'],
  text: RunningTeamsSectionText
): string {
  switch (status) {
    case 'active':
      return text.status.active;
    case 'provisioning':
      return text.status.provisioning;
    case 'idle':
      return text.status.idle;
  }
}

function getProjectLabel(projectPath: string | undefined, text: RunningTeamsSectionText): string {
  if (!projectPath) {
    return text.noProject;
  }

  return getBaseName(projectPath) || projectPath;
}

export function buildRunningTeamsSectionViewModel(
  teams: RunningTeamDashboardEntry[],
  text: RunningTeamsSectionText = DEFAULT_TEXT
): RunningTeamRowModel[] {
  return teams.map((team) => ({
    id: team.teamName,
    teamName: team.teamName,
    displayName: team.displayName,
    projectPath: team.projectPath,
    projectLabel: getProjectLabel(team.projectPath, text),
    status: team.status,
    statusLabel: getStatusLabel(team.status, text),
    iconColor: team.color
      ? getTeamColorSet(team.color).border
      : nameColorSet(team.displayName).border,
    taskCounts: team.taskCounts,
  }));
}
