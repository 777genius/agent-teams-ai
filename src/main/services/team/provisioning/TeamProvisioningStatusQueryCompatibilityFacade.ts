import { TeamProvisioningMemberStatusQueryFacade } from './TeamProvisioningMemberStatusQueryFacade';
import { type ProvisioningRun } from './TeamProvisioningRunModel';
import { attachLiveRuntimeMetadataToStatuses as attachLiveRuntimeMetadataToStatusesHelper } from './TeamProvisioningRuntimeSnapshot';

import type { LiveTeamAgentRuntimeMetadata } from './TeamProvisioningRuntimeMetadataPolicy';
import type { MemberSpawnStatusEntry } from '@shared/types';

export interface TeamProvisioningStatusQueryRuntimeSnapshotCache {
  getRuntimeSnapshotCacheGeneration(teamName: string): number;
}

export interface TeamProvisioningStatusQueryLiveRuntimeMetadataPorts {
  getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>>;
}

export abstract class TeamProvisioningStatusQueryCompatibilityFacade<
  TRun extends ProvisioningRun = ProvisioningRun,
> extends TeamProvisioningMemberStatusQueryFacade<TRun> {
  protected abstract readonly runtimeSnapshotCacheBoundary: TeamProvisioningStatusQueryRuntimeSnapshotCache;
  protected abstract readonly liveRuntimeMetadataPorts: TeamProvisioningStatusQueryLiveRuntimeMetadataPorts;

  protected getTrackedRunId(teamName: string): string | null {
    return this.runTracking.getTrackedRunId(teamName);
  }

  protected getRuntimeSnapshotCacheGeneration(teamName: string): number {
    return this.runtimeSnapshotCacheBoundary.getRuntimeSnapshotCacheGeneration(teamName);
  }

  protected async attachLiveRuntimeMetadataToStatuses(
    teamName: string,
    statuses: Record<string, MemberSpawnStatusEntry>,
    options?: {
      openCodeSecondaryBootstrapPendingMembers?: ReadonlySet<string>;
    }
  ): Promise<Record<string, MemberSpawnStatusEntry>> {
    const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName);
    return attachLiveRuntimeMetadataToStatusesHelper({
      statuses,
      runtimeByMember,
      openCodeSecondaryBootstrapPendingMembers: options?.openCodeSecondaryBootstrapPendingMembers,
      isOpenCodeBootstrapStallWindowElapsed: (firstSpawnAcceptedAt) =>
        this.isOpenCodeBootstrapStallWindowElapsed(firstSpawnAcceptedAt),
    });
  }

  protected async getLiveTeamAgentNames(teamName: string): Promise<Set<string>> {
    const runtimeByMember = await this.getLiveTeamAgentRuntimeMetadata(teamName);
    return new Set(
      [...runtimeByMember.entries()]
        .filter(([, metadata]) => metadata.alive)
        .map(([memberName]) => memberName)
    );
  }

  protected async getLiveTeamAgentRuntimeMetadata(
    teamName: string
  ): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return this.liveRuntimeMetadataPorts.getLiveTeamAgentRuntimeMetadata(teamName);
  }
}
