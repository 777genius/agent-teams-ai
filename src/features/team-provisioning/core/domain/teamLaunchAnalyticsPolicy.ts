import type {
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
  TeamViewSnapshot,
} from '@shared/types';

export type TeamLaunchAnalyticsStep =
  | 'config_validation'
  | 'runtime_prepare'
  | 'member_spawn'
  | 'bootstrap'
  | 'ready_check';

export interface TeamLaunchAnalyticsContext {
  startedAtMs: number;
  memberCount: number | null;
  providerIds: (string | null)[];
}

export function getTeamCreateAnalyticsProviderIds(
  request: Pick<TeamCreateRequest, 'providerId' | 'members'>
): (string | null)[] {
  return request.members.map((member) => member.providerId ?? request.providerId ?? null);
}

export function getTeamSnapshotAnalyticsProviderIds(
  data: TeamViewSnapshot | null | undefined
): (string | null)[] {
  if (!data) return [];
  return data.members.map((member) => member.providerId ?? null);
}

export function buildTeamCreateLaunchAnalyticsContext(
  request: TeamCreateRequest,
  startedAtMs: number
): TeamLaunchAnalyticsContext {
  return {
    startedAtMs,
    memberCount: request.members.length,
    providerIds: getTeamCreateAnalyticsProviderIds(request),
  };
}

export function buildTeamLaunchAnalyticsContext(
  request: TeamLaunchRequest,
  data: TeamViewSnapshot | null,
  startedAtMs: number
): TeamLaunchAnalyticsContext {
  const providerIds = getTeamSnapshotAnalyticsProviderIds(data);
  return {
    startedAtMs,
    memberCount: data?.members.length ?? null,
    providerIds: providerIds.length > 0 ? providerIds : [request.providerId ?? null],
  };
}

export function getTeamLaunchAnalyticsStep(
  state: TeamProvisioningProgress['state']
): TeamLaunchAnalyticsStep {
  if (state === 'validating') return 'config_validation';
  if (state === 'spawning') return 'runtime_prepare';
  if (state === 'configuring' || state === 'assembling') return 'member_spawn';
  if (state === 'finalizing') return 'bootstrap';
  return 'ready_check';
}

export function getTeamLaunchAnalyticsTimestampMs(value: string | undefined): number | null {
  const timestamp = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(timestamp) ? timestamp : null;
}
