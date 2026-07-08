import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLaunchDeterministicFlowBoundary,
  createTeamProvisioningLaunchDeterministicFlowHostFromService,
  type TeamProvisioningLaunchDeterministicFlowBoundaryDeps,
  type TeamProvisioningLaunchDeterministicFlowHost,
  type TeamProvisioningLaunchDeterministicFlowServiceHost,
} from '../TeamProvisioningLaunchDeterministicFlowPortsFactory';

import type {
  DeterministicLaunchRunFlowRun,
  PreparedDeterministicLaunchSetup,
} from '../TeamProvisioningLaunchDeterministicRunFlow';
import type { MemberSpawnStatusEntry, TeamLaunchRequest } from '@shared/types';

interface TestLane {
  laneId: string;
}
type TestRun = DeterministicLaunchRunFlowRun<TestLane>;

const testArtifactsRoot = '/repo/.agent-teams-test-artifacts';
const mcpConfigPath = `${testArtifactsRoot}/mcp.json`;
const spoolRootPath = `${testArtifactsRoot}/spool`;

const request = {
  teamName: 'demo',
  cwd: '/repo',
  prompt: 'continue',
  providerId: 'codex',
  providerBackendId: 'codex-native',
} as TeamLaunchRequest;

const setup = {
  kind: 'prepared',
  claudePath: '/bin/claude',
  shellEnv: { PATH: '/bin' },
} as unknown as PreparedDeterministicLaunchSetup<TestLane>;

const memberSpawnStatus = {
  status: 'pending',
} as unknown as MemberSpawnStatusEntry;

function createRun(runId = 'run-1'): TestRun {
  return {
    runId,
    teamName: 'demo',
  } as TestRun;
}

class BoundCallbackHost {
  readonly marker = 'host-context';
  readonly calls: string[] = [];
  readonly runs = new Map<string, TestRun>([['alive-1', createRun('alive-1')]]);
  readonly provisioningRunByTeam = new Map<string, string>([['demo', 'pending-1']]);
  stopAllTeamsGeneration = 7;

  getStopAllTeamsGeneration(): number {
    return this.stopAllTeamsGeneration;
  }

  readonly providerRuntime = {
    buildProvisioningEnv: vi.fn(async () => ({ env: { PATH: '/bin' } })),
    buildCrossProviderMemberArgs: vi.fn(async () => ({ args: [] })),
    validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
  };

  readonly runTracking = {
    getAliveRunId: vi.fn(() => 'alive-1'),
  };

  private workspaceTrustCoordinatorValue: unknown = null;
  private runtimeTurnSettledEnvironmentProviderValue: unknown = null;
  readonly workspaceTrustWorkspaceCollectionPorts = {};

  readonly getWorkspaceTrustCoordinator = vi.fn(() => this.workspaceTrustCoordinatorValue);
  readonly getRuntimeTurnSettledEnvironmentProvider = vi.fn(
    () => this.runtimeTurnSettledEnvironmentProviderValue
  );

  setMutableSetupDependencies(input: {
    workspaceTrustCoordinator?: unknown;
    runtimeTurnSettledEnvironmentProvider?: unknown;
  }): void {
    this.workspaceTrustCoordinatorValue = input.workspaceTrustCoordinator ?? null;
    this.runtimeTurnSettledEnvironmentProviderValue =
      input.runtimeTurnSettledEnvironmentProvider ?? null;
  }

  readonly mcpConfigBuilder = {
    writeConfigFile: vi.fn(async () => mcpConfigPath),
    removeConfigFile: vi.fn(async () => undefined),
  };
  readonly teamMetaStore = {
    writeMeta: vi.fn(async () => undefined),
  };
  readonly membersMetaStore = {
    writeMembers: vi.fn(async () => undefined),
  };

  getRunTrackedCwd(run: TestRun | null | undefined): string | null {
    this.calls.push(`${this.marker}:cwd:${run?.runId ?? 'none'}`);
    return run ? '/repo' : null;
  }

  async materializeLaunchCompatibilityRepair(): Promise<void> {
    this.calls.push(`${this.marker}:repair`);
  }

