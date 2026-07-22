import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningStatusQueryCompatibilityFacade } from '../TeamProvisioningStatusQueryCompatibilityFacade';

import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { LiveTeamAgentRuntimeMetadata } from '../TeamProvisioningRuntimeMetadataPolicy';
import type { MemberSpawnStatusEntry, TeamAgentRuntimeSnapshot, TeamConfig } from '@shared/types';

class TestStatusQueryCompatibilityFacade extends TeamProvisioningStatusQueryCompatibilityFacade<ProvisioningRun> {
  readonly readConfigSnapshotMock = vi.fn(async () => {
    return {
      members: [{ name: 'Worker', providerId: 'opencode' }],
    } as TeamConfig;
  });
  readonly getMembersMock = vi.fn(async () => []);
  readonly getTeamAgentRuntimeSnapshotMock = vi.fn(async () => {
    return { teamName: 'alpha' } as unknown as TeamAgentRuntimeSnapshot;
  });
  readonly getRuntimeSnapshotCacheGenerationMock = vi.fn(() => 4);
  readonly getTrackedRunIdMock = vi.fn((teamName: string) =>
    teamName === 'alpha' ? 'run-1' : null
  );
  readonly liveRuntimeMetadata = new Map<string, LiveTeamAgentRuntimeMetadata>([
    ['Worker', { alive: true, agentId: 'agent-worker', livenessKind: 'runtime_process' }],
    ['Observer', { alive: false }],
  ]);
  readonly getLiveTeamAgentRuntimeMetadataMock = vi.fn(async () => this.liveRuntimeMetadata);

  protected readonly compatibilityDelegation = {
    configFacade: {
      readConfigSnapshot: this.readConfigSnapshotMock,
    },
  } as unknown as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {} as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly runTracking = {
    getTrackedRunId: this.getTrackedRunIdMock,
  };
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly membersMetaStore = {
    getMembers: this.getMembersMock,
  };
  protected readonly inboxReader = {
    getMessagesFor: vi.fn(async () => []),
  };
  protected readonly runtimeToolActivity = {
    startRuntimeToolActivity: vi.fn(),
    finishRuntimeToolActivity: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    resetRuntimeToolActivity: vi.fn(),
    clearMemberSpawnToolTracking: vi.fn(),
    pauseMemberTaskActivityForRuntimeLoss: vi.fn(),
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    emitToolActivity: vi.fn(),
  };
  protected readonly memberSpawnStatusMutationPorts = {} as never;
  protected readonly memberSpawnStatusAuditPorts = {} as never;
  protected readonly runtimeSnapshotFacade = {
    getTeamAgentRuntimeSnapshot: this.getTeamAgentRuntimeSnapshotMock,
  };
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
  } as never;
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly runtimeSnapshotCacheBoundary = {
    getRuntimeSnapshotCacheGeneration: this.getRuntimeSnapshotCacheGenerationMock,
  };
  protected readonly liveRuntimeMetadataPorts = {
    getLiveTeamAgentRuntimeMetadata: this.getLiveTeamAgentRuntimeMetadataMock,
  };

  getTracked(teamName: string): string | null {
    return this.getTrackedRunId(teamName);
  }

  getCacheGeneration(teamName: string): number {
    return this.getRuntimeSnapshotCacheGeneration(teamName);
  }

  getLiveMetadata(teamName: string): Promise<Map<string, LiveTeamAgentRuntimeMetadata>> {
    return this.getLiveTeamAgentRuntimeMetadata(teamName);
  }

  getLiveNames(teamName: string): Promise<Set<string>> {
    return this.getLiveTeamAgentNames(teamName);
  }

  attachRuntimeMetadata(
    teamName: string,
    statuses: Record<string, MemberSpawnStatusEntry>
  ): Promise<Record<string, MemberSpawnStatusEntry>> {
    return this.attachLiveRuntimeMetadataToStatuses(teamName, statuses);
  }

  protected async findBootstrapTranscriptOutcome() {
    return null;
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized() {
    return {} as never;
  }

  protected getRunLeadName(): string {
    return 'Lead';
  }

  protected emitMemberSpawnChange(): void {}

  protected async persistLaunchStateSnapshot(): Promise<unknown> {
    return null;
  }
}

describe('TeamProvisioningStatusQueryCompatibilityFacade', () => {
  it('keeps tracked-run, cache, and live runtime status queries in a narrow facade', async () => {
    const facade = new TestStatusQueryCompatibilityFacade();

    expect(facade.getTracked('alpha')).toBe('run-1');
    expect(facade.getTracked('beta')).toBeNull();
    expect(facade.getCacheGeneration('alpha')).toBe(4);
    await expect(facade.getLiveMetadata('alpha')).resolves.toBe(facade.liveRuntimeMetadata);
    await expect(facade.getLiveNames('alpha')).resolves.toEqual(new Set(['Worker']));

    expect(facade.getTrackedRunIdMock).toHaveBeenCalledWith('alpha');
    expect(facade.getTrackedRunIdMock).toHaveBeenCalledWith('beta');
    expect(facade.getRuntimeSnapshotCacheGenerationMock).toHaveBeenCalledWith('alpha');
    expect(facade.getLiveTeamAgentRuntimeMetadataMock).toHaveBeenCalledWith('alpha');
  });

  it('attaches live runtime metadata through the extracted status query facade', async () => {
    const facade = new TestStatusQueryCompatibilityFacade();

    const statuses = await facade.attachRuntimeMetadata('alpha', {
      Worker: {
        status: 'waiting',
        launchState: 'starting',
      } as MemberSpawnStatusEntry,
    });

    expect(statuses.Worker).toEqual(
      expect.objectContaining({
        runtimeAlive: true,
      })
    );
    expect(facade.getLiveTeamAgentRuntimeMetadataMock).toHaveBeenCalledWith('alpha');
  });
});
