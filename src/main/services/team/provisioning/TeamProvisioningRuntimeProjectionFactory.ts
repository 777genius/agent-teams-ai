import {
  createTeamProvisioningLiveRuntimeMetadataPorts,
  type TeamProvisioningLiveRuntimeMetadataPorts,
} from './TeamProvisioningLiveRuntimeMetadataPortsFactory';
import {
  TeamProvisioningRuntimeSnapshotFacade,
  type TeamProvisioningRuntimeSnapshotFacadePorts,
} from './TeamProvisioningRuntimeSnapshotFacade';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningRuntimeResourceSampling } from './TeamProvisioningRuntimeResourceSampling';
import type {
  PersistedRuntimeMemberLike,
  RuntimeAdapterRunSnapshotSource,
  TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshot';
import type {
  TeamProvisioningAgentRuntimeSnapshotCachePort,
  TeamProvisioningLiveRuntimeMetadataCachePort,
} from './TeamProvisioningRuntimeSnapshotCache';
import type {
  TeamProvisioningRuntimeStateProjectionRun,
  TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
} from './TeamProvisioningRuntimeStateProjection';
import type {
  MemberSpawnStatusesSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamProvisioningProgress,
  TeamRuntimeState,
} from '@shared/types';

export interface TeamProvisioningRuntimeProjectionRunTrackingPorts {
  getAliveRunId(teamName: string): string | null;
  getTrackedRunId(teamName: string): string | null;
  getAliveTeamNames(): string[];
  getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number;
}

export interface TeamProvisioningRuntimeProjectionFactoryDeps<
  TRun extends TeamProvisioningRuntimeSnapshotRun & TeamProvisioningRuntimeStateProjectionRun,
  TRuntimeAdapterRun extends RuntimeAdapterRunSnapshotSource &
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
> {
  runs: ReadonlyMap<string, TRun>;
  provisioningRunByTeam: ReadonlyMap<string, string>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, TRuntimeAdapterRun>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  getRetainedProvisioningProgressMap(): ReadonlyMap<string, TeamProvisioningProgress>;
  runTracking: TeamProvisioningRuntimeProjectionRunTrackingPorts;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  readBootstrapRuntimeState(teamName: string): Promise<TeamRuntimeState | null>;
  teamMetaStore: TeamProvisioningRuntimeSnapshotFacadePorts['teamMetaStore'];
  membersMetaStore: TeamProvisioningRuntimeSnapshotFacadePorts['membersMetaStore'];
  launchStateStore: TeamProvisioningRuntimeSnapshotFacadePorts['launchStateStore'];
  readConfigSnapshot: TeamProvisioningRuntimeSnapshotFacadePorts['readConfigSnapshot'];
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLiveTeamAgentRuntimeMetadata?(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  runtimeSnapshotCache: TeamProvisioningAgentRuntimeSnapshotCachePort<TeamAgentRuntimeSnapshot>;
  liveRuntimeMetadataCache: TeamProvisioningLiveRuntimeMetadataCachePort<
    Map<string, LiveTeamAgentRuntimeMetadata>
  >;
  runtimeResourceSampling: Pick<
    TeamProvisioningRuntimeResourceSampling,
    | 'createRuntimeSnapshotResourceSamplingPorts'
    | 'readRuntimeProcessRowsForLiveRuntimeMetadata'
    | 'readWindowsHostProcessRowsForLiveRuntimeMetadata'
  >;
  logDebug(message: string): void;
}

export interface TeamProvisioningRuntimeProjectionServiceHost<
  TRun extends TeamProvisioningRuntimeSnapshotRun & TeamProvisioningRuntimeStateProjectionRun,
  TRuntimeAdapterRun extends RuntimeAdapterRunSnapshotSource &
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
> {
  runs: ReadonlyMap<string, TRun>;
  provisioningRunByTeam: ReadonlyMap<string, string>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, TRuntimeAdapterRun>;
  runtimeAdapterProgressByRunId: ReadonlyMap<string, TeamProvisioningProgress>;
  retainedProvisioningProgressState: {
    getRetainedProvisioningProgressMap(): ReadonlyMap<string, TeamProvisioningProgress>;
  };
  runTracking: TeamProvisioningRuntimeProjectionRunTrackingPorts;
  hasSecondaryRuntimeRuns(teamName: string): boolean;
  teamMetaStore: {
    getMeta: TeamProvisioningRuntimeSnapshotFacadePorts['teamMetaStore']['getMeta'];
  };
  membersMetaStore: {
    getMembers: TeamProvisioningRuntimeSnapshotFacadePorts['membersMetaStore']['getMembers'];
  };
  launchStateStore: {
    read: TeamProvisioningRuntimeSnapshotFacadePorts['launchStateStore']['read'];
  };
  readConfigSnapshot: TeamProvisioningRuntimeSnapshotFacadePorts['readConfigSnapshot'];
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  runtimeSnapshotCacheBoundary: TeamProvisioningAgentRuntimeSnapshotCachePort<TeamAgentRuntimeSnapshot> &
    TeamProvisioningLiveRuntimeMetadataCachePort<Map<string, LiveTeamAgentRuntimeMetadata>>;
  runtimeResourceSampling: TeamProvisioningRuntimeProjectionFactoryDeps<
    TRun,
    TRuntimeAdapterRun
  >['runtimeResourceSampling'];
}

export interface TeamProvisioningRuntimeProjectionServiceHostOptions {
  readBootstrapRuntimeState: TeamProvisioningRuntimeProjectionFactoryDeps<
    never,
    never
  >['readBootstrapRuntimeState'];
  logDebug: TeamProvisioningRuntimeProjectionFactoryDeps<never, never>['logDebug'];
}

export interface TeamProvisioningRuntimeProjection {
  runtimeSnapshotFacade: TeamProvisioningRuntimeSnapshotFacade;
  liveRuntimeMetadataPorts: TeamProvisioningLiveRuntimeMetadataPorts;
}

export function createTeamProvisioningRuntimeProjection<
  TRun extends TeamProvisioningRuntimeSnapshotRun & TeamProvisioningRuntimeStateProjectionRun,
  TRuntimeAdapterRun extends RuntimeAdapterRunSnapshotSource &
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
>(
  deps: TeamProvisioningRuntimeProjectionFactoryDeps<TRun, TRuntimeAdapterRun>
): TeamProvisioningRuntimeProjection {
  const liveRuntimeMetadataPorts = createTeamProvisioningLiveRuntimeMetadataPorts({
    runs: deps.runs,
    runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
    teamMetaStore: deps.teamMetaStore,
    membersMetaStore: deps.membersMetaStore,
    launchStateStore: deps.launchStateStore,
    readConfigSnapshot: deps.readConfigSnapshot,
    readPersistedRuntimeMembers: deps.readPersistedRuntimeMembers,
    liveRuntimeMetadataCache: deps.liveRuntimeMetadataCache,
    readRuntimeProcessRowsForLiveRuntimeMetadata: (input) =>
      deps.runtimeResourceSampling.readRuntimeProcessRowsForLiveRuntimeMetadata(input),
    readWindowsHostProcessRowsForLiveRuntimeMetadata: (teamName) =>
      deps.runtimeResourceSampling.readWindowsHostProcessRowsForLiveRuntimeMetadata(teamName),
    getRuntimeSnapshotCacheGeneration: (teamName) =>
      deps.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(teamName),
    getTrackedRunId: (teamName) => deps.runTracking.getTrackedRunId(teamName),
    getAgentRuntimeSnapshotCacheTtlMs: (teamName, runId) =>
      deps.runTracking.getAgentRuntimeSnapshotCacheTtlMs(teamName, runId),
    logDebug: deps.logDebug,
  });

  const getLiveTeamAgentRuntimeMetadata =
    deps.getLiveTeamAgentRuntimeMetadata ??
    ((teamName: string) => liveRuntimeMetadataPorts.getLiveTeamAgentRuntimeMetadata(teamName));

  const runtimeSnapshotFacade = new TeamProvisioningRuntimeSnapshotFacade({
    runs: deps.runs,
    runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
    runtimeState: {
      provisioningRunByTeam: deps.provisioningRunByTeam,
      runs: deps.runs,
      runtimeAdapterRunByTeam: deps.runtimeAdapterRunByTeam,
      runtimeAdapterProgressByRunId: deps.runtimeAdapterProgressByRunId,
      getRetainedProvisioningProgressMap: deps.getRetainedProvisioningProgressMap,
    },
    runtimeStatePorts: {
      getAliveRunId: (teamName) => deps.runTracking.getAliveRunId(teamName),
      getTrackedRunId: (teamName) => deps.runTracking.getTrackedRunId(teamName),
      getAliveTeamNames: () => deps.runTracking.getAliveTeamNames(),
      hasSecondaryRuntimeRuns: deps.hasSecondaryRuntimeRuns,
      readBootstrapRuntimeState: deps.readBootstrapRuntimeState,
    },
    teamMetaStore: deps.teamMetaStore,
    membersMetaStore: deps.membersMetaStore,
    launchStateStore: deps.launchStateStore,
    readConfigSnapshot: deps.readConfigSnapshot,
    readPersistedRuntimeMembers: deps.readPersistedRuntimeMembers,
    getMemberSpawnStatuses: deps.getMemberSpawnStatuses,
    getLiveTeamAgentRuntimeMetadata,
    createRuntimeSnapshotResourceSamplingPorts: () =>
      deps.runtimeResourceSampling.createRuntimeSnapshotResourceSamplingPorts(),
    runtimeSnapshotCache: deps.runtimeSnapshotCache,
    getTrackedRunId: (teamName) => deps.runTracking.getTrackedRunId(teamName),
    getAgentRuntimeSnapshotCacheTtlMs: (teamName, runId) =>
      deps.runTracking.getAgentRuntimeSnapshotCacheTtlMs(teamName, runId),
    logDebug: deps.logDebug,
  });

  return { runtimeSnapshotFacade, liveRuntimeMetadataPorts };
}

export function createTeamProvisioningRuntimeProjectionDepsFromService<
  TRun extends TeamProvisioningRuntimeSnapshotRun & TeamProvisioningRuntimeStateProjectionRun,
  TRuntimeAdapterRun extends RuntimeAdapterRunSnapshotSource &
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
>(
  service: TeamProvisioningRuntimeProjectionServiceHost<TRun, TRuntimeAdapterRun>,
  options: TeamProvisioningRuntimeProjectionServiceHostOptions
): TeamProvisioningRuntimeProjectionFactoryDeps<TRun, TRuntimeAdapterRun> {
  return {
    runs: service.runs,
    provisioningRunByTeam: service.provisioningRunByTeam,
    runtimeAdapterRunByTeam: service.runtimeAdapterRunByTeam,
    runtimeAdapterProgressByRunId: service.runtimeAdapterProgressByRunId,
    getRetainedProvisioningProgressMap: () =>
      service.retainedProvisioningProgressState.getRetainedProvisioningProgressMap(),
    runTracking: service.runTracking,
    hasSecondaryRuntimeRuns: (teamName) => service.hasSecondaryRuntimeRuns(teamName),
    readBootstrapRuntimeState: options.readBootstrapRuntimeState,
    teamMetaStore: {
      getMeta: (teamName) => service.teamMetaStore.getMeta(teamName),
    },
    membersMetaStore: {
      getMembers: (teamName) => service.membersMetaStore.getMembers(teamName),
    },
    launchStateStore: {
      read: (teamName) => service.launchStateStore.read(teamName),
    },
    readConfigSnapshot: (teamName) => service.readConfigSnapshot(teamName),
    readPersistedRuntimeMembers: (teamName) => service.readPersistedRuntimeMembers(teamName),
    getMemberSpawnStatuses: (teamName) => service.getMemberSpawnStatuses(teamName),
    getLiveTeamAgentRuntimeMetadata: (teamName) =>
      service.getLiveTeamAgentRuntimeMetadata(teamName),
    runtimeSnapshotCache: service.runtimeSnapshotCacheBoundary,
    liveRuntimeMetadataCache: service.runtimeSnapshotCacheBoundary,
    runtimeResourceSampling: service.runtimeResourceSampling,
    logDebug: options.logDebug,
  };
}

export function createTeamProvisioningRuntimeProjectionFromService<
  TRun extends TeamProvisioningRuntimeSnapshotRun & TeamProvisioningRuntimeStateProjectionRun,
  TRuntimeAdapterRun extends RuntimeAdapterRunSnapshotSource &
    TeamProvisioningRuntimeStateProjectionRuntimeAdapterRun,
>(
  service: TeamProvisioningRuntimeProjectionServiceHost<TRun, TRuntimeAdapterRun>,
  options: TeamProvisioningRuntimeProjectionServiceHostOptions
): TeamProvisioningRuntimeProjection {
  return createTeamProvisioningRuntimeProjection<TRun, TRuntimeAdapterRun>(
    createTeamProvisioningRuntimeProjectionDepsFromService(service, options)
  );
}
