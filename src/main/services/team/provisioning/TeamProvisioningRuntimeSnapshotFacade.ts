import {
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
  type RuntimeAdapterRunSnapshotSource,
  type TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshot';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningRuntimeSnapshotResourceSamplingPorts } from './TeamProvisioningRuntimeResourceSampling';
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
  agentRuntimeSnapshotCache: Map<
    string,
    { expiresAtMs: number; snapshot: TeamAgentRuntimeSnapshot }
  >;
  getRuntimeSnapshotCacheGeneration(teamName: string): number;
  getTrackedRunId(teamName: string): string | null;
  getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number;
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
    const cached = this.ports.agentRuntimeSnapshotCache.get(teamName);
    if (cached && cached.expiresAtMs > Date.now() && cached.snapshot.runId === runId) {
      return cached.snapshot;
    }

    const generationAtStart = this.ports.getRuntimeSnapshotCacheGeneration(teamName);
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
    return buildTeamAgentRuntimeSnapshotHelper({
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
      agentRuntimeSnapshotCache: this.ports.agentRuntimeSnapshotCache,
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.ports.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.ports.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.ports.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      logDebug: (message) => this.ports.logDebug(message),
    });
  }
}
