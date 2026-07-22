import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningLaunchRuntimeStatusCompatibilityFacade } from '../TeamProvisioningLaunchRuntimeStatusCompatibilityFacade';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeLaunchResult } from '../../runtime';
import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningLaunchStateCompatibilityBoundary } from '../TeamProvisioningLaunchStateCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { MixedSecondaryRuntimeLaneState } from '../TeamProvisioningSecondaryRuntimeRuns';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  PersistedTeamLaunchSnapshot,
  TeamAgentRuntimeSnapshot,
  TeamConfig,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

type LaunchStateBoundary = TeamProvisioningLaunchStateCompatibilityBoundary<ProvisioningRun>;

function progress(
  runId: string,
  teamName: string,
  state: TeamProvisioningProgress['state'] = 'spawning'
): TeamProvisioningProgress {
  return {
    runId,
    teamName,
    state,
    message: `${state} message`,
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:01.000Z',
  };
}

function createRun(overrides: Partial<ProvisioningRun> = {}): ProvisioningRun {
  const teamName = overrides.teamName ?? 'alpha';
  const runId = overrides.runId ?? 'run-1';
  return {
    runId,
    teamName,
    request: {
      teamName,
      cwd: '/safe-test-workspace/alpha',
      members: [],
      providerId: 'codex',
    } as TeamCreateRequest,
    child: {
      killed: false,
      stdin: {
        writable: true,
      },
    },
    processKilled: false,
    cancelRequested: false,
    progress: progress(runId, teamName),
    isLaunch: true,
    onProgress: vi.fn(),
    memberSpawnStatuses: new Map(),
    ...overrides,
  } as unknown as ProvisioningRun;
}

function createLane(
  overrides: Partial<MixedSecondaryRuntimeLaneState> = {}
): MixedSecondaryRuntimeLaneState {
  return {
    laneId: 'secondary:opencode:Builder',
    providerId: 'opencode',
    member: {
      name: 'Builder',
      role: 'Build changes',
      cwd: '/safe-test-workspace/alpha-builder',
    },
    runId: null,
    state: 'queued',
    result: null,
    warnings: [],
    diagnostics: [],
    ...overrides,
  } as MixedSecondaryRuntimeLaneState;
}

function createSnapshot(): PersistedTeamLaunchSnapshot {
  return {
    version: 1,
    teamName: 'alpha',
    runId: 'run-1',
    launchPhase: 'active',
    teamLaunchState: 'partial_pending',
    expectedMembers: ['Builder'],
    bootstrapExpectedMembers: ['Builder'],
    members: {},
    updatedAt: '2026-01-01T00:00:02.000Z',
  } as unknown as PersistedTeamLaunchSnapshot;
}

class TestLaunchRuntimeStatusFacade extends TeamProvisioningLaunchRuntimeStatusCompatibilityFacade<ProvisioningRun> {
  readonly trackedRunByTeam = new Map<string, string>();
  readonly provisioningRunByTeam = new Map<string, string>();
  readonly aliveRunByTeam = new Map<string, string>();
  readonly runtimeAdapterProgressByRunId = new Map<string, TeamProvisioningProgress>();
  readonly invalidateRuntimeSnapshotCachesMock = vi.fn();
  readonly sweepRuntimeAdapterRunStateMock = vi.fn();
  readonly runtimeAdapterRunByTeam = new Map();
  readonly secondaryRuntimeRunByTeam = new Map();
  readonly cancellationBoundary = {
    isCancellableRuntimeAdapterProgress: vi.fn(() => true),
  };
  protected readonly prepareFacade = {
    getOpenCodeRuntimeLaunchCwd: vi.fn(() => '/safe-test-workspace/alpha'),
  } as never;
  protected readonly toolApprovalFacade = {
    syncOpenCodeRuntimeToolApprovals: vi.fn(),
  } as never;
  readonly launchStateCompatibilityBoundaryMock = {
    persistLaunchStateSnapshot: vi.fn(async () => createSnapshot()),
    writeLaunchStateSnapshot: vi.fn(
      async (_teamName: string, snapshot: PersistedTeamLaunchSnapshot) => snapshot
    ),
    syncRunMemberSpawnStatusesFromSnapshot: vi.fn(),
    emitMemberSpawnChange: vi.fn(),
  };

