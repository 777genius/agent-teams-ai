export type RunningTeamsCandidateStatus =
  | 'active'
  | 'idle'
  | 'provisioning'
  | 'offline'
  | 'partial_failure'
  | 'partial_skipped'
  | 'partial_pending';

export type RunningTeamDashboardStatus = 'active' | 'idle' | 'provisioning';

export interface RunningTeamTaskCounts {
  pending: number;
  inProgress: number;
  completed: number;
}

export interface RunningTeamCandidate {
  teamName: string;
  displayName: string;
  color?: string;
  projectPath?: string;
  lastActivity: string | null;
  status: RunningTeamsCandidateStatus;
  taskCounts?: RunningTeamTaskCounts;
}

export interface BuildRunningTeamsDashboardInput {
  teams: RunningTeamCandidate[];
  provisioningTeams?: RunningTeamCandidate[];
}

export interface RunningTeamDashboardEntry extends RunningTeamCandidate {
  status: RunningTeamDashboardStatus;
}

const RUNNING_STATUS_PRIORITY: Record<RunningTeamDashboardStatus, number> = {
  active: 0,
  provisioning: 1,
  idle: 2,
};

function isRunningDashboardStatus(
  status: RunningTeamsCandidateStatus
): status is RunningTeamDashboardStatus {
  return status === 'active' || status === 'idle' || status === 'provisioning';
}

function getInProgressTaskCount(team: RunningTeamCandidate): number {
  return team.taskCounts?.inProgress ?? 0;
}

function getLastActivityMs(team: RunningTeamCandidate): number {
  if (!team.lastActivity) {
    return 0;
  }

  const parsed = Date.parse(team.lastActivity);
  return Number.isFinite(parsed) ? parsed : 0;
}

function mergeTeams(
  teams: RunningTeamCandidate[],
  provisioningTeams: RunningTeamCandidate[]
): RunningTeamCandidate[] {
  if (provisioningTeams.length === 0) {
    return teams;
  }

  const existing = new Set(teams.map((team) => team.teamName));
  return [...teams, ...provisioningTeams.filter((team) => !existing.has(team.teamName))];
}

export function buildRunningTeamsDashboard({
  teams,
  provisioningTeams = [],
}: BuildRunningTeamsDashboardInput): RunningTeamDashboardEntry[] {
  return mergeTeams(teams, provisioningTeams)
    .filter((team): team is RunningTeamDashboardEntry => isRunningDashboardStatus(team.status))
    .sort((left, right) => {
      const statusDelta =
        RUNNING_STATUS_PRIORITY[left.status] - RUNNING_STATUS_PRIORITY[right.status];
      if (statusDelta !== 0) {
        return statusDelta;
      }

      const inProgressDelta = getInProgressTaskCount(right) - getInProgressTaskCount(left);
      if (inProgressDelta !== 0) {
        return inProgressDelta;
      }

      const activityDelta = getLastActivityMs(right) - getLastActivityMs(left);
      if (activityDelta !== 0) {
        return activityDelta;
      }

      return left.displayName.localeCompare(right.displayName);
    });
}