  async normalizeTeamConfigForLaunch(): Promise<void> {
    this.calls.push(`${this.marker}:normalize`);
  }

  async assertConfigLeadOnlyForLaunch(): Promise<void> {
    this.calls.push(`${this.marker}:lead-only`);
  }

  async updateConfigProjectPath(): Promise<void> {
    this.calls.push(`${this.marker}:project-path`);
  }

  async restorePrelaunchConfig(): Promise<void> {
    this.calls.push(`${this.marker}:restore`);
  }

  async materializeEffectiveTeamMemberSpecs(): Promise<[]> {
    return [];
  }

  async resolveOpenCodeMemberWorkspacesForRuntime(): Promise<[]> {
    return [];
  }

  planRuntimeLanesOrThrow(): { primaryMembers: []; secondaryLanes: [] } {
    return { primaryMembers: [], secondaryLanes: [] };
  }

  createMixedSecondaryLaneStates(): TestLane[] {
    return [{ laneId: 'lane-1' }];
  }

  async resolveAndValidateLaunchIdentity(): Promise<null> {
    return null;
  }

  async prepareWorkspaceTrustForDeterministicRun(input: { run: TestRun }): Promise<void> {
    this.calls.push(`${this.marker}:workspace-trust:${input.run.runId}`);
  }

  resetTeamScopedTransientStateForNewRun(teamName: string): void {
    this.calls.push(`${this.marker}:reset:${teamName}`);
  }

  async clearPersistedLaunchState(teamName: string): Promise<void> {
    this.calls.push(`${this.marker}:clear-launch-state:${teamName}`);
  }

  async publishMixedSecondaryLaneStatusChange(run: TestRun, lane: TestLane): Promise<void> {
    this.calls.push(`${this.marker}:lane:${run.runId}:${lane.laneId}`);
  }

  async buildRuntimeBootstrapMemberMcpLaunchConfigs(input: {
    run: TestRun;
  }): Promise<Map<string, never>> {
    this.calls.push(`${this.marker}:member-mcp:${input.run.runId}`);
    return new Map<string, never>();
  }

  async buildTeamRuntimeLaunchArgsPlan(): Promise<{
    settingsArgs: [];
    fastModeArgs: [];
    runtimeTurnSettledHookArgs: [];
    providerArgs: [];
    extraArgs: [];
    inheritedProviderArgs: [];
    appManagedSettingsPath: null;
  }> {
    return {
      settingsArgs: [],
      fastModeArgs: [],
      runtimeTurnSettledHookArgs: [],
      providerArgs: [],
      extraArgs: [],
      inheritedProviderArgs: [],
      appManagedSettingsPath: null,
    };
  }

  async seedLeadBootstrapPermissionRules(): Promise<void> {
    this.calls.push(`${this.marker}:seed`);
  }

  attachStdoutHandler(run: TestRun): void {
    this.calls.push(`${this.marker}:stdout:${run.runId}`);
  }

  attachStderrHandler(run: TestRun): void {
    this.calls.push(`${this.marker}:stderr:${run.runId}`);
  }

  startStallWatchdog(run: TestRun): void {
    this.calls.push(`${this.marker}:watchdog:${run.runId}`);
  }

  async tryCompleteAfterTimeout(run: TestRun): Promise<boolean> {
    this.calls.push(`${this.marker}:timeout:${run.runId}`);
    return false;
  }

  cleanupRun(run: TestRun): void {
    this.calls.push(`${this.marker}:cleanup:${run.runId}`);
  }

  async handleProcessExit(run: TestRun, code: number | null): Promise<void> {
    this.calls.push(`${this.marker}:exit:${run.runId}:${code ?? 'null'}`);
  }

  async removeRunMemberMcpConfigFiles(run: TestRun): Promise<void> {
    this.calls.push(`${this.marker}:remove-mcp:${run.runId}`);
  }
}

