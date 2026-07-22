import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import * as path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const flowMocks = vi.hoisted(() => ({
  cleanupAnthropicTeamApiKeyHelperMaterial: vi.fn<() => Promise<void>>(),
  materializeDeterministicCreateTeamBootstrapFiles: vi.fn(),
  parseCliArgs: vi.fn<(raw: string | undefined) => string[]>(),
  removePath: vi.fn<() => Promise<void>>(),
}));

type GenericModule = Record<string, unknown>;
type FsModule = GenericModule & { promises: Record<string, unknown> };

vi.mock('fs', async (importOriginal) => {
  const actual = await importOriginal<FsModule>();
  return {
    ...actual,
    promises: {
      ...actual.promises,
      rm: flowMocks.removePath,
    },
  };
});

vi.mock('@shared/utils/cliArgsParser', async (importOriginal) => {
  const actual = await importOriginal<GenericModule>();
  return {
    ...actual,
    parseCliArgs: flowMocks.parseCliArgs,
  };
});

vi.mock('@main/services/runtime/anthropicTeamApiKeyHelper', async (importOriginal) => {
  const actual = await importOriginal<GenericModule>();
  return {
    ...actual,
    cleanupAnthropicTeamApiKeyHelperMaterial: flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial,
  };
});

vi.mock('../TeamProvisioningCreateTeamFlow', async (importOriginal) => {
  const actual = await importOriginal<GenericModule>();
  return {
    ...actual,
    materializeDeterministicCreateTeamBootstrapFiles:
      flowMocks.materializeDeterministicCreateTeamBootstrapFiles,
  };
});

import {
  buildDeterministicCreateCleanupTargets,
  type DeterministicCreateSpawnFlowPorts,
  type DeterministicCreateSpawnFlowRun,
  runDeterministicCreateSpawnFlow,
  shouldCancelDeterministicCreateSpawn,
} from '../TeamProvisioningCreateDeterministicSpawnFlow';

import type { TeamCreateRequest } from '@shared/types';

const TEST_BOOTSTRAP_SPEC_PATH = '/repo/.agent-teams/bootstrap.json';
const TEST_BOOTSTRAP_PROMPT_PATH = '/repo/.agent-teams/prompt.txt';
const TEST_MCP_CONFIG_PATH = '/repo/.agent-teams/mcp.json';
const TEST_ANTHROPIC_HELPER_DIR = '/repo/.agent-teams/helpers/anthropic';

type PlanningPorts = DeterministicCreateSpawnFlowPorts<DeterministicCreateSpawnFlowRun>;

const planningRequest: TeamCreateRequest = {
  teamName: 'planning-cleanup-team',
  cwd: '/repo',
  providerId: 'anthropic',
  model: 'claude-sonnet-4-5',
  skipPermissions: true,
  extraCliArgs: '--teammate-mode in-process',
  members: [{ name: 'Lead', role: 'Lead' }],
};

const anthropicApiKeyHelper = {
  teamName: planningRequest.teamName,
  directory: TEST_ANTHROPIC_HELPER_DIR,
  helperPath: path.join(TEST_ANTHROPIC_HELPER_DIR, 'helper.sh'),
  keyPath: path.join(TEST_ANTHROPIC_HELPER_DIR, 'key'),
  settingsPath: path.join(TEST_ANTHROPIC_HELPER_DIR, 'settings.json'),
  settingsObject: { apiKeyHelper: path.join(TEST_ANTHROPIC_HELPER_DIR, 'helper.sh') },
  settingsArgs: ['--settings', path.join(TEST_ANTHROPIC_HELPER_DIR, 'settings.json')],
  envPatch: {},
};

function createPlanningRun(): DeterministicCreateSpawnFlowRun {
  return {
    runId: 'planning-run',
    teamName: planningRequest.teamName,
    progress: {
      runId: 'planning-run',
      teamName: planningRequest.teamName,
      state: 'spawning',
      message: 'Planning launch',
      startedAt: '2026-07-19T00:00:00.000Z',
      updatedAt: '2026-07-19T00:00:00.000Z',
    },
    child: null,
    processClosed: false,
    spawnContext: null,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    timeoutHandle: null,
    processKilled: false,
    provisioningComplete: false,
    finalizingByTimeout: false,
    cancelRequested: false,
    bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
    bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
    mcpConfigPath: TEST_MCP_CONFIG_PATH,
    requiresFirstRealTurnSuccess: true,
    deterministicBootstrap: true,
    effectiveMembers: planningRequest.members,
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    anthropicApiKeyHelper,
    anthropicApiKeyHelperCleanupPromise: null,
    onProgress: vi.fn(),
  } as unknown as DeterministicCreateSpawnFlowRun;
}

