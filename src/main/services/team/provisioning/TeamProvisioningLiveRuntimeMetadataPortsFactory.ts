import {
  buildLiveTeamAgentRuntimeMetadata,
  type PersistedRuntimeMemberLike,
  type RuntimeAdapterRunSnapshotSource,
  type TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshot';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningLiveRuntimeMetadataCachePort } from './TeamProvisioningRuntimeSnapshotCache';

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

export function cloneLiveTeamAgentRuntimeMetadata(
  metadata: ReadonlyMap<string, LiveTeamAgentRuntimeMetadata>
): Map<string, LiveTeamAgentRuntimeMetadata> {
  return new Map(
    [...metadata.entries()].map(([memberName, entry]) => [
      memberName,
      {
        ...entry,
        ...(entry.diagnostics ? { diagnostics: [...entry.diagnostics] } : {}),
      },
    ])
  );
}

export type TeamProvisioningLiveRuntimeMetadataPortsFactoryDeps = Omit<
  BuildLiveTeamAgentRuntimeMetadataParams,
  'teamName' | 'runId' | 'generationAtStart' | 'liveRuntimeMetadataCache'
> & {
  runs: ReadonlyMap<string, TeamProvisioningRuntimeSnapshotRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  liveRuntimeMetadataCache: TeamProvisioningLiveRuntimeMetadataCachePort<
    Map<string, LiveTeamAgentRuntimeMetadata>
  >;
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
      const cached = buildDeps.liveRuntimeMetadataCache.getCachedLiveTeamAgentRuntimeMetadata(
        teamName,
        runId
      );
      if (cached) {
        return cloneLiveTeamAgentRuntimeMetadata(cached);
      }

      const generationAtStart = buildDeps.getRuntimeSnapshotCacheGeneration(teamName);
      const existingRequest = liveTeamAgentRuntimeMetadataInFlightByTeam.get(teamName);
      if (
        existingRequest?.runIdAtStart === runId &&
        existingRequest.generationAtStart === generationAtStart
      ) {
        return cloneLiveTeamAgentRuntimeMetadata(await existingRequest.promise);
      }

      const request = buildLiveTeamAgentRuntimeMetadata({
        ...buildDeps,
        teamName,
        runId,
        generationAtStart,
        liveRuntimeMetadataCache: {
          rememberLiveTeamAgentRuntimeMetadata: (params) =>
            buildDeps.liveRuntimeMetadataCache.rememberLiveTeamAgentRuntimeMetadata({
              ...params,
              metadata: cloneLiveTeamAgentRuntimeMetadata(params.metadata),
            }),
        },
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
      return cloneLiveTeamAgentRuntimeMetadata(await request);
    },
  };
}
