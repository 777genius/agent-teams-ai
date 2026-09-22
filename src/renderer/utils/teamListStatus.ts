import type { LeadActivityState, TeamProvisioningProgress, TeamSummary } from '@shared/types';

export type TeamStatus =
  | 'active'
  | 'idle'
  | 'provisioning'
  | 'offline'
  | 'partial_failure'
  | 'partial_skipped'
  | 'partial_pending';

const ACTIVE_PROVISIONING_STATES = new Set<TeamProvisioningProgress['state']>([
  'validating',
  'spawning',
  'configuring',
  'assembling',
  'finalizing',
  'verifying',
]);

const READY_RUNNING_GRACE_MS = 45_000;

const STOPPED_PROVISIONING_STATES = new Set<TeamProvisioningProgress['state']>([
  'cancelled',
  'disconnected',
]);

function isRecentReadyProgress(
  currentProgress: TeamProvisioningProgress | null,
  nowMs: number
): boolean {
  if (currentProgress?.state !== 'ready') {
    return false;
  }

  const updatedAtMs = Date.parse(currentProgress.updatedAt);
  return Number.isFinite(updatedAtMs) && nowMs - updatedAtMs <= READY_RUNNING_GRACE_MS;
}

export function resolveTeamStatus(
  team: TeamSummary,
  teamName: string,
  aliveTeams: string[],
  currentProgress: TeamProvisioningProgress | null,
  leadActivityByTeam: Partial<Record<string, LeadActivityState>>,
  nowMs: number = Date.now()
): TeamStatus {
  if (currentProgress && ACTIVE_PROVISIONING_STATES.has(currentProgress.state)) {
    return 'provisioning';
  }

  const leadActivity = leadActivityByTeam[teamName];
  if (leadActivity === 'offline') {
    return 'offline';
  }

  // The renderer keeps an async alive-list cache. After a stop/cancel event,
  // that cache can briefly still include the team, but terminal progress is
  // the fresher signal and should make in-progress UI static immediately.
  if (currentProgress && STOPPED_PROVISIONING_STATES.has(currentProgress.state)) {
    return 'offline';
  }

  if (aliveTeams.includes(teamName)) {
    return leadActivity === 'active' ? 'active' : 'idle';
  }

  if (team.teamLaunchState === 'partial_pending') {
    return 'partial_pending';
  }
  if (team.teamLaunchState === 'partial_skipped') {
    return 'partial_skipped';
  }
  if (team.partialLaunchFailure || team.teamLaunchState === 'partial_failure') {
    return 'partial_failure';
  }

  // The alive-list API is refreshed asynchronously after terminal launch progress.
  // Keep a short optimistic running state to avoid a false Offline flicker between
  // progress=ready and the next authoritative alive-list response.
  if (isRecentReadyProgress(currentProgress, nowMs)) {
    return leadActivity === 'active' ? 'active' : 'idle';
  }

  return 'offline';
}

export function isTeamListStatusRunning(status: TeamStatus): boolean {
  return status !== 'offline' && status !== 'partial_failure' && status !== 'partial_pending';
}
