import type { TeamLaunchFreshness } from '../TeamLaunchFreshness';
import type { MemberSpawnStatusEntry } from '@shared/types';

export function shouldProjectStoppedTeamSpawn(input: {
  hasTrackedRun: boolean;
  freshnessKind?: TeamLaunchFreshness['kind'] | null;
}): boolean {
  return input.hasTrackedRun !== true && input.freshnessKind === 'stop';
}

export function projectStoppedTeamSpawnStatuses(
  statuses: Record<string, MemberSpawnStatusEntry>
): Record<string, MemberSpawnStatusEntry> {
  const next: Record<string, MemberSpawnStatusEntry> = {};
  for (const [memberName, entry] of Object.entries(statuses)) {
    if (entry.launchState === 'skipped_for_launch' || entry.skippedForLaunch === true) {
      next[memberName] = {
        ...entry,
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
        livenessSource: undefined,
      };
      continue;
    }
    next[memberName] = {
      ...entry,
      status: 'offline',
      runtimeAlive: false,
      livenessSource: undefined,
    };
  }
  return next;
}

export async function applyStoppedTeamSpawnProjection(
  teamName: string,
  hasTrackedRun: boolean,
  statuses: Record<string, MemberSpawnStatusEntry>,
  readLaunchFreshness?: (teamName: string) => Promise<TeamLaunchFreshness | null>
): Promise<{ statuses: Record<string, MemberSpawnStatusEntry>; stopped: boolean }> {
  if (hasTrackedRun || !readLaunchFreshness) {
    return { statuses, stopped: false };
  }

  let freshness: TeamLaunchFreshness | null = null;
  try {
    freshness = await readLaunchFreshness(teamName);
  } catch {
    return { statuses, stopped: false };
  }

  if (
    !shouldProjectStoppedTeamSpawn({
      hasTrackedRun,
      freshnessKind: freshness?.kind ?? null,
    })
  ) {
    return { statuses, stopped: false };
  }

  return { statuses: projectStoppedTeamSpawnStatuses(statuses), stopped: true };
}
