import {
  buildTeamAgentRuntimeSnapshot as buildTeamAgentRuntimeSnapshotHelper,
  type PersistedRuntimeMemberLike,
} from './TeamProvisioningRuntimeSnapshot';
import {
  TeamProvisioningRuntimeStateProjection,
  type TeamProvisioningRuntimeStateProjectionPorts,
  type TeamProvisioningRuntimeStateProjectionState,
} from './TeamProvisioningRuntimeStateProjection';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { TeamProvisioningRuntimeSnapshotResourceSamplingPorts } from './TeamProvisioningRuntimeResourceSampling';
import type { TeamProvisioningAgentRuntimeSnapshotCachePort } from './TeamProvisioningRuntimeSnapshotCache';
import type {
  RuntimeAdapterRunSnapshotSource,
  TeamProvisioningRuntimeSnapshotRun,
} from './TeamProvisioningRuntimeSnapshotTypes';
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
  TeamRuntimeState,
} from '@shared/types';

type BuildTeamAgentRuntimeSnapshotParams = Parameters<
  typeof buildTeamAgentRuntimeSnapshotHelper
>[0];

export interface TeamProvisioningRuntimeSnapshotFacadePorts {
  runs: ReadonlyMap<string, TeamProvisioningRuntimeSnapshotRun>;
  runtimeAdapterRunByTeam: ReadonlyMap<string, RuntimeAdapterRunSnapshotSource>;
  runtimeState: TeamProvisioningRuntimeStateProjectionState;
  runtimeStatePorts: TeamProvisioningRuntimeStateProjectionPorts;
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
  /** Write-free variant, used by `getTeamAgentRuntimeSnapshotReadOnly`. */
  getMemberSpawnStatusesReadOnly(teamName: string): Promise<MemberSpawnStatusesSnapshot>;
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
  createRuntimeSnapshotResourceSamplingPorts(options?: {
    readOnly?: boolean;
  }): TeamProvisioningRuntimeSnapshotResourceSamplingPorts;
  runtimeSnapshotCache: TeamProvisioningAgentRuntimeSnapshotCachePort<TeamAgentRuntimeSnapshot>;
  getTrackedRunId(teamName: string): string | null;
  getAgentRuntimeSnapshotCacheTtlMs(teamName: string, runId: string | null): number;
  buildTeamAgentRuntimeSnapshot?(
    params: BuildTeamAgentRuntimeSnapshotParams
  ): Promise<TeamAgentRuntimeSnapshot>;
  logDebug(message: string): void;
}

interface AgentRuntimeSnapshotInFlightRequest {
  generationAtStart: number;
  runIdAtStart: string | null;
  promise: Promise<TeamAgentRuntimeSnapshot>;
}

function matchesInFlightRequest(
  request: AgentRuntimeSnapshotInFlightRequest | undefined,
  runId: string | null,
  generationAtStart: number
): request is AgentRuntimeSnapshotInFlightRequest {
  return request?.runIdAtStart === runId && request.generationAtStart === generationAtStart;
}

export class TeamProvisioningRuntimeSnapshotFacade {
  private readonly agentRuntimeSnapshotInFlightByTeam = new Map<
    string,
    AgentRuntimeSnapshotInFlightRequest
  >();
  private readonly readOnlyAgentRuntimeSnapshotInFlightByTeam = new Map<
    string,
    AgentRuntimeSnapshotInFlightRequest
  >();
  private readonly runtimeStateProjection: TeamProvisioningRuntimeStateProjection;

  constructor(private readonly ports: TeamProvisioningRuntimeSnapshotFacadePorts) {
    this.runtimeStateProjection = new TeamProvisioningRuntimeStateProjection({
      state: ports.runtimeState,
      ports: ports.runtimeStatePorts,
    });
  }

  hasProvisioningRun(teamName: string): boolean {
    return this.runtimeStateProjection.hasProvisioningRun(teamName);
  }

  isTeamAlive(teamName: string): boolean {
    return this.runtimeStateProjection.isTeamAlive(teamName);
  }

  getAliveTeams(): string[] {
    return this.runtimeStateProjection.getAliveTeams();
  }

  getRuntimeState(teamName: string): Promise<TeamRuntimeState> {
    return this.runtimeStateProjection.getRuntimeState(teamName);
  }

  async getTeamAgentRuntimeSnapshot(teamName: string): Promise<TeamAgentRuntimeSnapshot> {
    const runId = this.ports.getTrackedRunId(teamName);
    const cached = this.ports.runtimeSnapshotCache.getCachedAgentRuntimeSnapshot(teamName, runId);
    if (cached) {
      return cached;
    }

    const generationAtStart =
      this.ports.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(teamName);
    const existingRequest = this.agentRuntimeSnapshotInFlightByTeam.get(teamName);
    if (matchesInFlightRequest(existingRequest, runId, generationAtStart)) {
      return existingRequest.promise;
    }

    return this.trackInFlightSnapshot(
      this.agentRuntimeSnapshotInFlightByTeam,
      teamName,
      runId,
      generationAtStart,
      this.buildTeamAgentRuntimeSnapshot(teamName, runId, generationAtStart)
    );
  }

