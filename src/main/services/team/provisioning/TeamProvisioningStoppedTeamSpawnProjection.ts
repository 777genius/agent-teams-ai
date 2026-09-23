import { isStopLaunchFreshness, type TeamLaunchFreshness } from '../TeamLaunchFreshness';

import type {
  MemberSpawnStatusEntry,
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSummary,
  TeamLaunchAggregateState,
} from '@shared/types';

export function shouldProjectStoppedTeamSpawn(input: {
  hasTrackedRun: boolean;
  trackedRunId?: string | null;
  freshnessKind?: TeamLaunchFreshness['kind'] | null;
  stoppedRunId?: string | null;
}): boolean {
  if (!isStopLaunchFreshness(input.freshnessKind)) {
    return false;
  }
  if (input.hasTrackedRun !== true) {
    return true;
  }
  const trackedRunId = input.trackedRunId?.trim();
  const stoppedRunId = input.stoppedRunId?.trim();
  return Boolean(trackedRunId && stoppedRunId && trackedRunId === stoppedRunId);
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
  readLaunchFreshness?: (teamName: string) => Promise<TeamLaunchFreshness | null>,
  trackedRunId?: string | null
): Promise<{ statuses: Record<string, MemberSpawnStatusEntry>; stopped: boolean }> {
  if (!readLaunchFreshness) {
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
      trackedRunId,
      freshnessKind: freshness?.kind ?? null,
      stoppedRunId: freshness?.kind === 'stop' ? freshness.stoppedRunId : null,
    })
  ) {
    return { statuses, stopped: false };
  }

  return { statuses: projectStoppedTeamSpawnStatuses(statuses), stopped: true };
}

export async function maybeProjectStoppedCachedSpawnSnapshot(params: {
  teamName: string;
  hasTrackedRun: boolean;
  snapshot: MemberSpawnStatusesSnapshot;
  readLaunchFreshness?: (teamName: string) => Promise<TeamLaunchFreshness | null>;
  summarize: (
    expectedMembers: readonly string[],
    statuses: Record<string, MemberSpawnStatusEntry>
  ) => PersistedTeamLaunchSummary;
  deriveTeamLaunchAggregateState: (summary: PersistedTeamLaunchSummary) => TeamLaunchAggregateState;
}): Promise<MemberSpawnStatusesSnapshot> {
  const projected = await applyStoppedTeamSpawnProjection(
    params.teamName,
    params.hasTrackedRun,
    params.snapshot.statuses,
    params.readLaunchFreshness,
    params.snapshot.runId
  );
  if (!projected.stopped) {
    return params.snapshot;
  }
  const expectedMembers = params.snapshot.expectedMembers ?? Object.keys(projected.statuses);
  const summary = params.summarize(expectedMembers, projected.statuses);
  return {
    ...params.snapshot,
    statuses: projected.statuses,
    expectedMembers,
    summary,
    teamLaunchState: params.deriveTeamLaunchAggregateState(summary),
  };
}
