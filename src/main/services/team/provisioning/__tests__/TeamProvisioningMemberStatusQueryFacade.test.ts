import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningMemberStatusQueryFacade } from '../TeamProvisioningMemberStatusQueryFacade';

import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type {
  InboxMessage,
  MemberSpawnStatus,
  MemberSpawnStatusEntry,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamProvisioningProgress,
} from '@shared/types';

class TestMemberStatusQueryFacade extends TeamProvisioningMemberStatusQueryFacade<ProvisioningRun> {
  readonly readConfigSnapshotMock = vi.fn(async () => {
    return {
      members: [{ name: 'Worker', providerId: 'opencode' }],
    } as TeamConfig;
  });
  readonly getMembersMock = vi.fn(async () => []);
  readonly getTeamAgentRuntimeSnapshotMock = vi.fn(async () => {
    return { teamName: 'alpha' } as unknown as TeamAgentRuntimeSnapshot;
  });
  readonly getMessagesForMock = vi.fn<
    (teamName: string, memberName: string) => Promise<InboxMessage[]>
  >(async () => []);
  readonly reevaluateMemberLaunchStatusMock = vi.fn(async () => undefined);
  readonly mutationPorts = {
    syncMemberTaskActivityForRuntimeTransition: vi.fn(),
    syncMemberLaunchGraceCheck: vi.fn(),
    updateLaunchDiagnostics: vi.fn(),
    appendMemberBootstrapDiagnostic: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
    persistLaunchStateSnapshot: vi.fn(async () => undefined),
  };

  protected readonly compatibilityDelegation = {
    configFacade: {
      readConfigSnapshot: this.readConfigSnapshotMock,
    },
  } as unknown as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {
    isMemberLifecycleOperationActive: vi.fn(() => false),
  } as unknown as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly runTracking = {
    getTrackedRunId: vi.fn((teamName: string) => (teamName === 'alpha' ? 'run-1' : null)),
  };
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly membersMetaStore = {
    getMembers: this.getMembersMock,
  };
  protected readonly inboxReader = {
    getMessagesFor: this.getMessagesForMock,
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
  protected readonly memberSpawnStatusMutationPorts = {
    nowIso: () => '2026-07-08T00:00:00.000Z',
    syncMemberTaskActivityForRuntimeTransition:
      this.mutationPorts.syncMemberTaskActivityForRuntimeTransition,
    syncMemberLaunchGraceCheck: this.mutationPorts.syncMemberLaunchGraceCheck,
    updateLaunchDiagnostics: this.mutationPorts.updateLaunchDiagnostics,
    appendMemberBootstrapDiagnostic: this.mutationPorts.appendMemberBootstrapDiagnostic,
    isCurrentTrackedRun: (run: ProvisioningRun) => this.isCurrentTrackedRun(run),
    emitMemberSpawnChange: this.mutationPorts.emitMemberSpawnChange,
    persistLaunchStateSnapshot: this.mutationPorts.persistLaunchStateSnapshot,
    reportBackgroundPersistenceError: vi.fn(),
  };
  protected readonly memberSpawnStatusAuditPorts = {} as never;
  protected readonly runtimeSnapshotFacade = {
    getTeamAgentRuntimeSnapshot: this.getTeamAgentRuntimeSnapshotMock,
  };
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    createPorts: vi.fn(),
    reevaluateMemberLaunchStatus: this.reevaluateMemberLaunchStatusMock,
  };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();

  getGraceKey(run: ProvisioningRun, memberName: string): string {
    return this.getMemberLaunchGraceKey(run, memberName);
  }

  syncGrace(run: ProvisioningRun, memberName: string, entry: MemberSpawnStatusEntry): void {
    this.syncMemberLaunchGraceCheck(run, memberName, entry);
  }

  pendingTimeoutCount(): number {
    return this.pendingTimeouts.size;
  }

  setSpawn(run: ProvisioningRun, memberName: string, status: MemberSpawnStatus): void {
    this.setMemberSpawnStatus(run, memberName, status);
  }

  failUnconfirmedBootstrapMembers(run: ProvisioningRun, reason: string): void {
    this.markUnconfirmedBootstrapMembersFailed(run, reason);
  }

  refreshFromLeadInbox(run: ProvisioningRun): Promise<void> {
    return this.refreshMemberSpawnStatusesFromLeadInbox(run);
  }

  resolveExpected(
    expectedMembers: readonly string[] | undefined,
    candidateName: string
  ): string | null {
    return this.resolveExpectedLaunchMemberName(expectedMembers, candidateName);
  }

  protected getRunLeadName(): string {
    return 'Lead';
  }

