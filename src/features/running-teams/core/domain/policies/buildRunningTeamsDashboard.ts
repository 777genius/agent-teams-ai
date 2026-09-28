import { rankRunningTeamFacts } from './rankRunningTeamFacts';

import type { RunningTeamFacts } from './rankRunningTeamFacts';

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

function isRunningDashboardStatus(
  status: RunningTeamsCandidateStatus
): status is RunningTeamDashboardStatus {
  return status === 'active' || status === 'idle' || status === 'provisioning';
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
  const running = mergeTeams(teams, provisioningTeams).filter(
    (team): team is RunningTeamDashboardEntry => isRunningDashboardStatus(team.status)
  );
  const facts: RunningTeamFacts[] = running.map((team) => ({
    targetKey: team.teamName,
    displayName: team.displayName,
    activity: team.status,
    taskCounts: team.taskCounts ? { kind: 'known', counts: team.taskCounts } : { kind: 'unknown' },
    lastActivity: team.lastActivity
      ? { kind: 'known', iso: team.lastActivity }
      : { kind: 'unknown' },
  }));
  const byFact = new Map(facts.map((fact, index) => [fact, running[index]!]));

  return rankRunningTeamFacts(facts).flatMap((fact) => {
    const team = byFact.get(fact);
    return team ? [team] : [];
  });
}
