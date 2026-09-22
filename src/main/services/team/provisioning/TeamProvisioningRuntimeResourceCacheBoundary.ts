import { type PersistedTeamConfigCacheEntry } from './TeamProvisioningPersistedTeamConfigAccess';
import {
  type RuntimeResourceSamplingCacheAccess,
  type RuntimeResourceSamplingLogPorts,
  type TeamProvisioningRuntimeResourceSampling,
} from './TeamProvisioningRuntimeResourceSampling';
import { createTeamProvisioningRuntimeResourceSamplingForService } from './TeamProvisioningRuntimeResourceSamplingCompatibilityFacade';
import {
  type TeamProvisioningExpiringRuntimeSnapshotCacheEntry,
  type TeamProvisioningLiveRuntimeMetadataCacheEntry,
  type TeamProvisioningMemberSpawnStatusesInFlightEntry,
  type TeamProvisioningMemberSpawnStatusesSnapshotCacheEntry,
  TeamProvisioningRuntimeSnapshotCacheBoundary,
} from './TeamProvisioningRuntimeSnapshotCache';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { MemberSpawnStatusesSnapshot, TeamAgentRuntimeSnapshot } from '@shared/types';

export interface TeamProvisioningRuntimeResourceCacheBoundaryPorts {
  getTrackedRunId(teamName: string): string | null;
  logDebug(message: string): void;
  createRuntimeResourceSampling?(
    cacheAccess: RuntimeResourceSamplingCacheAccess,
    logPorts: RuntimeResourceSamplingLogPorts
  ): TeamProvisioningRuntimeResourceSampling;
}

export interface TeamProvisioningRuntimeResourceCacheBoundary {
  persistedTeamConfigCache: Map<string, PersistedTeamConfigCacheEntry>;
  liveTeamAgentRuntimeMetadataCache: Map<
    string,
    TeamProvisioningLiveRuntimeMetadataCacheEntry<Map<string, LiveTeamAgentRuntimeMetadata>>
  >;
  memberSpawnStatusesSnapshotCache: Map<
    string,
    TeamProvisioningMemberSpawnStatusesSnapshotCacheEntry<MemberSpawnStatusesSnapshot>
  >;
  memberSpawnStatusesInFlightByTeam: Map<
    string,
    TeamProvisioningMemberSpawnStatusesInFlightEntry<MemberSpawnStatusesSnapshot>
  >;
  runtimeSnapshotCacheBoundary: TeamProvisioningRuntimeSnapshotCacheBoundary<
    TeamAgentRuntimeSnapshot,
    Map<string, LiveTeamAgentRuntimeMetadata>,
    MemberSpawnStatusesSnapshot,
    PersistedTeamConfigCacheEntry
  >;
  runtimeResourceSampling: TeamProvisioningRuntimeResourceSampling;
  invalidateRuntimeSnapshotCaches(teamName: string): void;
}

export function createTeamProvisioningRuntimeResourceCacheBoundary(
  ports: TeamProvisioningRuntimeResourceCacheBoundaryPorts
): TeamProvisioningRuntimeResourceCacheBoundary {
  const agentRuntimeSnapshotCache = new Map<
    string,
    TeamProvisioningExpiringRuntimeSnapshotCacheEntry<TeamAgentRuntimeSnapshot>
  >();
  const liveTeamAgentRuntimeMetadataCache = new Map<
    string,
    TeamProvisioningLiveRuntimeMetadataCacheEntry<Map<string, LiveTeamAgentRuntimeMetadata>>
  >();
  const persistedTeamConfigCache = new Map<string, PersistedTeamConfigCacheEntry>();
  const memberSpawnStatusesSnapshotCache = new Map<
    string,
    TeamProvisioningMemberSpawnStatusesSnapshotCacheEntry<MemberSpawnStatusesSnapshot>
  >();
  const memberSpawnStatusesInFlightByTeam = new Map<
    string,
    TeamProvisioningMemberSpawnStatusesInFlightEntry<MemberSpawnStatusesSnapshot>
  >();
  const runtimeSnapshotCacheBoundary = new TeamProvisioningRuntimeSnapshotCacheBoundary<
    TeamAgentRuntimeSnapshot,
    Map<string, LiveTeamAgentRuntimeMetadata>,
    MemberSpawnStatusesSnapshot,
    PersistedTeamConfigCacheEntry
  >({
    agentRuntimeSnapshotCache,
    liveTeamAgentRuntimeMetadataCache,
    persistedTeamConfigCache,
    memberSpawnStatusesSnapshotCache,
    memberSpawnStatusesInFlightByTeam,
  });
  const runtimeResourceSampling = (
    ports.createRuntimeResourceSampling ?? createTeamProvisioningRuntimeResourceSamplingForService
  )(
    {
      getRuntimeSnapshotCacheGeneration: (teamName) =>
        runtimeSnapshotCacheBoundary.getRuntimeSnapshotCacheGeneration(teamName),
      getTrackedRunId: (teamName) => ports.getTrackedRunId(teamName),
    },
    { logDebug: (message) => ports.logDebug(message) }
  );

  return {
    persistedTeamConfigCache,
    liveTeamAgentRuntimeMetadataCache,
    memberSpawnStatusesSnapshotCache,
    memberSpawnStatusesInFlightByTeam,
    runtimeSnapshotCacheBoundary,
    runtimeResourceSampling,
    invalidateRuntimeSnapshotCaches(teamName) {
      runtimeSnapshotCacheBoundary.invalidateRuntimeSnapshotCaches(teamName);
    },
  };
}
