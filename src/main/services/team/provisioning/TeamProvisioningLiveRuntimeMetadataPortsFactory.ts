import {
  buildLiveTeamAgentRuntimeMetadata,
  type PersistedRuntimeMemberLike,
  type RuntimeAdapterRunSnapshotSource,
  type TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshot';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';

type BuildLiveTeamAgentRuntimeMetadataParams = Parameters<
  typeof buildLiveTeamAgentRuntimeMetadata
>[0];

export interface TeamProvisioningLiveRuntimeMetadataInFlightEntry {
  generationAtStart: number;
  runIdAtStart: string | null;
  promise: Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
}

export interface TeamProvisioningLiveRuntimeMetadataPorts {
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
}

export type TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps = Omit<
  BuildLiveTeamAgentRuntimeMetadataParams,
  'teamName' | 'runId' | 'generationAtStart'
> & {
  runs: ReadonlyMap<string, TeamProvisioningRuntimeSnapshotRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  liveTeamAgentRuntimeMetadataInFlightByTeam?: Map<
    string,
    TeamProvisioningLiveRuntimeMetadataInFlightEntry
  >;
};

export function createTeamProvisioningLiveRuntimeMetadataPorts(
  deps: TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps
): TeamProvisioningLiveRuntimeMetadataPorts {
  const {
    liveTeamAgentRuntimeMetadataInFlightByTeam = new Map<
      string,
      TeamProvisioningLiveRuntimeMetadataInFlightEntry
    >(),
    ...buildDeps
  } = deps;

  return {
    async getLiveTeamAgentRuntimeMetadata(
      teamName: string
    ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
      const runId = buildDeps.getTrackedRunId(teamName);
      const cached = buildDeps.liveTeamAgentRuntimeMetadataCache.get(teamName);
      if (cached && cached.expiresAtMs > Date.now() && cached.runId === runId) {
        return buildDeps.cloneLiveTeamAgentRuntimeMetadata(cached.metadata);
      }

      const generationAtStart = buildDeps.getRuntimeSnapshotCacheGeneration(teamName);
      const existingRequest = liveTeamAgentRuntimeMetadataInFlightByTeam.get(teamName);
      if (existingRequest?.runIdAtStart === runId) {
        return buildDeps.cloneLiveTeamAgentRuntimeMetadata(await existingRequest.promise);
      }

      const request = buildLiveTeamAgentRuntimeMetadata({
        ...buildDeps,
        teamName,
        runId,
        generationAtStart,
      }).finally(() => {
        if (liveTeamAgentRuntimeMetadataInFlightByTeam.get(teamName)?.promise === request) {
          liveTeamAgentRuntimeMetadataInFlightByTeam.delete(teamName);
        }
      });
      liveTeamAgentRuntimeMetadataInFlightByTeam.set(teamName, {
        generationAtStart,
        runIdAtStart: runId,
        promise: request,
      });
      return buildDeps.cloneLiveTeamAgentRuntimeMetadata(await request);
    },
  };
}