  protected readonly compatibilityDelegation = {
    configFacade: {
      readConfigSnapshot: vi.fn(async () => ({ members: [] }) as unknown as TeamConfig),
    },
  } as unknown as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {
    isMemberLifecycleOperationActive: vi.fn(() => false),
  } as unknown as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly runTracking = {
    getTrackedRunId: (teamName: string) => this.trackedRunByTeam.get(teamName) ?? null,
    getProvisioningRunId: (teamName: string) => this.provisioningRunByTeam.get(teamName) ?? null,
    getAliveRunId: (teamName: string) => this.aliveRunByTeam.get(teamName) ?? null,
    setAliveRunId: (teamName: string, runId: string) => {
      this.aliveRunByTeam.set(teamName, runId);
    },
    getAliveTeamNames: () => [...this.aliveRunByTeam.keys()],
    canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
  };
  readonly runs = new Map<string, ProvisioningRun>();
  protected readonly membersMetaStore = {
    getMembers: vi.fn(async () => []),
  };
  protected readonly inboxReader = {
    getMessagesFor: vi.fn(async () => []),
  };
  readonly runtimeToolActivity = {
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
    getTeamAgentRuntimeSnapshot: vi.fn(
      async () => ({ teamName: 'alpha' }) as TeamAgentRuntimeSnapshot
    ),
  };
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
  } as never;
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly runtimeSnapshotCacheBoundary = {
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
    invalidateRuntimeSnapshotCaches: this.invalidateRuntimeSnapshotCachesMock,
  };
  protected readonly runtimeAdapterProgressState = {
    sweepRuntimeAdapterRunState: this.sweepRuntimeAdapterRunStateMock,
  };
  protected readonly bootstrapEvidenceFacade = {
    createOpenCodeRuntimeBootstrapEvidencePorts: vi.fn(() => ({}) as never),
  };
  protected readonly liveRuntimeMetadataPorts = {
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
  };
  protected readonly launchStateCompatibilityBoundary = this
    .launchStateCompatibilityBoundaryMock as unknown as LaunchStateBoundary;
  protected readonly launchIdentityBoundary = {} as never;
  protected readonly runtimeLaneCoordinator = {} as never;
  protected readonly retainedClaudeLogsByTeam = new Map();
  protected readonly bootstrapTranscriptFacade = {} as never;
  protected readonly providerRuntime = {} as never;
  protected readonly verificationProbePorts = {} as never;
  protected readonly transientRunState = {} as never;
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly shutdownCoordination = { getShutdownTrackedTeamNames: vi.fn(() => []) };
  protected readonly liveLeadMessagePortsBoundary = {} as never;
  protected readonly openCodeRuntimeControlApi = {} as never;
  protected readonly openCodeRuntimeDeliveryBoundaryHost = {} as never;
  protected readonly openCodePromptDeliveryWatchdogCoordinator = {} as never;
  protected readonly openCodePromptDeliveryWatchdogScheduler = {} as never;
  protected readonly openCodeRuntimeDeliveryAdvisory = {} as never;
  protected readonly openCodeRuntimePidBridgePorts = {} as never;
  protected readonly persistentRuntimeCleanup = {} as never;
  protected readonly outputRecoveryFacade = {} as never;
  protected readonly leadInboxRelayFacade = {} as never;
  protected teamChangeEmitter = null;

  invalidate(teamName: string): void {
    this.invalidateRuntimeSnapshotCaches(teamName);
  }

  sweep(nowMs: number): void {
    this.sweepRuntimeAdapterRunState(nowMs);
  }

  createStates(plan: TeamRuntimeLanePlan): MixedSecondaryRuntimeLaneState[] {
    return this.createMixedSecondaryLaneStates(plan);
  }

  createLaneForMember(
    run: Pick<ProvisioningRun, 'request' | 'mixedSecondaryLanes'>,
    member: TeamCreateRequest['members'][number]
  ): MixedSecondaryRuntimeLaneState {
    return this.createMixedSecondaryLaneStateForMember(run, member);
  }

  phase(run: ProvisioningRun): string {
    return this.getMixedSecondaryLaunchPhase(run);
  }

  summarize(input: {
    primaryResult: TeamRuntimeLaunchResult | null;
    lanes: readonly MixedSecondaryRuntimeLaneState[];
  }): TeamRuntimeLaunchResult['teamLaunchState'] {
    return this.summarizeOpenCodeAggregateLaunchState(input);
  }

  currentOpenCodeRunId(teamName: string, laneId: string): string | null {
    return this.getCurrentOpenCodeRuntimeRunId(teamName, laneId);
  }

  launchAggregate(input: {
    run: ProvisioningRun;
    adapter: TeamLaunchRuntimeAdapter;
    prompt: string;
    previousLaunchState: PersistedTeamLaunchSnapshot | null;
  }): Promise<TeamRuntimeLaunchResult | null> {
    return this.launchOpenCodeAggregatePrimaryLane(input);
  }

  promoted(run: ProvisioningRun): boolean {
    return this.isProvisioningRunPromotedToAlive(run);
  }

  current(run: ProvisioningRun): boolean {
    return this.isLaunchRunStillCurrent(run);
  }

  pendingFirstTurn(run: ProvisioningRun): boolean {
    return this.hasPendingDeterministicFirstRealTurn(run);
  }

  promotable(run: ProvisioningRun): boolean {
    return this.isProvisioningRunStillPromotable(run);
  }

  publish(run: ProvisioningRun, lane: MixedSecondaryRuntimeLaneState): Promise<void> {
    return this.publishMixedSecondaryLaneStatusChange(run, lane);
  }

  upsert(run: ProvisioningRun, member: TeamCreateRequest['members'][number]): void {
    this.upsertRunAllEffectiveMember(run, member);
  }

  remove(run: ProvisioningRun, memberName: string): void {
    this.removeRunAllEffectiveMember(run, memberName);
  }

  markFailed(run: ProvisioningRun, reason: string): void {
    this.markUnconfirmedBootstrapMembersFailed(run, reason);
  }

  protected async findBootstrapTranscriptOutcome() {
    return null;
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized() {
    return {} as never;
  }

  protected scheduleOpenCodePromptDeliveryWatchdog(): void {}

  protected async resolveOpenCodeMemberDeliveryIdentity() {
    return {} as never;
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberBeforeDelivery(): Promise<boolean> {
    return false;
  }

  protected async tryRecoverOpenCodeRuntimeLaneForConfiguredMemberAndVerifyActive(): Promise<boolean> {
    return false;
  }

  protected async getOpenCodeAgendaSyncRecoveryBypassMessageIds(): Promise<Set<string>> {
    return new Set();
  }

  protected getRunLeadName(): string {
    return 'Lead';
  }
}

describe('TeamProvisioningLaunchRuntimeStatusCompatibilityFacade', () => {
  it('keeps cache invalidation, runtime sweeping, and mixed lane helpers in the facade', () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun({
      request: {
        teamName: 'alpha',
        cwd: '/safe-test-workspace/alpha',
        providerId: 'opencode',
        members: [],
      } as TeamCreateRequest,
    });
    const member = {
      name: 'Builder',
      role: 'Build changes',
      cwd: '/safe-test-workspace/alpha-builder',
    };

    facade.invalidate('alpha');
    facade.sweep(1234);
    const states = facade.createStates({
      mode: 'mixed_opencode_side_lanes',
      primaryMembers: [],
      allMembers: [member],
      sideLanes: [
        {
          laneId: 'secondary:opencode:Builder',
          providerId: 'opencode',
          member,
        },
      ],
    } as unknown as TeamRuntimeLanePlan);
    const lane = facade.createLaneForMember(run, member);

    expect(facade.invalidateRuntimeSnapshotCachesMock).toHaveBeenCalledWith('alpha');
    expect(facade.sweepRuntimeAdapterRunStateMock).toHaveBeenCalledWith(1234);
    expect(states).toHaveLength(1);
    expect(states[0]).toEqual(expect.objectContaining({ state: 'queued' }));
    expect(lane).toEqual(expect.objectContaining({ providerId: 'opencode', state: 'queued' }));
    expect(facade.phase(createRun({ mixedSecondaryLanes: [createLane()] }))).toBe('active');
    expect(
      facade.summarize({
        primaryResult: null,
        lanes: [
          createLane({
            result: { teamLaunchState: 'clean_success' } as TeamRuntimeLaunchResult,
          }),
        ],
      })
    ).toBe('clean_success');
  });

  it('publishes mixed secondary lane status through launch snapshot compatibility hooks', async () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun({
      mixedSecondaryLanes: [
        createLane({ state: 'finished', result: {} as TeamRuntimeLaunchResult }),
      ],
    });
    const lane = createLane();
    facade.runs.set(run.runId, run);
    facade.trackedRunByTeam.set(run.teamName, run.runId);

    await facade.publish(run, lane);

    expect(
      facade.launchStateCompatibilityBoundaryMock.persistLaunchStateSnapshot
    ).toHaveBeenCalledWith(run, 'finished');
    expect(
      facade.launchStateCompatibilityBoundaryMock.syncRunMemberSpawnStatusesFromSnapshot
    ).toHaveBeenCalledWith(run, createSnapshot());
    expect(facade.launchStateCompatibilityBoundaryMock.emitMemberSpawnChange).toHaveBeenCalledWith(
      run,
      'Builder'
    );
  });

  it('skips mixed secondary status publishing when the run is no longer current', async () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun();
    facade.runs.set(run.runId, run);
    facade.trackedRunByTeam.set(run.teamName, 'other-run');

    await facade.publish(run, createLane());

    expect(
      facade.launchStateCompatibilityBoundaryMock.persistLaunchStateSnapshot
    ).not.toHaveBeenCalled();
    expect(
      facade.launchStateCompatibilityBoundaryMock.emitMemberSpawnChange
    ).not.toHaveBeenCalled();
  });

  it('keeps launch promotion status gates out of TeamProvisioningService', () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun();
    facade.runs.set(run.runId, run);
    facade.provisioningRunByTeam.set(run.teamName, run.runId);

    expect(facade.current(run)).toBe(true);
    expect(facade.promotable(run)).toBe(true);

    facade.aliveRunByTeam.set(run.teamName, run.runId);
    facade.provisioningRunByTeam.delete(run.teamName);
    expect(facade.promoted(run)).toBe(true);
    expect(
      facade.pendingFirstTurn(
        createRun({
          deterministicBootstrap: true,
          requiresFirstRealTurnSuccess: true,
          firstRealTurnSucceeded: false,
        })
      )
    ).toBe(true);

    const failedRun = createRun({
      runId: 'run-2',
      progress: progress('run-2', 'alpha', 'failed'),
    });
    facade.runs.set(failedRun.runId, failedRun);
    facade.provisioningRunByTeam.set(failedRun.teamName, failedRun.runId);
    expect(facade.promotable(failedRun)).toBe(false);
  });

  it('resolves current OpenCode runtime run ids through runtime status state', () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun({
      request: {
        teamName: 'alpha',
        cwd: '/safe-test-workspace/alpha',
        providerId: 'opencode',
        members: [],
      } as TeamCreateRequest,
    });
    facade.runs.set(run.runId, run);
    facade.trackedRunByTeam.set(run.teamName, run.runId);
    facade.provisioningRunByTeam.set(run.teamName, run.runId);
    facade.runtimeAdapterProgressByRunId.set(run.runId, progress(run.runId, run.teamName));

    expect(facade.currentOpenCodeRunId('alpha', 'primary')).toBeNull();

    facade.runtimeAdapterRunByTeam.set(run.teamName, {
      runId: run.runId,
      providerId: 'opencode',
    });
    expect(facade.currentOpenCodeRunId('alpha', 'primary')).toBe(run.runId);

    facade.secondaryRuntimeRunByTeam.set(
      'alpha',
      new Map([
        [
          'secondary:opencode:Builder',
          {
            runId: 'secondary-run',
            providerId: 'opencode',
            laneId: 'secondary:opencode:Builder',
            memberName: 'Builder',
          },
        ],
      ])
    );
    expect(facade.currentOpenCodeRunId('alpha', 'secondary:opencode:Builder')).toBe(
      'secondary-run'
    );
  });

  it('marks unconfirmed bootstrap members failed through the extracted facade', () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun({
      expectedMembers: ['Builder'],
      memberSpawnStatuses: new Map(),
    });
    facade.trackedRunByTeam.set(run.teamName, run.runId);

    facade.markFailed(run, 'bootstrap did not confirm');

    expect(run.memberSpawnStatuses.get('Builder')).toEqual(
      expect.objectContaining({
        status: 'error',
        launchState: 'failed_to_start',
        hardFailure: true,
        hardFailureReason: 'bootstrap did not confirm',
      })
    );
    expect(facade.runtimeToolActivity.appendMemberBootstrapDiagnostic).toHaveBeenCalledWith(
      run,
      'Builder',
      'bootstrap did not confirm'
    );
    expect(facade.launchStateCompatibilityBoundaryMock.emitMemberSpawnChange).toHaveBeenCalledWith(
      run,
      'Builder'
    );
  });

  it('delegates OpenCode aggregate primary launch persistence from the facade', async () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun({
      effectiveMembers: [{ name: 'Builder', role: 'Build changes' }],
      memberSpawnStatuses: new Map(),
    });
    const launchResult = {
      runId: run.runId,
      teamName: run.teamName,
      launchPhase: 'finished',
      teamLaunchState: 'clean_success',
      members: {},
      warnings: [],
      diagnostics: [],
    } as TeamRuntimeLaunchResult;
    const adapter = {
      launch: vi.fn(async () => launchResult),
    } as unknown as TeamLaunchRuntimeAdapter;

    await expect(
      facade.launchAggregate({
        run,
        adapter,
        prompt: 'launch prompt',
        previousLaunchState: null,
      })
    ).resolves.toBe(launchResult);

    expect(adapter.launch).toHaveBeenCalledWith(
      expect.objectContaining({
        runId: run.runId,
        laneId: 'primary',
        teamName: run.teamName,
        prompt: 'launch prompt',
      })
    );
    expect(facade.launchStateCompatibilityBoundaryMock.writeLaunchStateSnapshot).toHaveBeenCalled();
    expect(facade.runtimeAdapterRunByTeam.get(run.teamName)).toEqual(
      expect.objectContaining({
        runId: run.runId,
        providerId: 'opencode',
      })
    );
  });

  it('updates effective members through the extracted runtime status facade', () => {
    const facade = new TestLaunchRuntimeStatusFacade();
    const run = createRun();

    facade.upsert(run, { name: 'Builder', role: 'Build changes' });
    facade.upsert(run, { name: 'Reviewer', role: 'Review changes', providerId: 'opencode' });
    facade.remove(run, 'Builder');

    expect(run.request.members.map((member) => member.name)).toEqual(['Reviewer']);
    expect(run.allEffectiveMembers?.map((member) => member.name)).toEqual(['Reviewer']);
  });
});