function createPlanningPorts(
  order: string[]
): DeterministicCreateSpawnFlowPorts<DeterministicCreateSpawnFlowRun> {
  return {
    teamMetaStore: {
      writeMeta: vi.fn(async () => undefined),
      deleteMeta: vi.fn(async () => {
        order.push('delete-meta');
      }),
    },
    membersMetaStore: {
      writeMembers: vi.fn(async () => undefined),
    },
    mcpConfigBuilder: {
      writeConfigFile: vi.fn(async () => TEST_MCP_CONFIG_PATH),
      removeConfigFile: vi.fn(async () => {
        order.push('remove-mcp-config');
      }),
    },
    buildMemberMcpLaunchConfigs: vi.fn(async () => new Map()),
    validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
    buildTeamRuntimeLaunchArgsPlan: vi.fn(async () => {
      order.push('plan-launch');
      return {
        settingsArgs: [],
        fastModeArgs: [],
        runtimeTurnSettledHookArgs: [],
        providerArgs: [],
        extraArgs: [],
        inheritedProviderArgs: [],
        appManagedSettingsPath: null,
      };
    }),
    seedLeadBootstrapPermissionRules: vi.fn(async () => undefined),
    spawnCli:
      vi.fn() as unknown as DeterministicCreateSpawnFlowPorts<DeterministicCreateSpawnFlowRun>['spawnCli'],
    updateProgress: vi.fn((run: DeterministicCreateSpawnFlowRun) => run.progress),
    attachStdoutHandler: vi.fn(),
    attachStderrHandler: vi.fn(),
    startStallWatchdog: vi.fn(),
    startFilesystemMonitor: vi.fn(),
    tryCompleteAfterTimeout: vi.fn(async () => false),
    handleProcessExit: vi.fn(async () => undefined),
    killTeamProcessAndWait: vi.fn(async () => undefined),
    cleanupRun: vi.fn(),
    removeRunMemberMcpConfigFiles: vi.fn(async () => {
      order.push('remove-member-mcp-configs');
    }),
    unregisterRun: vi.fn(() => {
      order.push('unregister-run');
    }),
    getStopAllTeamsGeneration: vi.fn(() => 4),
  };
}

function runPlanningFailureFlow(
  run: DeterministicCreateSpawnFlowRun,
  ports: DeterministicCreateSpawnFlowPorts<DeterministicCreateSpawnFlowRun>
): Promise<{ runId: string }> {
  return runDeterministicCreateSpawnFlow({
    request: planningRequest,
    run,
    runId: run.runId,
    effectiveMemberSpecs: planningRequest.members,
    allEffectiveMemberSpecs: planningRequest.members,
    launchIdentity: null,
    provisioningEnv: {
      env: {},
      authSource: 'anthropic_api_key_helper',
      geminiRuntimeAuth: null,
      providerArgs: [],
      anthropicApiKeyHelper,
    },
    claudePath: '/bin/claude',
    shellEnv: {},
    resolvedProviderId: 'anthropic',
    providerArgsForLaunch: [],
    inheritedProviderArgsForLaunch: [],
    geminiRuntimeAuth: null,
    stopAllGenerationAtStart: 4,
    disallowedTools: 'TeamDelete',
    logger: { info: vi.fn() },
    ports,
  });
}

function configureSpawnedChild(
  ports: PlanningPorts,
  pid: number
): ReturnType<PlanningPorts['spawnCli']> {
  const child = {
    pid,
    once: vi.fn(),
  } as unknown as ReturnType<PlanningPorts['spawnCli']>;
  ports.spawnCli = vi.fn(() => child) as unknown as typeof ports.spawnCli;
  return child;
}

function configureTimeoutSideEffects(ports: PlanningPorts): {
  cleanupRun: ReturnType<typeof vi.fn<PlanningPorts['cleanupRun']>>;
  killTeamProcessAndWait: ReturnType<typeof vi.fn<PlanningPorts['killTeamProcessAndWait']>>;
  updateProgress: ReturnType<typeof vi.fn<PlanningPorts['updateProgress']>>;
} {
  const cleanupRun = vi.fn<PlanningPorts['cleanupRun']>();
  const killTeamProcessAndWait = vi.fn<PlanningPorts['killTeamProcessAndWait']>(
    async () => undefined
  );
  const updateProgress = vi.fn<PlanningPorts['updateProgress']>((run, state, message) => {
    run.progress = { ...run.progress, state, message };
    return run.progress;
  });
  ports.cleanupRun = cleanupRun;
  ports.killTeamProcessAndWait = killTeamProcessAndWait;
  ports.updateProgress = updateProgress;
  return { cleanupRun, killTeamProcessAndWait, updateProgress };
}