  /**
   * The same snapshot without the writes the normal path performs: the member
   * spawn statuses come from the read-only projection (the mutating one
   * persists launch state and syncs it back into a live run), the result is not
   * remembered in the shared cache, and the shared telemetry history is not
   * pruned. A caller that supplies no projection of its own is still served a
   * cached snapshot, and a build already in flight for the same run and cache
   * generation is shared rather than started twice.
   *
   * A caller that has already made the read-only status projection - the HTTP
   * diagnostics route reports it alongside this snapshot - passes it in through
   * `memberSpawnStatuses` instead of paying for a second one. The read-only
   * projection neither coalesces nor fills a cache, so without this the two
   * halves of one response were two independent projections that could describe
   * two different runs. Such a caller is therefore answered only by a build of
   * its own. The cache and both in-flight maps are keyed by team, run and cache
   * generation, and no part of that key records which projection produced the
   * runtime members, so an entry for the very same run can still have been built
   * from an earlier read of the statuses: serving it, joining it, or publishing
   * this build for the next poll to join would all pair one caller's statuses
   * with another's runtime members, which is the defect above in a different
   * order.
   */
  async getTeamAgentRuntimeSnapshotReadOnly(
    teamName: string,
    options?: { memberSpawnStatuses?: MemberSpawnStatusesSnapshot }
  ): Promise<TeamAgentRuntimeSnapshot> {
    const runId = this.ports.getTrackedRunId(teamName);
    const projectedStatuses = options?.memberSpawnStatuses;
    const sharesOtherBuilds = projectedStatuses === undefined;
    const cached = sharesOtherBuilds
      ? this.ports.runtimeSnapshotCache.getCachedAgentRuntimeSnapshot(teamName, runId)
      : undefined;
    if (cached) {
      return cached;
    }
    const generationAtStart =
      this.ports.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(teamName);
    if (sharesOtherBuilds) {
      // Riding a build the UI already started performs no write of its own and
      // keeps a monitor poll from doubling the process sampling work.
      const mutatingRequest = this.agentRuntimeSnapshotInFlightByTeam.get(teamName);
      if (matchesInFlightRequest(mutatingRequest, runId, generationAtStart)) {
        return mutatingRequest.promise;
      }
      const existingRequest = this.readOnlyAgentRuntimeSnapshotInFlightByTeam.get(teamName);
      if (matchesInFlightRequest(existingRequest, runId, generationAtStart)) {
        return existingRequest.promise;
      }
    }

    const build = this.buildTeamAgentRuntimeSnapshot(teamName, runId, generationAtStart, {
      readOnly: true,
      ...(projectedStatuses ? { memberSpawnStatuses: projectedStatuses } : {}),
    });
    if (!sharesOtherBuilds) {
      // Built from the caller's own projection, so it is that caller's alone:
      // publishing it would hand the next poll a snapshot made from statuses it
      // never asked for.
      return build;
    }
    return this.trackInFlightSnapshot(
      this.readOnlyAgentRuntimeSnapshotInFlightByTeam,
      teamName,
      runId,
      generationAtStart,
      build
    );
  }

  private trackInFlightSnapshot(
    inFlightByTeam: Map<string, AgentRuntimeSnapshotInFlightRequest>,
    teamName: string,
    runId: string | null,
    generationAtStart: number,
    build: Promise<TeamAgentRuntimeSnapshot>
  ): Promise<TeamAgentRuntimeSnapshot> {
    const request = build.finally(() => {
      if (inFlightByTeam.get(teamName)?.promise === request) {
        inFlightByTeam.delete(teamName);
      }
    });
    inFlightByTeam.set(teamName, {
      generationAtStart,
      runIdAtStart: runId,
      promise: request,
    });
    return request;
  }

  private async buildTeamAgentRuntimeSnapshot(
    teamName: string,
    runId: string | null,
    generationAtStart: number,
    options?: { readOnly?: boolean; memberSpawnStatuses?: MemberSpawnStatusesSnapshot }
  ): Promise<TeamAgentRuntimeSnapshot> {
    const buildSnapshot =
      this.ports.buildTeamAgentRuntimeSnapshot ?? buildTeamAgentRuntimeSnapshotHelper;
    // The read-only build takes the write-free history port: it reports the
    // series a member already has instead of appending this poll's sample to
    // the history every other reader shares, and it prunes nothing - pruning is
    // keyed by the keys one build happened to resolve, so a poll that misses a
    // member's pid would drop that member's whole accumulated series and
    // restart its sparkline at a single sample.
    const samplingPorts = this.ports.createRuntimeSnapshotResourceSamplingPorts(
      options?.readOnly === true ? { readOnly: true } : undefined
    );
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
      getMemberSpawnStatuses: async (targetTeamName) => {
        const projected = options?.memberSpawnStatuses;
        if (projected && targetTeamName === teamName) {
          return projected;
        }
        return options?.readOnly === true
          ? this.ports.getMemberSpawnStatusesReadOnly(targetTeamName)
          : this.ports.getMemberSpawnStatuses(targetTeamName);
      },
      getLiveTeamAgentRuntimeMetadata: (targetTeamName) =>
        this.ports.getLiveTeamAgentRuntimeMetadata(targetTeamName),
      ...samplingPorts,
      agentRuntimeResourceHistory: samplingPorts.agentRuntimeResourceHistory,
      getRuntimeSnapshotCacheGeneration: (targetTeamName) =>
        this.ports.runtimeSnapshotCache.getRuntimeSnapshotCacheGeneration(targetTeamName),
      getTrackedRunId: (targetTeamName) => this.ports.getTrackedRunId(targetTeamName),
      getAgentRuntimeSnapshotCacheTtlMs: (targetTeamName, targetRunId) =>
        this.ports.getAgentRuntimeSnapshotCacheTtlMs(targetTeamName, targetRunId),
      rememberAgentRuntimeSnapshot: (params) => {
        if (options?.readOnly !== true) {
          this.ports.runtimeSnapshotCache.rememberAgentRuntimeSnapshot(params);
        }
      },
      logDebug: (message) => this.ports.logDebug(message),
    });
  }
}