function createDeps(
  host: BoundCallbackHost
): TeamProvisioningLaunchDeterministicFlowBoundaryDeps<TestRun, TestLane> {
  return {
    host: host as unknown as TeamProvisioningLaunchDeterministicFlowHost<TestRun, TestLane>,
    launchExpectedMembersPorts: {} as TeamProvisioningLaunchDeterministicFlowBoundaryDeps<
      TestRun,
      TestLane
    >['launchExpectedMembersPorts'],
    createInitialMemberSpawnStatusEntry: vi.fn(() => memberSpawnStatus),
    randomUUID: vi.fn(() => 'run-1'),
    nowIso: vi.fn(() => '2026-07-03T00:00:00.000Z'),
    logger: { info: vi.fn(), warn: vi.fn() },
    spawnCli: vi.fn() as unknown as TeamProvisioningLaunchDeterministicFlowBoundaryDeps<
      TestRun,
      TestLane
    >['spawnCli'],
    updateProgress: vi.fn((run) => run.progress),
    setTimeout: vi.fn(() => ({}) as NodeJS.Timeout),
    killTeamProcess: vi.fn(),
  };
}

describe('createTeamProvisioningLaunchDeterministicFlowBoundary', () => {
  it('builds deterministic launch host from service-shaped dependencies', async () => {
    const boundHost = new BoundCallbackHost();
    const targetRun = createRun();
    const serviceHost = {
      runTracking: boundHost.runTracking,
      runs: boundHost.runs,
      provisioningRunByTeam: boundHost.provisioningRunByTeam,
      stopAllTeamsGeneration: boundHost.stopAllTeamsGeneration,
      appShellBoundary: {
        getWorkspaceTrustCoordinator:
          boundHost.getWorkspaceTrustCoordinator as TeamProvisioningLaunchDeterministicFlowServiceHost<
            TestRun,
            TestLane
          >['appShellBoundary']['getWorkspaceTrustCoordinator'],
      },
      workspaceTrustWorkspaceCollectionPorts:
        boundHost.workspaceTrustWorkspaceCollectionPorts as TeamProvisioningLaunchDeterministicFlowServiceHost<
          TestRun,
          TestLane
        >['workspaceTrustWorkspaceCollectionPorts'],
      runtimeTurnSettledEnvironmentProvider: null,
      mcpConfigBuilder:
        boundHost.mcpConfigBuilder as TeamProvisioningLaunchDeterministicFlowServiceHost<
          TestRun,
          TestLane
        >['mcpConfigBuilder'],
      teamMetaStore: boundHost.teamMetaStore as TeamProvisioningLaunchDeterministicFlowServiceHost<
        TestRun,
        TestLane
      >['teamMetaStore'],
      membersMetaStore:
        boundHost.membersMetaStore as TeamProvisioningLaunchDeterministicFlowServiceHost<
          TestRun,
          TestLane
        >['membersMetaStore'],
      configFacade: {
        materializeLaunchCompatibilityRepair: () =>
          boundHost.materializeLaunchCompatibilityRepair(),
      },
      outputRecoveryFacade: {
        attachStdoutHandler: (run) => boundHost.attachStdoutHandler(run),
        attachStderrHandler: (run) => boundHost.attachStderrHandler(run),
        startStallWatchdog: (run) => boundHost.startStallWatchdog(run),
      },
      buildProvisioningEnv: boundHost.providerRuntime
        .buildProvisioningEnv as unknown as TeamProvisioningLaunchDeterministicFlowServiceHost<
        TestRun,
        TestLane
      >['buildProvisioningEnv'],
      buildCrossProviderMemberArgs: boundHost.providerRuntime
        .buildCrossProviderMemberArgs as unknown as TeamProvisioningLaunchDeterministicFlowServiceHost<
        TestRun,
        TestLane
      >['buildCrossProviderMemberArgs'],
      validateAgentTeamsMcpRuntime: boundHost.providerRuntime.validateAgentTeamsMcpRuntime,
      getRunTrackedCwd: (run) => boundHost.getRunTrackedCwd(run),
      normalizeTeamConfigForLaunch: () => boundHost.normalizeTeamConfigForLaunch(),
      assertConfigLeadOnlyForLaunch: () => boundHost.assertConfigLeadOnlyForLaunch(),
      updateConfigProjectPath: () => boundHost.updateConfigProjectPath(),
      restorePrelaunchConfig: () => boundHost.restorePrelaunchConfig(),
      materializeEffectiveTeamMemberSpecs: () => boundHost.materializeEffectiveTeamMemberSpecs(),
      resolveOpenCodeMemberWorkspacesForRuntime: () =>
        boundHost.resolveOpenCodeMemberWorkspacesForRuntime(),
      planRuntimeLanesOrThrow: (() =>
        boundHost.planRuntimeLanesOrThrow()) as unknown as TeamProvisioningLaunchDeterministicFlowServiceHost<
        TestRun,
        TestLane
      >['planRuntimeLanesOrThrow'],
      createMixedSecondaryLaneStates: () => boundHost.createMixedSecondaryLaneStates(),
      resolveAndValidateLaunchIdentity: (() =>
        boundHost.resolveAndValidateLaunchIdentity()) as unknown as TeamProvisioningLaunchDeterministicFlowServiceHost<
        TestRun,
        TestLane
      >['resolveAndValidateLaunchIdentity'],
      prepareWorkspaceTrustForDeterministicRun: (...args) =>
        boundHost.prepareWorkspaceTrustForDeterministicRun(...args),
      resetTeamScopedTransientStateForNewRun: (...args) =>
        boundHost.resetTeamScopedTransientStateForNewRun(...args),
      clearPersistedLaunchState: (teamName) => boundHost.clearPersistedLaunchState(teamName),
      publishMixedSecondaryLaneStatusChange: (...args) =>
        boundHost.publishMixedSecondaryLaneStatusChange(...args),
      buildRuntimeBootstrapMemberMcpLaunchConfigs: (...args) =>
        boundHost.buildRuntimeBootstrapMemberMcpLaunchConfigs(...args),
      buildTeamRuntimeLaunchArgsPlan: () => boundHost.buildTeamRuntimeLaunchArgsPlan(),
      seedLeadBootstrapPermissionRules: () => boundHost.seedLeadBootstrapPermissionRules(),
      tryCompleteAfterTimeout: (...args) => boundHost.tryCompleteAfterTimeout(...args),
      cleanupRun: (...args) => boundHost.cleanupRun(...args),
      handleProcessExit: (...args) => boundHost.handleProcessExit(...args),
      removeRunMemberMcpConfigFiles: (...args) => boundHost.removeRunMemberMcpConfigFiles(...args),
    } satisfies TeamProvisioningLaunchDeterministicFlowServiceHost<TestRun, TestLane>;
    const host = createTeamProvisioningLaunchDeterministicFlowHostFromService(serviceHost);

    expect(host.getStopAllTeamsGeneration()).toBe(7);
    expect(host.getWorkspaceTrustCoordinator()).toBeNull();
    expect(host.getRuntimeTurnSettledEnvironmentProvider()).toBeNull();
    expect(host.getRunTrackedCwd(targetRun)).toBe('/repo');
    await host.materializeLaunchCompatibilityRepair(request, {} as never);
    host.attachStdoutHandler(targetRun);
    host.attachStderrHandler(targetRun);
    host.startStallWatchdog(targetRun);
    await host.seedLeadBootstrapPermissionRules('demo', '/repo');

    expect(boundHost.calls).toEqual([
      'host-context:cwd:run-1',
      'host-context:repair',
      'host-context:stdout:run-1',
      'host-context:stderr:run-1',
      'host-context:watchdog:run-1',
      'host-context:seed',
    ]);
  });

  it('creates deterministic launch setup and run ports from bound service adapters', async () => {
    const host = new BoundCallbackHost();
    const deps = createDeps(host);
    const boundary = createTeamProvisioningLaunchDeterministicFlowBoundary(deps);
    const setupPorts = boundary.createSetupPorts();
    const runPorts = boundary.createRunFlowPorts({ request, setup });
    const run = createRun();
    const cancellationOptions = { isCancelled: () => false };

    expect(setupPorts.getExistingAliveRunId(request.teamName)).toBe('alive-1');
    expect(setupPorts.getExistingRun('alive-1')).toBe(host.runs.get('alive-1'));
    expect(setupPorts.getRunTrackedCwd(host.runs.get('alive-1'))).toBe('/repo');
    setupPorts.deleteProvisioningRunByTeam(request.teamName);

    runPorts.registerRun(run.runId, run);
    runPorts.setProvisioningRunByTeam(request.teamName, run.runId);
    await runPorts.prepareWorkspaceTrustForDeterministicRun({
      mode: 'launch',
      run,
      claudePath: setup.claudePath,
      shellEnv: setup.shellEnv,
      stopAllGenerationAtStart: 7,
      workspaceTrustPlan: null,
      featureFlags: {
        enabled: false,
        claudePty: false,
        codexArgs: false,
        retry: false,
        fileLock: false,
      },
      provisioningEnv: {
        env: setup.shellEnv,
        authSource: 'none',
        geminiRuntimeAuth: null,
      },
    });
    await runPorts.publishMixedSecondaryLaneStatusChange(run, { laneId: 'lane-1' });
    await runPorts.buildRuntimeBootstrapMemberMcpLaunchConfigs({
      cwd: request.cwd,
      members: [],
      run,
    });
    await runPorts.validateAgentTeamsMcpRuntime(mcpConfigPath, cancellationOptions);
    runPorts.attachStdoutHandler(run);
    runPorts.attachStderrHandler(run);
    runPorts.startStallWatchdog(run);
    await runPorts.tryCompleteAfterTimeout(run);
    await runPorts.removeRunMemberMcpConfigFiles(run);
    runPorts.cleanupRun(run);
    await runPorts.handleProcessExit(run, 0);

    expect(host.runs.get(run.runId)).toBe(run);
    expect(host.provisioningRunByTeam.get(request.teamName)).toBe(run.runId);
    expect(host.providerRuntime.validateAgentTeamsMcpRuntime).toHaveBeenCalledWith(
      setup.claudePath,
      request.cwd,
      setup.shellEnv,
      mcpConfigPath,
      cancellationOptions
    );
    expect(runPorts.createInitialMemberSpawnStatusEntry()).toBe(memberSpawnStatus);
    expect(runPorts.getStopAllTeamsGeneration()).toBe(7);
    expect(host.calls).toEqual([
      'host-context:cwd:alive-1',
      'host-context:workspace-trust:run-1',
      'host-context:lane:run-1:lane-1',
      'host-context:member-mcp:run-1',
      'host-context:stdout:run-1',
      'host-context:stderr:run-1',
      'host-context:watchdog:run-1',
      'host-context:timeout:run-1',
      'host-context:remove-mcp:run-1',
      'host-context:cleanup:run-1',
      'host-context:exit:run-1:0',
    ]);
  });

  it('reads mutable setup dependencies after boundary construction', () => {
    const host = new BoundCallbackHost();
    const boundary = createTeamProvisioningLaunchDeterministicFlowBoundary(createDeps(host));
    const workspaceTrustCoordinator = {
      planArgsOnly: vi.fn(),
      planFull: vi.fn(),
      execute: vi.fn(),
    };
    const runtimeTurnSettledEnvironmentProvider = vi.fn(async () => ({
      RUNTIME_TURN_SETTLED_SPOOL_ROOT: spoolRootPath,
    }));

    expect(host.getWorkspaceTrustCoordinator).not.toHaveBeenCalled();
    expect(host.getRuntimeTurnSettledEnvironmentProvider).not.toHaveBeenCalled();

    host.setMutableSetupDependencies({
      workspaceTrustCoordinator,
      runtimeTurnSettledEnvironmentProvider,
    });

    const setupPorts = boundary.createSetupPorts();

    expect(host.getWorkspaceTrustCoordinator).toHaveBeenCalledTimes(1);
    expect(host.getRuntimeTurnSettledEnvironmentProvider).toHaveBeenCalledTimes(1);
    expect(setupPorts.workspaceTrustCoordinator).toBe(workspaceTrustCoordinator);
    expect(setupPorts.runtimeTurnSettledEnvironmentProvider).toBe(
      runtimeTurnSettledEnvironmentProvider
    );
  });
});
