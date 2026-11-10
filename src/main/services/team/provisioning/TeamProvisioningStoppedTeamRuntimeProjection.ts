import { isStopLaunchFreshness, type TeamLaunchFreshness } from '../TeamLaunchFreshness';

import type { TeamAgentRuntimeEntry, TeamAgentRuntimeSnapshot } from '@shared/types';

export function shouldStripStoppedTeamRuntimeResources(input: {
  isTeamAlive: boolean;
  hasProvisioningRun: boolean;
  freshnessKind?: TeamLaunchFreshness['kind'] | null;
}): boolean {
  return (
    input.isTeamAlive !== true &&
    input.hasProvisioningRun !== true &&
    isStopLaunchFreshness(input.freshnessKind)
  );
}

const STOPPED_TEAM_RUNTIME_RESOURCE_KEYS = [
  'rssBytes',
  'cpuPercent',
  'primaryRssBytes',
  'primaryCpuPercent',
  'childRssBytes',
  'childCpuPercent',
  'processCount',
  'runtimeLoadScope',
  'runtimeLoadTruncated',
  'resourceHistory',
] as const satisfies ReadonlyArray<keyof TeamAgentRuntimeEntry>;

function hasStoppedTeamRuntimeResources(entry: TeamAgentRuntimeEntry): boolean {
  return STOPPED_TEAM_RUNTIME_RESOURCE_KEYS.some((key) => entry[key] != null);
}

function stripStoppedTeamRuntimeResources(entry: TeamAgentRuntimeEntry): TeamAgentRuntimeEntry {
  if (!hasStoppedTeamRuntimeResources(entry)) {
    return entry;
  }

  const next: TeamAgentRuntimeEntry = { ...entry };
  for (const key of STOPPED_TEAM_RUNTIME_RESOURCE_KEYS) {
    delete next[key];
  }
  return next;
}

function projectStoppedTeamRuntimeMember(entry: TeamAgentRuntimeEntry): TeamAgentRuntimeEntry {
  const stripped = stripStoppedTeamRuntimeResources(entry);
  if (stripped.alive === false) {
    return stripped;
  }
  return { ...stripped, alive: false };
}

export function projectStoppedTeamRuntimeResources(
  snapshot: TeamAgentRuntimeSnapshot
): TeamAgentRuntimeSnapshot {
  let changed = false;
  const members: Record<string, TeamAgentRuntimeEntry> = {};
  for (const [memberName, entry] of Object.entries(snapshot.members)) {
    const next = projectStoppedTeamRuntimeMember(entry);
    members[memberName] = next;
    if (next !== entry) {
      changed = true;
    }
  }
  return changed ? { ...snapshot, members } : snapshot;
}

export function applyStoppedTeamRuntimeResources(input: {
  snapshot: TeamAgentRuntimeSnapshot;
  isTeamAlive: boolean;
  hasProvisioningRun: boolean;
  freshnessKind?: TeamLaunchFreshness['kind'] | null;
}): TeamAgentRuntimeSnapshot {
  if (
    !shouldStripStoppedTeamRuntimeResources({
      isTeamAlive: input.isTeamAlive,
      hasProvisioningRun: input.hasProvisioningRun,
      freshnessKind: input.freshnessKind,
    })
  ) {
    return input.snapshot;
  }
  return projectStoppedTeamRuntimeResources(input.snapshot);
}
