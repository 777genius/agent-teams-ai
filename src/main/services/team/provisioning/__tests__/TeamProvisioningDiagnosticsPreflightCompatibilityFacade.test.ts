import { type TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import { describe, expect, it, vi } from 'vitest';

import { TeamRuntimeAdapterRegistry } from '../../runtime';
import { TeamProvisioningDiagnosticsPreflightCompatibilityFacade } from '../TeamProvisioningDiagnosticsPreflightCompatibilityFacade';

import type { TeamLaunchRuntimeAdapter, TeamRuntimeProviderId } from '../../runtime';
import type { TeamProvisioningCliHelpOutputProviderRuntime } from '../TeamProvisioningCliHelpOutputPortsFactory';
import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { TeamProvisioningPrepareFacade } from '../TeamProvisioningPrepareFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';
import type { TeamCreateRequest, TeamProviderId } from '@shared/types';

function createRuntimeAdapter(providerId: TeamRuntimeProviderId): TeamLaunchRuntimeAdapter {
  return {
    providerId,
    prepare: vi.fn(),
    launch: vi.fn(),
    reconcile: vi.fn(),
    stop: vi.fn(),
  } as unknown as TeamLaunchRuntimeAdapter;
}

class TestDiagnosticsPreflightCompatibilityFacade extends TeamProvisioningDiagnosticsPreflightCompatibilityFacade<ProvisioningRun> {
  readonly prepareResult = { prepared: true };
  readonly materializedMembers = [
    { name: 'Worker', role: 'Build' },
  ] as TeamCreateRequest['members'];
  readonly workspaceMembers = [
    { name: 'OpenCode', role: 'Review', providerId: 'opencode', cwd: '/repo/opencode' },
  ] as TeamCreateRequest['members'];
  readonly validConfigResult = { ok: false } as const;
  readonly lanePlan = {
    mode: 'primary_only',
    primaryMembers: [],
    allMembers: [],
    sideLanes: [],
  } as TeamRuntimeLanePlan;
  readonly runtimeLaneCoordinator = {
    planProvisioningMembers: vi.fn(() => this.lanePlan),
  };
  readonly runTracking = {
    canDeliverToOpenCodeRuntimeForTeam: vi.fn(() => true),
    getAliveRunId: vi.fn(() => 'run-alive'),
    getAliveTeamNames: vi.fn(() => ['alpha']),
    getTrackedRunId: vi.fn(() => 'run-tracked'),
  };
  readonly transientRunState = {
    appendCliLogs: vi.fn(),
  };
  readonly verificationProbePorts = {
    waitForValidConfig: vi.fn(async () => this.validConfigResult),
    waitForTeamInList: vi.fn(async () => true),
    waitForMissingInboxes: vi.fn(async () => ['Worker']),
    tryCompleteAfterTimeout: vi.fn(async () => false),
    pathExists: vi.fn(async () => true),
  };
  readonly prepareFacadeMock = {
    warmup: vi.fn(async () => undefined),
    prepareForProvisioning: vi.fn(async () => this.prepareResult),
    materializeEffectiveTeamMemberSpecs: vi.fn(async () => this.materializedMembers),
    resolveOpenCodeMemberWorkspacesForRuntime: vi.fn(async () => this.workspaceMembers),
    getCachedOrProbeResult: vi.fn(async () => ({ claudePath: '/fake/claude' })),
  };
  readonly providerRuntimeMock = {
    buildProvisioningEnv: vi
      .fn<TeamProvisioningCliHelpOutputProviderRuntime['buildProvisioningEnv']>()
      .mockResolvedValue({ env: { PATH: '/bin' } }),
    spawnProbe: vi
      .fn<TeamProvisioningCliHelpOutputProviderRuntime['spawnProbe']>()
      .mockResolvedValue({ exitCode: 0, stdout: 'Usage', stderr: '' }),
  } satisfies TeamProvisioningCliHelpOutputProviderRuntime;
  readonly shutdownCoordination = {
    getShutdownTrackedTeamNames: vi.fn(() => ['alpha']),
  };
  readonly readConfigForStrictDecisionMock = vi.fn(async (_teamName: string) => ({
    language: 'ru',
  }));
  readonly updateConfigMock = vi.fn(
    async (_teamName: string, _update: { language?: string }) => undefined
  );
  readonly sendMessageToTeamMock = vi.fn(async (_teamName: string, _message: string) => undefined);
  readonly configFacade = {
    readConfigForStrictDecision: this.readConfigForStrictDecisionMock,
  };
  readonly configReader = {
    updateConfig: this.updateConfigMock,
  };

  protected readonly compatibilityDelegation =
    {} as TeamProvisioningCompatibilityDelegation<ProvisioningRun>;
  protected readonly memberLifecycleFacade = {} as TeamProvisioningMemberLifecyclePublicFacade;
  protected readonly launchIdentityBoundary = {} as never;
  protected readonly runs = new Map<string, ProvisioningRun>();
  protected readonly retainedClaudeLogsByTeam = new Map();
  protected readonly bootstrapTranscriptFacade = {
    getPersistedTranscriptClaudeLogs: vi.fn(async () => null),
  };
  protected readonly membersMetaStore = {
    getMembers: vi.fn(async () => []),
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
    getTeamAgentRuntimeSnapshot: vi.fn(),
  };
  protected readonly runtimeSnapshotCacheBoundary = {
    getRuntimeSnapshotCacheGeneration: vi.fn(() => 0),
  };
  protected readonly liveRuntimeMetadataPorts = {
    getLiveTeamAgentRuntimeMetadata: vi.fn(async () => new Map()),
  };
  protected readonly prepareFacade = this
    .prepareFacadeMock as unknown as TeamProvisioningPrepareFacade;
  protected readonly providerRuntime = this.providerRuntimeMock as never;
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    createPorts: vi.fn(),
    reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
  };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly toolApprovalFacade = {
    answerRuntimeToolApproval: vi.fn(),
    dismissApprovalNotification: vi.fn(),
    respondToToolApproval: vi.fn(),
    setMainWindow: vi.fn(),
    setToolApprovalEventEmitter: vi.fn(),
    updateToolApprovalSettings: vi.fn(),
  } as never;
  protected readonly liveLeadMessagePortsBoundary = {
    getCurrentLeadSessionId: vi.fn(() => null),
    getLiveLeadProcessMessages: vi.fn(() => []),
    pruneLiveLeadMessagesForCleanedRun: vi.fn(),
  } as never;
  protected readonly openCodeRuntimeControlApi = {
    answerOpenCodeRuntimePermission: vi.fn(),
    deliverOpenCodeRuntimeMessage: vi.fn(),
    recordOpenCodeRuntimeBootstrapCheckin: vi.fn(),
    recordOpenCodeRuntimeHeartbeat: vi.fn(),
    recordOpenCodeRuntimeTaskEvent: vi.fn(),
  } as never;
  protected readonly runtimeAdapterRunByTeam = new Map();
  protected readonly runtimeAdapterProgressByRunId = new Map();
  protected readonly openCodeRuntimeDeliveryBoundaryHost = {} as never;
  protected readonly inboxReader = {} as never;
  protected readonly openCodePromptDeliveryWatchdogScheduler = {} as never;

  appendLogs(run: ProvisioningRun): void {
    this.appendCliLogs(run, 'stdout', 'hello');
  }

  canDeliver(teamName: string): boolean {
    return this.canDeliverToOpenCodeRuntimeForTeam(teamName);
  }

  getAliveTeams(): string[] {
    return ['alpha'];
  }

  async sendMessageToTeam(teamName: string, message: string): Promise<void> {
    await this.sendMessageToTeamMock(teamName, message);
  }

  waitForValidConfigForTest(run: ProvisioningRun, timeoutMs: number) {
    return this.waitForValidConfig(run, timeoutMs);
  }

  waitForTeamInListForTest(teamName: string, run: ProvisioningRun) {
    return this.waitForTeamInList(teamName, run);
  }

  waitForMissingInboxesForTest(run: ProvisioningRun) {
    return this.waitForMissingInboxes(run);
  }

  tryCompleteAfterTimeoutForTest(run: ProvisioningRun) {
    return this.tryCompleteAfterTimeout(run);
  }

  pathExistsForTest(filePath: string) {
    return this.pathExists(filePath);
  }

  materializeEffectiveTeamMemberSpecsForTest(
    params: Parameters<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']>[0]
  ) {
    return this.materializeEffectiveTeamMemberSpecs(params);
  }

  resolveOpenCodeMemberWorkspacesForRuntimeForTest(
    params: Parameters<
      TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']
    >[0]
  ) {
    return this.resolveOpenCodeMemberWorkspacesForRuntime(params);
  }

  shouldRouteOpenCodeToRuntimeAdapterForTest(request: {
    providerId?: TeamProviderId;
    members?: readonly { providerId?: TeamProviderId; provider?: TeamProviderId }[];
  }) {
    return this.shouldRouteOpenCodeToRuntimeAdapter(request);
  }

  planRuntimeLanesOrThrowForTest(
    leadProviderId: TeamProviderId | undefined,
    members: TeamCreateRequest['members'],
    baseCwd?: string
  ) {
    return this.planRuntimeLanesOrThrow(leadProviderId, members, baseCwd);
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

  protected syncLeadTaskActivityForState(): void {}

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
}

describe('TeamProvisioningDiagnosticsPreflightCompatibilityFacade', () => {
  it('delegates health and preflight compatibility wrappers to composed services', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();

    expect(facade.getAliveTeamNames()).toEqual(['alpha']);
    expect(facade.getCurrentRunId('alpha')).toBe('run-alive');
    expect(facade.canDeliver('alpha')).toBe(true);
    expect(facade.hasActiveTeamRuntimes()).toBe(true);
    await facade.warmup();
    await expect(facade.prepareForProvisioning('/repo', { forceFresh: true })).resolves.toBe(
      facade.prepareResult
    );

    expect(facade.runTracking.getAliveRunId).toHaveBeenCalledWith('alpha');
    expect(facade.runTracking.canDeliverToOpenCodeRuntimeForTeam).toHaveBeenCalledWith('alpha');
    expect(facade.shutdownCoordination.getShutdownTrackedTeamNames).toHaveBeenCalled();
    expect(facade.prepareFacadeMock.warmup).toHaveBeenCalled();
    expect(facade.prepareFacadeMock.prepareForProvisioning).toHaveBeenCalledWith('/repo', {
      forceFresh: true,
    });
  });

  it('keeps prepare and runtime lane preflight wrappers outside the service facade', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();
    const members = [
      { name: 'Worker', role: 'Build', providerId: 'opencode' },
    ] as TeamCreateRequest['members'];
    const materializeParams = {
      claudePath: '/fake/claude',
      cwd: '/repo',
      members,
      defaults: { providerId: 'codex' },
    } as Parameters<TeamProvisioningPrepareFacade['materializeEffectiveTeamMemberSpecs']>[0];
    const workspaceParams = {
      teamName: 'alpha',
      baseCwd: '/repo',
      leadProviderId: 'codex',
      members,
    } as Parameters<TeamProvisioningPrepareFacade['resolveOpenCodeMemberWorkspacesForRuntime']>[0];

    await expect(
      facade.materializeEffectiveTeamMemberSpecsForTest(materializeParams)
    ).resolves.toBe(facade.materializedMembers);
    await expect(
      facade.resolveOpenCodeMemberWorkspacesForRuntimeForTest(workspaceParams)
    ).resolves.toBe(facade.workspaceMembers);

    expect(
      facade.shouldRouteOpenCodeToRuntimeAdapterForTest({
        providerId: 'opencode',
        members,
      })
    ).toBe(false);
    facade.setRuntimeAdapterRegistry(
      new TeamRuntimeAdapterRegistry([createRuntimeAdapter('opencode')])
    );
    expect(
      facade.shouldRouteOpenCodeToRuntimeAdapterForTest({
        providerId: 'opencode',
        members,
      })
    ).toBe(true);
    expect(facade.planRuntimeLanesOrThrowForTest('codex', members, '/repo')).toBe(facade.lanePlan);

    expect(facade.prepareFacadeMock.materializeEffectiveTeamMemberSpecs).toHaveBeenCalledWith(
      materializeParams
    );
    expect(facade.prepareFacadeMock.resolveOpenCodeMemberWorkspacesForRuntime).toHaveBeenCalledWith(
      workspaceParams
    );
    expect(facade.runtimeLaneCoordinator.planProvisioningMembers).toHaveBeenCalledWith({
      leadProviderId: 'codex',
      members,
      baseCwd: '/repo',
      hasOpenCodeRuntimeAdapter: true,
    });
  });

  it('delegates verification and log compatibility wrappers', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();
    const run = { runId: 'run-1', teamName: 'alpha' } as ProvisioningRun;

    facade.appendLogs(run);
    await expect(facade.waitForValidConfigForTest(run, 123)).resolves.toBe(
      facade.validConfigResult
    );
    await expect(facade.waitForTeamInListForTest('alpha', run)).resolves.toBe(true);
    await expect(facade.waitForMissingInboxesForTest(run)).resolves.toEqual(['Worker']);
    await expect(facade.tryCompleteAfterTimeoutForTest(run)).resolves.toBe(false);
    await expect(facade.pathExistsForTest('/repo/config.json')).resolves.toBe(true);

    expect(facade.transientRunState.appendCliLogs).toHaveBeenCalledWith(run, 'stdout', 'hello');
    expect(facade.verificationProbePorts.waitForValidConfig).toHaveBeenCalledWith(run, 123);
    expect(facade.verificationProbePorts.waitForTeamInList).toHaveBeenCalledWith('alpha', run);
    expect(facade.verificationProbePorts.waitForMissingInboxes).toHaveBeenCalledWith(run);
    expect(facade.verificationProbePorts.tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
    expect(facade.verificationProbePorts.pathExists).toHaveBeenCalledWith('/repo/config.json');
  });

  it('coalesces concurrent CLI help preflight probes', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();

    const [first, second] = await Promise.all([
      facade.getCliHelpOutput('/repo'),
      facade.getCliHelpOutput('/repo'),
    ]);

    expect(first).toBe('Usage');
    expect(second).toBe('Usage');
    expect(facade.prepareFacadeMock.getCachedOrProbeResult).toHaveBeenCalledOnce();
    expect(facade.providerRuntimeMock.buildProvisioningEnv).toHaveBeenCalledOnce();
    expect(facade.providerRuntimeMock.spawnProbe).toHaveBeenCalledOnce();
  });

  it('keeps concurrent CLI help preflight probes isolated by working directory', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();
    facade.providerRuntimeMock.spawnProbe.mockImplementation(async (_claudePath, _args, cwd) => ({
      exitCode: 0,
      stdout: `Usage from ${cwd}`,
      stderr: `Flags from ${cwd}`,
    }));

    const [first, second] = await Promise.all([
      facade.getCliHelpOutput('/repo/first'),
      facade.getCliHelpOutput('/repo/second'),
    ]);

    expect(first).toBe('Usage from /repo/first\nFlags from /repo/first');
    expect(second).toBe('Usage from /repo/second\nFlags from /repo/second');
    expect(facade.prepareFacadeMock.getCachedOrProbeResult).toHaveBeenCalledTimes(2);
    expect(facade.prepareFacadeMock.getCachedOrProbeResult).toHaveBeenCalledWith(
      '/repo/first',
      'anthropic'
    );
    expect(facade.prepareFacadeMock.getCachedOrProbeResult).toHaveBeenCalledWith(
      '/repo/second',
      'anthropic'
    );
    expect(facade.providerRuntimeMock.buildProvisioningEnv).toHaveBeenCalledTimes(2);
    expect(facade.providerRuntimeMock.spawnProbe).toHaveBeenCalledTimes(2);
  });

  it('releases a failed CLI help preflight so a later request can retry', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();
    const probeError = new Error('probe failed');
    facade.providerRuntimeMock.spawnProbe.mockRejectedValue(probeError);

    const failures = await Promise.allSettled([
      facade.getCliHelpOutput('/repo'),
      facade.getCliHelpOutput('/repo'),
    ]);

    expect(failures).toHaveLength(2);
    for (const failure of failures) {
      expect(failure.status).toBe('rejected');
      if (failure.status === 'rejected') {
        expect(failure.reason).toBe(probeError);
      }
    }
    expect(facade.providerRuntimeMock.spawnProbe).toHaveBeenCalledOnce();

    facade.providerRuntimeMock.spawnProbe.mockResolvedValue({
      exitCode: 0,
      stdout: 'Usage after retry',
      stderr: '',
    });
    await expect(facade.getCliHelpOutput('/repo')).resolves.toBe('Usage after retry');

    expect(facade.providerRuntimeMock.spawnProbe).toHaveBeenCalledTimes(2);
  });

  it('keeps language-change config maintenance routed through the diagnostics facade', async () => {
    const facade = new TestDiagnosticsPreflightCompatibilityFacade();

    await facade.notifyLanguageChange('fr');

    expect(facade.readConfigForStrictDecisionMock).toHaveBeenCalledWith('alpha');
    expect(facade.sendMessageToTeamMock).toHaveBeenCalledTimes(1);
    expect(facade.sendMessageToTeamMock.mock.calls[0]?.[0]).toBe('alpha');
    expect(facade.sendMessageToTeamMock.mock.calls[0]?.[1]).toContain(
      'preferred communication language'
    );
    expect(facade.updateConfigMock).toHaveBeenCalledWith('alpha', { language: 'fr' });
  });
});