  protected async findBootstrapTranscriptOutcome() {
    return null;
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized() {
    return {} as never;
  }

  protected emitMemberSpawnChange(run: ProvisioningRun, memberName: string): void {
    this.mutationPorts.emitMemberSpawnChange(run, memberName);
  }

  protected async persistLaunchStateSnapshot(): Promise<unknown> {
    return null;
  }
}

function createRun(): ProvisioningRun {
  return {
    runId: 'run-1',
    teamName: 'alpha',
    startedAt: '2026-07-08T00:00:00.000Z',
    progress: {
      runId: 'run-1',
      teamName: 'alpha',
      state: 'spawning',
      message: 'running',
      startedAt: '2026-07-08T00:00:00.000Z',
      updatedAt: '2026-07-08T00:00:00.000Z',
    } as TeamProvisioningProgress,
    onProgress: vi.fn(),
    expectedMembers: ['Worker'],
    isLaunch: false,
    provisioningComplete: false,
    memberSpawnStatuses: new Map(),
    memberSpawnLeadInboxCursorByMember: new Map(),
    lastMemberSpawnAuditAt: 0,
  } as unknown as ProvisioningRun;
}

describe('TeamProvisioningMemberStatusQueryFacade', () => {
  it('delegates member recipient and runtime snapshot queries through focused ports', async () => {
    const facade = new TestMemberStatusQueryFacade();

    await expect(facade.resolveRuntimeRecipientProviderId('alpha', 'Worker')).resolves.toBe(
      'opencode'
    );
    await expect(facade.isOpenCodeRuntimeRecipient('alpha', 'Worker')).resolves.toBe(true);
    await expect(facade.getTeamAgentRuntimeSnapshot('alpha')).resolves.toEqual({
      teamName: 'alpha',
    });

    expect(facade.readConfigSnapshotMock).toHaveBeenCalledWith('alpha');
    expect(facade.getMembersMock).toHaveBeenCalledWith('alpha');
    expect(facade.getTeamAgentRuntimeSnapshotMock).toHaveBeenCalledWith('alpha');
  });

  it('keeps member launch grace timers scoped to member status handling', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();
    const futureAcceptedAt = new Date(Date.now() + 30_000).toISOString();

    expect(facade.getGraceKey(run, 'Worker')).toBe('member-launch-grace:run-1:Worker');

    facade.syncGrace(run, 'Worker', {
      launchState: 'starting',
      firstSpawnAcceptedAt: futureAcceptedAt,
    } as MemberSpawnStatusEntry);
    expect(facade.pendingTimeoutCount()).toBe(1);

    facade.syncGrace(run, 'Worker', {
      launchState: 'confirmed_alive',
      firstSpawnAcceptedAt: futureAcceptedAt,
    } as MemberSpawnStatusEntry);
    expect(facade.pendingTimeoutCount()).toBe(0);
  });

  it('delegates member spawn status mutations through the status facade ports', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();

    facade.setSpawn(run, 'Worker', 'spawning');

    expect(run.memberSpawnStatuses.get('Worker')?.status).toBe('spawning');
    expect(facade.mutationPorts.syncMemberTaskActivityForRuntimeTransition).toHaveBeenCalled();
    expect(facade.mutationPorts.syncMemberLaunchGraceCheck).toHaveBeenCalledWith(
      run,
      'Worker',
      expect.objectContaining({ status: 'spawning' })
    );
    expect(facade.mutationPorts.updateLaunchDiagnostics).toHaveBeenCalledWith(run);
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });

  it('keeps unconfirmed bootstrap failure marking behind the status facade', () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();

    facade.failUnconfirmedBootstrapMembers(run, 'bootstrap timed out');

    expect(run.memberSpawnStatuses.get('Worker')).toMatchObject({
      status: 'error',
      launchState: 'failed_to_start',
      hardFailure: true,
      hardFailureReason: 'bootstrap timed out',
    });
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });

  it('keeps lead-inbox spawn refresh and expected-name resolution behind the status facade', async () => {
    const facade = new TestMemberStatusQueryFacade();
    const run = createRun();
    facade.getMessagesForMock.mockResolvedValue([
      {
        messageId: 'msg-1',
        from: 'Worker',
        to: 'Lead',
        timestamp: '2026-07-08T00:00:05.000Z',
        text: 'heartbeat 2026-07-08T00:00:04.000Z',
        read: false,
      },
    ]);

    expect(facade.resolveExpected(['Worker'], 'Worker-2')).toBe('Worker');

    await facade.refreshFromLeadInbox(run);

    expect(facade.getMessagesForMock).toHaveBeenCalledWith('alpha', 'Lead');
    expect(run.memberSpawnStatuses.get('Worker')).toMatchObject({
      status: 'online',
      bootstrapConfirmed: true,
      runtimeAlive: true,
      lastHeartbeatAt: '2026-07-08T00:00:05.000Z',
    });
    expect(facade.mutationPorts.emitMemberSpawnChange).toHaveBeenCalledWith(run, 'Worker');
  });
});