async function firePlanningTimeout(): Promise<void> {
  await vi.runOnlyPendingTimersAsync();
  await Promise.resolve();
}

describe('TeamProvisioningCreateDeterministicSpawnFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flowMocks.parseCliArgs.mockReset().mockReturnValue(['--teammate-mode', 'in-process']);
    flowMocks.materializeDeterministicCreateTeamBootstrapFiles.mockReset().mockResolvedValue({
      teamDir: path.join(getTeamsBasePath(), planningRequest.teamName),
      tasksDir: path.join(getTasksBasePath(), planningRequest.teamName),
      bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
      bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
      mcpConfigPath: TEST_MCP_CONFIG_PATH,
    });
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial.mockReset().mockResolvedValue(undefined);
    flowMocks.removePath.mockReset().mockResolvedValue(undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('plans deterministic create cleanup targets from run materialization state', () => {
    expect(
      buildDeterministicCreateCleanupTargets({
        teamName: 'runtime-team',
        bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
        bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
        mcpConfigPath: TEST_MCP_CONFIG_PATH,
        anthropicApiKeyHelperDirectory: TEST_ANTHROPIC_HELPER_DIR,
      })
    ).toEqual({
      teamName: 'runtime-team',
      teamDir: path.join(getTeamsBasePath(), 'runtime-team'),
      tasksDir: path.join(getTasksBasePath(), 'runtime-team'),
      bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
      bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
      mcpConfigPath: TEST_MCP_CONFIG_PATH,
      anthropicApiKeyHelperDirectory: TEST_ANTHROPIC_HELPER_DIR,
    });
  });

  it('normalizes omitted deterministic create cleanup paths to null', () => {
    expect(buildDeterministicCreateCleanupTargets({ teamName: 'runtime-team' })).toMatchObject({
      bootstrapSpecPath: null,
      bootstrapUserPromptPath: null,
      mcpConfigPath: null,
      anthropicApiKeyHelperDirectory: null,
    });
  });

  it('cancels deterministic create spawn when the run or stop generation changed', () => {
    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(false);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: true,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(true);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: true,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 7,
      })
    ).toBe(true);

    expect(
      shouldCancelDeterministicCreateSpawn({
        cancelRequested: false,
        processKilled: false,
        stopAllGenerationAtStart: 7,
        currentStopAllTeamsGeneration: 8,
      })
    ).toBe(true);
  });

  it('cleans the transferred helper when CLI argument parsing fails before materialization', async () => {
    const parseError = new Error('pre-materialization parse failed');
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    flowMocks.parseCliArgs.mockImplementationOnce(() => {
      throw parseError;
    });

    await expect(runPlanningFailureFlow(run, ports)).rejects.toBe(parseError);

    expect(flowMocks.materializeDeterministicCreateTeamBootstrapFiles).not.toHaveBeenCalled();
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: TEST_ANTHROPIC_HELPER_DIR,
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(flowMocks.removePath).not.toHaveBeenCalled();
    expect(order).toEqual(['unregister-run']);
  });

  it('cleans the transferred helper when cancellation wins immediately before spawn', async () => {
    const run = createPlanningRun();
    run.cancelRequested = true;
    const ports = createPlanningPorts([]);

    await expect(runPlanningFailureFlow(run, ports)).rejects.toThrow(
      'Team launch cancelled by app shutdown'
    );

    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.unregisterRun).toHaveBeenCalledWith(run.runId, planningRequest.teamName);
  });

  it('rechecks cancellation after permission seeding and does not spawn an orphan', async () => {
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const permissionRequest = { ...planningRequest, skipPermissions: false };
    ports.seedLeadBootstrapPermissionRules = vi.fn(async () => {
      run.cancelRequested = true;
    });

    await expect(
      runDeterministicCreateSpawnFlow({
        request: permissionRequest,
        run,
        runId: run.runId,
        effectiveMemberSpecs: permissionRequest.members,
        allEffectiveMemberSpecs: permissionRequest.members,
        launchIdentity: null,
        provisioningEnv: {
          env: {},
          authSource: 'anthropic_api_key_helper',
          geminiRuntimeAuth: null,
          providerArgs: [],
          anthropicApiKeyHelper,
        },
        claudePath: '/bin/claude',
        shellEnv: {},
        resolvedProviderId: 'anthropic',
        providerArgsForLaunch: [],
        inheritedProviderArgsForLaunch: [],
        geminiRuntimeAuth: null,
        stopAllGenerationAtStart: 4,
        disallowedTools: 'TeamDelete',
        logger: { info: vi.fn() },
        ports,
      })
    ).rejects.toThrow('Team launch cancelled by app shutdown');

    expect(ports.seedLeadBootstrapPermissionRules).toHaveBeenCalledOnce();
    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: TEST_ANTHROPIC_HELPER_DIR,
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.unregisterRun).toHaveBeenCalledWith(run.runId, permissionRequest.teamName);
  });

  it('cleans the transferred helper when synchronous spawn throws', async () => {
    const spawnError = new Error('synchronous spawn failed');
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    ports.spawnCli = vi.fn(() => {
      throw spawnError;
    });

    await expect(runPlanningFailureFlow(run, ports)).rejects.toBe(spawnError);

    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.unregisterRun).toHaveBeenCalledWith(run.runId, planningRequest.teamName);
  });

  it('rolls back materialized create artifacts when the launch CLI argument parse fails', async () => {
    const parseError = new Error('launch parse failed');
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    flowMocks.materializeDeterministicCreateTeamBootstrapFiles.mockImplementationOnce(async () => {
      order.push('materialize');
      return {
        teamDir: path.join(getTeamsBasePath(), planningRequest.teamName),
        tasksDir: path.join(getTasksBasePath(), planningRequest.teamName),
        bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
        bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
        mcpConfigPath: TEST_MCP_CONFIG_PATH,
      };
    });
    flowMocks.parseCliArgs
      .mockReturnValueOnce(['--teammate-mode', 'in-process'])
      .mockImplementationOnce(() => {
        throw parseError;
      });
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial.mockImplementationOnce(async () => {
      order.push('remove-anthropic-helper');
    });

    await expect(runPlanningFailureFlow(run, ports)).rejects.toBe(parseError);

    expect(order).toEqual([
      'materialize',
      'remove-anthropic-helper',
      'delete-meta',
      'remove-mcp-config',
      'remove-member-mcp-configs',
      'unregister-run',
    ]);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('preserves the launch planning error while completing best-effort materialization cleanup', async () => {
    const planningError = new Error('runtime launch planning failed');
    const cleanupError = new Error('cleanup failed');
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    flowMocks.materializeDeterministicCreateTeamBootstrapFiles.mockImplementationOnce(async () => {
      order.push('materialize');
      return {
        teamDir: path.join(getTeamsBasePath(), planningRequest.teamName),
        tasksDir: path.join(getTasksBasePath(), planningRequest.teamName),
        bootstrapSpecPath: TEST_BOOTSTRAP_SPEC_PATH,
        bootstrapUserPromptPath: TEST_BOOTSTRAP_PROMPT_PATH,
        mcpConfigPath: TEST_MCP_CONFIG_PATH,
      };
    });
    ports.buildTeamRuntimeLaunchArgsPlan = vi.fn(async () => {
      order.push('plan-launch');
      throw planningError;
    });
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial.mockImplementationOnce(async () => {
      order.push('remove-anthropic-helper');
      throw cleanupError;
    });
    ports.teamMetaStore.deleteMeta = vi.fn(async () => {
      order.push('delete-meta');
      throw cleanupError;
    });
    ports.mcpConfigBuilder.removeConfigFile = vi.fn(async () => {
      order.push('remove-mcp-config');
      throw cleanupError;
    });
    ports.removeRunMemberMcpConfigFiles = vi.fn(async () => {
      order.push('remove-member-mcp-configs');
      throw cleanupError;
    });

    await expect(runPlanningFailureFlow(run, ports)).rejects.toBe(planningError);

    expect(order).toEqual([
      'materialize',
      'plan-launch',
      'remove-anthropic-helper',
      'delete-meta',
      'remove-mcp-config',
      'remove-member-mcp-configs',
    ]);
    expect(ports.unregisterRun).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(flowMocks.removePath).toHaveBeenCalledTimes(4);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('lets readiness win at the timeout deadline without killing or failure cleanup', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    const child = configureSpawnedChild(ports, 123);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      async (targetRun) => {
        expect(targetRun.processKilled).toBe(false);
        cleanupRun(targetRun);
        return true;
      }
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(tryCompleteAfterTimeout).toHaveBeenCalledOnce();
    expect(run.child).toBe(child);
    expect(run.processKilled).toBe(false);
    expect(killTeamProcessAndWait).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalledWith(
      run,
      'failed',
      expect.any(String),
      expect.anything()
    );
    expect(cleanupRun).toHaveBeenCalledOnce();
  });

  it('kills and cleans up the spawned child when it is genuinely not ready at timeout', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const onProgress = vi.fn();
    run.onProgress = onProgress;
    const ports = createPlanningPorts(order);
    const child = configureSpawnedChild(ports, 456);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      async (targetRun) => {
        expect(targetRun.processKilled).toBe(false);
        return false;
      }
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(run.processKilled).toBe(true);
    expect(killTeamProcessAndWait).toHaveBeenCalledOnce();
    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI',
      expect.any(Object)
    );
    const failureExtras = updateProgress.mock.calls.find((call) => call[1] === 'failed')?.[3];
    expect(failureExtras?.error).toContain('Timed out waiting for CLI');
    expect(onProgress).toHaveBeenCalledWith(run.progress);
    expect(cleanupRun).toHaveBeenCalledOnce();
    expect(cleanupRun).toHaveBeenCalledWith(run);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: TEST_ANTHROPIC_HELPER_DIR,
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('does not release the timeout helper or run before termination is confirmed', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 457);
    const { cleanupRun, killTeamProcessAndWait } = configureTimeoutSideEffects(ports);
    let confirmTermination!: () => void;
    killTeamProcessAndWait.mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          confirmTermination = resolve;
        })
    );

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();

    confirmTermination();
    await vi.waitFor(() => {
      expect(cleanupRun).toHaveBeenCalledWith(run);
    });

    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: TEST_ANTHROPIC_HELPER_DIR,
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('kills and cleans up the spawned child when the readiness check rejects', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const onProgress = vi.fn();
    run.onProgress = onProgress;
    const ports = createPlanningPorts(order);
    const child = configureSpawnedChild(ports, 789);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(async () => {
      throw new Error('launch state persistence failed');
    });
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(run.processKilled).toBe(true);
    expect(killTeamProcessAndWait).toHaveBeenCalledOnce();
    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI',
      expect.any(Object)
    );
    const failureExtras = updateProgress.mock.calls.find((call) => call[1] === 'failed')?.[3];
    expect(failureExtras?.error).toContain('Timed out waiting for CLI');
    expect(onProgress).toHaveBeenCalledWith(run.progress);
    expect(cleanupRun).toHaveBeenCalledOnce();
    expect(cleanupRun).toHaveBeenCalledWith(run);
  });

  it('retains the timed-out run and helper when process-tree termination is unconfirmed', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const onProgress = vi.fn();
    run.onProgress = onProgress;
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 790);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    killTeamProcessAndWait.mockRejectedValueOnce(new Error('termination unconfirmed'));

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    const terminationFailureCall = updateProgress.mock.calls.find(
      (call) => call[2] === 'Failed to confirm timed-out CLI termination'
    );
    expect(terminationFailureCall?.[3]?.error).toContain('remains tracked');
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(onProgress).toHaveBeenCalledWith(run.progress);
  });

  it('retains the terminated timed-out run when helper cleanup needs retry', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 791);
    const { cleanupRun, killTeamProcessAndWait } = configureTimeoutSideEffects(ports);
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial.mockRejectedValueOnce(
      new Error('helper remove failed')
    );

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('does not kill or clean up a replacement child that takes ownership during the check', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    configureSpawnedChild(ports, 111);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    let resolveReadiness!: (ready: boolean) => void;
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      () =>
        new Promise<boolean>((resolve) => {
          resolveReadiness = resolve;
        })
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    await vi.runOnlyPendingTimersAsync();
    expect(tryCompleteAfterTimeout).toHaveBeenCalledOnce();

    const replacementChild = configureSpawnedChild(ports, 222);
    run.child = replacementChild;
    resolveReadiness(false);
    await Promise.resolve();
    await Promise.resolve();

    expect(run.processKilled).toBe(false);
    expect(run.finalizingByTimeout).toBe(false);
    expect(killTeamProcessAndWait).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalledWith(
      run,
      'failed',
      expect.any(String),
      expect.anything()
    );
    expect(cleanupRun).not.toHaveBeenCalled();
  });
});
