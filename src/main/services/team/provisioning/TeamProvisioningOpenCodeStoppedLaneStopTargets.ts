import { isStopLaunchFreshness, type TeamLaunchFreshness } from '../TeamLaunchFreshness';

import type { AttributedCursorAgentProcess } from '../opencode/bridge/CursorAgentAttributionRecords';
import type { OpenCodeRuntimeLaneIndex } from '../opencode/store/OpenCodeRuntimeManifestEvidenceReader';
import type { TeamLaunchRuntimeAdapter } from '../runtime/TeamRuntimeAdapter';
import type { PersistedTeamLaunchSnapshot } from '@shared/types';

export function shouldSkipStoppedTeamOpenCodeLaneCleanup(input: {
  canDeliverToTeamRuntime: boolean;
  freshness: TeamLaunchFreshness | null;
}): boolean {
  return input.canDeliverToTeamRuntime && !isStopLaunchFreshness(input.freshness);
}

export function selectStoppedTeamOpenCodeRuntimeLaneIds(
  laneIndex: Pick<OpenCodeRuntimeLaneIndex, 'lanes'> | null | undefined
): string[] {
  return Object.entries(laneIndex?.lanes ?? {})
    .filter(([, entry]) => entry.state === 'active' || entry.state === 'degraded')
    .map(([laneId]) => laneId)
    .sort((left, right) => left.localeCompare(right));
}

export function collectOpenCodeStoppedLaneStopRunIds(input: {
  teamName: string;
  laneId: string;
  manifestRunId?: string | null;
  launchStateRunId?: string | null;
  attributed?: readonly AttributedCursorAgentProcess[];
}): string[] {
  const ids: string[] = [];
  const seen = new Set<string>();
  const add = (value: string | null | undefined): void => {
    const runId = value?.trim();
    if (!runId || seen.has(runId)) {
      return;
    }
    seen.add(runId);
    ids.push(runId);
  };

  add(input.manifestRunId);
  add(input.launchStateRunId);
  for (const entry of input.attributed ?? []) {
    for (const owner of entry.owners) {
      const team = owner.teamId?.trim() || owner.teamName?.trim();
      if (team !== input.teamName) {
        continue;
      }
      if ((owner.laneId?.trim() || '') !== input.laneId) {
        continue;
      }
      add(owner.runId);
    }
  }
  return ids;
}

export function isStoppedTeamOpenCodeLaneOwnershipCurrent(input: {
  canDeliverToTeamRuntime: boolean;
  freshness: TeamLaunchFreshness | null;
  expectedRunId: string | null;
  currentRunId: string | null;
  targetedRunIds?: readonly string[];
}): boolean {
  if (shouldSkipStoppedTeamOpenCodeLaneCleanup(input)) {
    return false;
  }
  const currentRunId = input.currentRunId?.trim() || null;
  const expectedRunId = input.expectedRunId?.trim() || null;
  if (currentRunId === expectedRunId) {
    return true;
  }
  return Boolean(currentRunId && input.targetedRunIds?.includes(currentRunId));
}

export async function stopLeftoverOpenCodeSecondaryLaneRuns(input: {
  adapter: Pick<TeamLaunchRuntimeAdapter, 'stop'>;
  teamName: string;
  laneId: string;
  nextRunId: string;
  cwd?: string;
  previousLaunchState: PersistedTeamLaunchSnapshot | null;
  attributed?: readonly AttributedCursorAgentProcess[];
  manifestRunId?: string | null;
}): Promise<void> {
  const launchStateRunId = Object.values(input.previousLaunchState?.members ?? {}).find(
    (member) => member.laneId === input.laneId
  )?.runtimeRunId;
  const leftoverRunIds = collectOpenCodeStoppedLaneStopRunIds({
    teamName: input.teamName,
    laneId: input.laneId,
    manifestRunId: input.manifestRunId,
    launchStateRunId,
    attributed: input.attributed,
  }).filter((runId) => runId !== input.nextRunId);

  for (const runId of leftoverRunIds) {
    try {
      await input.adapter.stop({
        runId,
        laneId: input.laneId,
        teamName: input.teamName,
        cwd: input.cwd,
        providerId: 'opencode',
        reason: 'cleanup',
        previousLaunchState: input.previousLaunchState,
        force: true,
      });
    } catch {
      // Best-effort: launch still has dead-runtime recovery if the leftover host remains.
    }
  }
}
