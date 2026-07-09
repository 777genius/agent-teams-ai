import { describe, expect, it, vi } from 'vitest';

import { TeamProvisioningDiagnosticsPreflightCompatibilityFacade } from '../TeamProvisioningDiagnosticsPreflightCompatibilityFacade';

import type { TeamProvisioningCompatibilityDelegation } from '../TeamProvisioningCompatibilityFacade';
import type { TeamProvisioningMemberLifecyclePublicFacade } from '../TeamProvisioningMemberLifecycleCompatibilityFacade';
import type { TeamProvisioningPrepareFacade } from '../TeamProvisioningPrepareFacade';
import type { ProvisioningRun } from '../TeamProvisioningRunModel';

class TestDiagnosticsPreflightCompatibilityFacade extends TeamProvisioningDiagnosticsPreflightCompatibilityFacade<ProvisioningRun> {
  readonly prepareResult = { prepared: true };
  readonly validConfigResult = { ok: false } as const;
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
  };
  readonly shutdownCoordination = {
    getShutdownTrackedTeamNames: vi.fn(() => ['alpha']),
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
  protected readonly prepareFacade = this
    .prepareFacadeMock as unknown as TeamProvisioningPrepareFacade;
  protected readonly providerRuntime = {} as never;
  protected readonly reevaluateMemberLaunchStatusBoundary = {
    createPorts: vi.fn(),
    reevaluateMemberLaunchStatus: vi.fn(async () => undefined),
  };
  protected readonly pendingTimeouts = new Map<string, NodeJS.Timeout>();
  protected readonly helpOutputCache = { output: null as string | null, cachedAtMs: 0 };
  protected readonly toolApprovalFacade = {
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

  protected async findBootstrapTranscriptOutcome() {
    return null;
  }

  protected async sendOpenCodeMemberMessageToRuntimeSerialized() {
    return {} as never;
  }

  protected emitMemberSpawnChange(): void {}

  protected async persistLaunchStateSnapshot(): Promise<unknown> {}

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
    await expect(facade.pathExistsForTest('/tmp/config.json')).resolves.toBe(true);

    expect(facade.transientRunState.appendCliLogs).toHaveBeenCalledWith(run, 'stdout', 'hello');
    expect(facade.verificationProbePorts.waitForValidConfig).toHaveBeenCalledWith(run, 123);
    expect(facade.verificationProbePorts.waitForTeamInList).toHaveBeenCalledWith('alpha', run);
    expect(facade.verificationProbePorts.waitForMissingInboxes).toHaveBeenCalledWith(run);
    expect(facade.verificationProbePorts.tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
    expect(facade.verificationProbePorts.pathExists).toHaveBeenCalledWith('/tmp/config.json');
  });
});
