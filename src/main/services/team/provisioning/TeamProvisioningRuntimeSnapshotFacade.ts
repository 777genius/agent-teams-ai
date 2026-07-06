import {
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
  type RuntimeAdapterRunSnapshotSource,
  type TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshot';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningRuntimeSnapshotResourceSamplingPorts } from './TeamProvisioningRuntimeResourceSampling';
import type { TeamProvisioningAgentRuntimeSnapshotCachePort } from './TeamProvisioningRuntimeSnapshotCache';
import type {
  MemberSpawnStatusesSnapshot,
  PersistedTeamLaunchSnapshot,
  ProviderModelLaunchIdentity,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamFastMode,
  TeamMember,
  TeamProviderBackendId,
  TeamProviderId,
} from '@shared/types';

type BuildTeamAgentRuntimeSnapshotParams = Parameters<
  typeof buildTeamAgentRuntimeSnapshotHelper
>[0];

export interface TeamProvisioningRuntimeSnapshotFacadePorts {
  runs: ReadonlyMap<string, TeamProvisioningRuntimeSnapshotRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
  teamMetaStore: {
    getMeta(teamName: string): Promise<{
      providerId?: TeamProviderId;
      providerBackendId?: TeamProviderBackendId | string;
      fastMode?: TeamFastMode;
      launchIdentity?: ProviderModelLaunchIdentity;
    } | null>;
  };
  membersMetaStore: {
    getMembers(teamName: string): Promise<TeamMember[]>;
  };
  launchStateStore: {
    read(teamName: string): Promise<PersistedTeamLaunchSnapshot | null>;
  };
  readConfigSnapshot(teamName: string): Promise<TeamConfig | null>;
  readPersistedRuntimeMembers(teamName: string): PersistedRuntimeMemberLike[];
  getMemberSpawnStatuses(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  createRuntimeSnapshotResourceSamplingPorts(): TeamProvisioningRuntimeSnapshotResourceSamplingPorts;
  runtimeSnapshotCache: TeamProvisioningAgentRuntimeSnapshotCachePort<TeamAgentRuntimeSnapshot>;
  getTrackedRunId(teamName: string): string | null;
  getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number;
  buildTeamAgentRuntimeSnapshot?(
    params: BuildTeamAgentRuntimeSnapshotParams
  ): Promise<TeamAgentRuntimeSnapshot>;
  logDebug(message: string): void;
}

export class TeamProvisioningRuntimeSnapshotFacade {
  private readonly agentRuntimeSnapshotInFlightByTeam = new Map<
    string,
    {
      generationAtStart: number;
      runIdAtStart: string | null;
      promise: Promise<TeamAgentRuntimeSnapshot>;
    }
  >();

  constructor(private readonly ports: TeamProvisioningRuntimeSnapshotFacadePorts) {}

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    const runId = this.ports.getTrackedRunId(teamName);
    const cached = this.ports.runtimeSnapshotCache.getCachedAgentRuntimeSnapshot(teamName, runId);
    if (cached) {
      return cached;
    }

    const generationAtStart =
      this.ports.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(teamName);
    const existingRequest = this.agentRuntimeSnapshotInFlightByTeam.get(teamName);
    if (existingRequest?.runIdAtStart === runId) {
      return existingRequest.promise;
    }

    const request = this.buildTeamAgentRuntimeSnapshot(teamName, runId, generationAtStart).finally(
      () => {
        if (this.agentRuntimeSnapshotInFlightByTeam.get(teamName)?.promise === request) {
          this.agentRuntimeSnapshotInFlightByTeam.delete(teamName);
        }
      }
    );
    this.agentRuntimeSnapshotInFlightByTeam.set(teamName, {
      generationAtStart,
      runIdAtStart: runId,
      promise: request,
    });
    return request;
  }

  private async buildTeamAgentRuntimeSnapshot(
    teamName: string,
    runId: string | null,
    generationAtStart: number
  ): Promise<TeamAgentRuntimeSnapshot> {
    const buildSnapshot =
      this.ports.buildTeamAgentRuntimeSnapshot ?? buildTeamAgentRuntimeSnapshotHelper;
    return buildSnapshot({
      teamName,
      runId,
      generationAtStart,
      runs: this.ports.runs,
      runtimeAdapterRunByTeam: this.ports.runtimeAdapterRunByTeam,
      teamMetaStore: this.ports.teamMetaStore,
      membersMetaStore: this.ports.membersMetaStore,
      launchStateStore: this.ports.launchStateStore,
      readConfigSnapshot: (targetTeamName) => this.ports.readConfigSnapshot(targetTeamName),
      readPersistedRuntimeMembers: (targetTeamName) =>
        this.ports.readPersistedRuntimeMembers(targetTeamName),
      getMemberSpawnStatuses: (targetTeamName) => this.ports.getMemberSpawnStatuses(targetTeamName),
      getLiveTeamAgentRuntimeMetadata: (targetTeamName) =>
        this.ports.getLiveTeamAgentRuntimeMetadata(targetTeamName),
      ...this.ports.createRuntimeSnapshotResourceSamplingPorts(),
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.ports.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.ports.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.ports.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      rememberAgentRuntimeSnapshot: (params) =>
        this.ports.runtimeSnapshotCache.rememberAgentRuntimeSnapshot(params),
      logDebug: (message) => this.ports.logDebug(message),
    });
  }
}
