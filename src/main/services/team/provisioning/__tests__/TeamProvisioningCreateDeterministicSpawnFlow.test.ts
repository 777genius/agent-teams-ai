import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises';

import { getTasksBasePath, getTeamsBasePath } from '@main/utils/pathDecoder';
import { EventEmitter } from 'events';
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

import { createHostedApprovalRuntimeAdmissionComposition } from '../HostedApprovalRuntimeAdmissionComposition';
import { observeHostedApprovalRuntimeFailure } from '../HostedApprovalRuntimeDesktopLifecycle';
import { HostedApprovalRuntimeTransitionService } from '../HostedApprovalRuntimeTransitionService';
import { createAnthropicApiKeyHelperCleanupRetryOwner } from '../TeamProvisioningAnthropicApiKeyHelperLease';
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

async function createProductionRevocationHarness(teamName: string) {
  const root = path.join('/tmp', `create-timeout-revocation-${randomUUID()}`);
  const teams = path.join(root, 'teams');
  const team = path.join(teams, teamName);
  const state = path.join(root, 'state');
  await mkdir(team, { recursive: true, mode: 0o700 });
  await mkdir(state, { mode: 0o700 });
  await Promise.all([chmod(teams, 0o700), chmod(team, 0o700), chmod(state, 0o700)]);
  const admissionPath = path.join(team, 'hosted-approval-runtime-admission.v1.json');
  await writeFile(admissionPath, '{}\n', { mode: 0o600 });
  const coordinator = createHostedApprovalRuntimeAdmissionComposition({
    enabled: false,
    resolveTeamDirectoryPath: (requestedTeam) => path.join(teams, requestedTeam),
    stateDirectoryPath: state,
    authoritativeEvidence: {
      currentLifecycle: async () => null,
      acquireRosterSessionBootstrapProcessLease: async () => null,
      expectedInstalledArtifactDigest: async () => null,
    },
  });
  return {
    admissionPath,
    root,
    runtime: new HostedApprovalRuntimeTransitionService({
      coordinator,
      transitionAuthority: null,
    }),
  };
}

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
    anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
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
  const child = Object.assign(new EventEmitter(), { pid }) as unknown as ReturnType<
    PlanningPorts['spawnCli']
  >;
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

  it('settles termination and revocation before accepting timeout readiness recovery', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    const child = configureSpawnedChild(ports, 123);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      async (targetRun) => {
        expect(targetRun.processKilled).toBe(true);
        cleanupRun(targetRun);
        return true;
      }
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(tryCompleteAfterTimeout).toHaveBeenCalledOnce();
    expect(run.child).toBe(child);
    expect(run.processKilled).toBe(true);
    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(ports.handleProcessExit).toHaveBeenCalledWith(run, null);
    expect(updateProgress).not.toHaveBeenCalledWith(
      run,
      'failed',
      expect.any(String),
      expect.anything()
    );
    expect(cleanupRun).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('observes a rejected process-close failure barrier and retains cleanup ownership', async () => {
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 124);
    const cleanupRun = vi.fn();
    ports.cleanupRun = cleanupRun;
    ports.handleProcessExit = vi.fn(async () => {
      throw new Error('revocation fsync failed');
    });
    ports.updateProgress = vi.fn((nextRun, state, message, extras) => {
      nextRun.progress = { ...nextRun.progress, state, message, error: extras?.error };
      return nextRun.progress;
    });

    await runPlanningFailureFlow(run, ports);
    child.emit('close', 9);

    await vi.waitFor(() => expect(run.progress.state).toBe('failed'));
    expect(run.progress.error).toContain('remains tracked');
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('kills and cleans up the spawned child when it is genuinely not ready at timeout', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const onProgress = vi.fn();
    run.onProgress = onProgress;
    const ports = createPlanningPorts(order);
    const production = await createProductionRevocationHarness(run.teamName);
    const child = configureSpawnedChild(ports, 456);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      async (targetRun) => {
        expect(targetRun.processKilled).toBe(true);
        return false;
      }
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;
    ports.handleProcessExit = vi.fn(async () => {
      await observeHostedApprovalRuntimeFailure(
        production.runtime,
        {
          teamName: run.teamName,
          memberName: 'lead',
          runId: run.runId,
          phase: 'terminal',
          detail: 'deterministic-create-timeout',
          observedAt: new Date(0).toISOString(),
        },
        { error: vi.fn() }
      );
    });
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial.mockImplementationOnce(async () => {
      await expect(readFile(production.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    });

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();
    await vi.waitFor(() => expect(cleanupRun).toHaveBeenCalledWith(run));

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
    expect(ports.handleProcessExit).toHaveBeenCalledWith(run, null);
    expect(vi.mocked(ports.handleProcessExit).mock.invocationCallOrder[0]).toBeLessThan(
      cleanupRun.mock.invocationCallOrder[0]
    );
    expect(cleanupRun).toHaveBeenCalledOnce();
    expect(cleanupRun).toHaveBeenCalledWith(run);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledWith({
      directory: TEST_ANTHROPIC_HELPER_DIR,
    });
    expect(run.anthropicApiKeyHelper).toBeNull();
    await expect(readFile(production.admissionPath)).rejects.toMatchObject({ code: 'ENOENT' });
    await rm(production.root, { recursive: true, force: true });
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

  it('retries an incomplete timeout finalizer on close after termination initially fails', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const onProgress = vi.fn();
    run.onProgress = onProgress;
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 790);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    killTeamProcessAndWait
      .mockRejectedValueOnce(new Error('termination unconfirmed'))
      .mockResolvedValueOnce(undefined);

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

    child.emit('close', 1);
    await vi.waitFor(() => expect(cleanupRun).toHaveBeenCalledWith(run));

    expect(killTeamProcessAndWait).toHaveBeenCalledTimes(2);
    expect(ports.handleProcessExit).toHaveBeenCalledWith(run, null);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retains helper ownership and does not let a later close skip timeout finalization', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 791);
    const { cleanupRun, killTeamProcessAndWait } = configureTimeoutSideEffects(ports);
    flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial
      .mockRejectedValueOnce(new Error('helper remove failed'))
      .mockResolvedValueOnce(undefined);

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();

    child.emit('close', 1);
    await Promise.resolve();
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(ports.handleProcessExit).toHaveBeenCalledOnce();

    await ports.anthropicApiKeyHelperCleanupRetryOwner?.retryPendingForTeam(run.teamName);

    expect(cleanupRun).toHaveBeenCalledWith(run);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledTimes(2);
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retries an incomplete timeout finalizer on error after revocation initially fails', async () => {
    vi.useFakeTimers();
    const run = createPlanningRun();
    const ports = createPlanningPorts([]);
    const child = configureSpawnedChild(ports, 792);
    const { cleanupRun } = configureTimeoutSideEffects(ports);
    vi.mocked(ports.handleProcessExit)
      .mockRejectedValueOnce(new Error('revocation unavailable'))
      .mockResolvedValueOnce(undefined);

    await runPlanningFailureFlow(run, ports);
    await firePlanningTimeout();

    expect(cleanupRun).not.toHaveBeenCalled();
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).not.toHaveBeenCalled();

    child.emit('error', new Error('late child error'));
    await vi.waitFor(() => expect(cleanupRun).toHaveBeenCalledWith(run));

    expect(ports.handleProcessExit).toHaveBeenCalledTimes(2);
    expect(flowMocks.cleanupAnthropicTeamApiKeyHelperMaterial).toHaveBeenCalledOnce();
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('does not finalize a replacement child that owns the run before the timeout callback', async () => {
    vi.useFakeTimers();
    const order: string[] = [];
    const run = createPlanningRun();
    const ports = createPlanningPorts(order);
    configureSpawnedChild(ports, 111);
    const { cleanupRun, killTeamProcessAndWait, updateProgress } =
      configureTimeoutSideEffects(ports);
    const tryCompleteAfterTimeout = vi.fn<PlanningPorts['tryCompleteAfterTimeout']>(
      async () => false
    );
    ports.tryCompleteAfterTimeout = tryCompleteAfterTimeout;

    await runPlanningFailureFlow(run, ports);
    const replacementChild = new EventEmitter() as ReturnType<PlanningPorts['spawnCli']>;
    run.child = replacementChild;
    await vi.runOnlyPendingTimersAsync();

    expect(run.processKilled).toBe(false);
    expect(run.finalizingByTimeout).toBe(false);
    expect(tryCompleteAfterTimeout).not.toHaveBeenCalled();
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
