import type { SecondaryRuntimeRunEntry } from './TeamProvisioningSecondaryRuntimeRuns';

/** Private Host fact: a failed primary deliberately retained these exact secondary runs. */
export interface OpenCodeRetainedSecondaryDelivery {
  ownerRunId: string;
  stopAllTeamsGeneration: number;
  stopTeamGeneration: number;
  lanes: readonly Pick<SecondaryRuntimeRunEntry, 'laneId' | 'runId' | 'memberName'>[];
}

export function hasCurrentRetainedSecondaryOwnership(input: {
  fact: OpenCodeRetainedSecondaryDelivery | undefined;
  ownerRunId: string;
  trackedRunId: string | null | undefined;
  aliveRunId: string | null | undefined;
  primaryRunId: string | null | undefined;
  secondaryRuns: ReadonlyMap<string, SecondaryRuntimeRunEntry> | undefined;
  stopAllTeamsGeneration: number | undefined;
  stopTeamGeneration: number | undefined;
  laneId?: string;
  laneRunId?: string;
}): boolean {
  const fact = input.fact;
  if (
    !fact ||
    fact.ownerRunId !== input.ownerRunId ||
    input.aliveRunId !== input.ownerRunId ||
    (input.trackedRunId && input.trackedRunId !== input.ownerRunId) ||
    input.primaryRunId ||
    fact.stopAllTeamsGeneration !== input.stopAllTeamsGeneration ||
    fact.stopTeamGeneration !== input.stopTeamGeneration
  )
    return false;
  return fact.lanes.some((lane) => {
    if (!lane.laneId.startsWith('secondary:opencode:') || !lane.runId || !lane.memberName)
      return false;
    if (
      input.laneId !== undefined &&
      (input.laneId !== lane.laneId || input.laneRunId !== lane.runId)
    )
      return false;
    const current = input.secondaryRuns?.get(lane.laneId);
    return (
      current?.providerId === 'opencode' &&
      current.runId === lane.runId &&
      current.laneId === lane.laneId &&
      current.memberName === lane.memberName
    );
  });
}
