import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const flowMocks = vi.hoisted(() => ({
  materializeDeterministicLaunchBootstrapFiles: vi.fn(),
  removeDeterministicBootstrapSpecFile: vi.fn<() => Promise<void>>(),
  removeDeterministicBootstrapUserPromptFile: vi.fn<() => Promise<void>>(),
}));

type GenericModule = Record<string, unknown>;

vi.mock('../TeamProvisioningBootstrapSpec', async (importOriginal) => {
  const actual = await importOriginal<GenericModule>();
  return {
    ...actual,
    removeDeterministicBootstrapSpecFile: flowMocks.removeDeterministicBootstrapSpecFile,
    removeDeterministicBootstrapUserPromptFile:
      flowMocks.removeDeterministicBootstrapUserPromptFile,
  };
});

vi.mock('../TeamProvisioningLaunchTeamFlow', async (importOriginal) => {
  const actual = await importOriginal<GenericModule>();
  return {
    ...actual,
    materializeDeterministicLaunchBootstrapFiles:
      flowMocks.materializeDeterministicLaunchBootstrapFiles,
  };
});

import {
  buildLaunchTeamMetaPayload,
  cleanupDeterministicLaunchMaterializationFailure,
  cleanupDeterministicLaunchSpawnFailure,
  type DeterministicLaunchSpawnFlowRun,
  isDeterministicLaunchSpawnCancelled,
  persistDeterministicLaunchMetadata,
  persistDeterministicLaunchMetadataOrCleanup,
  registerDeterministicLaunchChildHandlers,
  runDeterministicLaunchSpawnFlow,
  type RunDeterministicLaunchSpawnFlowPorts,
} from '../TeamProvisioningLaunchDeterministicSpawnFlow';
import { buildLaunchSyntheticRequest } from '../TeamProvisioningLaunchTeamFlow';

import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
  TeamProvisioningProgress,
} from '@shared/types';
import type { ChildProcess } from 'child_process';

const launchIdentity: ProviderModelLaunchIdentity = {
  providerId: 'codex',
  providerBackendId: null,
  selectedModel: 'gpt-5',
  selectedModelKind: 'explicit',
  resolvedLaunchModel: 'gpt-5',
  catalogId: 'gpt-5',
  catalogSource: 'runtime',
  catalogFetchedAt: null,
  selectedEffort: 'high',
  resolvedEffort: 'high',
};

const request: TeamLaunchRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  worktree: 'feature-a',
  extraCliArgs: '--flag',
  limitContext: true,
  prompt: 'resume work',
};

const syntheticRequest: TeamCreateRequest = {
  ...request,
  displayName: 'Demo Team',
  description: 'Existing team',
  color: '#336699',
  members: [{ name: 'Builder', role: 'Build' }],
};

const testArtifactsRoot = '/repo/.agent-teams-test-artifacts';
const authHelperDirectory = `${testArtifactsRoot}/auth-helper`;
const authHelperPath = `${authHelperDirectory}/helper.sh`;
const authHelperKeyPath = `${authHelperDirectory}/key`;
const authHelperSettingsPath = `${authHelperDirectory}/settings.json`;
const bootstrapSpecPath = `${testArtifactsRoot}/agent-teams-test-spec/spec.json`;
const bootstrapUserPromptPath = `${testArtifactsRoot}/agent-teams-test-prompt/prompt.txt`;
const mcpConfigPath = `${testArtifactsRoot}/mcp.json`;

const anthropicApiKeyHelper = {
  teamName: 'demo',
  directory: authHelperDirectory,
  helperPath: authHelperPath,
  keyPath: authHelperKeyPath,
  settingsPath: authHelperSettingsPath,
  settingsObject: { apiKeyHelper: authHelperPath },
  settingsArgs: ['--settings', JSON.stringify({ apiKeyHelper: authHelperPath })],
  envPatch: {},
};

function createRun(
  overrides: Partial<DeterministicLaunchSpawnFlowRun> = {}
): DeterministicLaunchSpawnFlowRun {
  const progress: TeamProvisioningProgress = {
    runId: 'run-1',
    teamName: 'demo',
    state: 'validating',
    message: 'Validating team launch request',
    startedAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  };

  return {
    runId: 'run-1',
    teamName: 'demo',
    progress,
    bootstrapSpecPath,
    bootstrapUserPromptPath,
    mcpConfigPath,
    requiresFirstRealTurnSuccess: true,
    cancelRequested: false,
    processKilled: false,
    child: null,
    processClosed: false,
    deterministicBootstrap: true,
    effectiveMembers: syntheticRequest.members,
    lastDataReceivedAt: 0,
    lastStdoutReceivedAt: 0,
    timeoutHandle: null,
    provisioningComplete: false,
    finalizingByTimeout: false,
    spawnContext: null,
    stdoutBuffer: '',
    stderrBuffer: '',
    claudeLogLines: [],
    provisioningTraceLines: [],
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    anthropicApiKeyHelper,
    anthropicApiKeyHelperCleanupPromise: null,
    onProgress: vi.fn(),
    ...overrides,
  } as DeterministicLaunchSpawnFlowRun;
}

function createSpawnFlowPorts(
  order: string[]
): RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchSpawnFlowRun> {
  return {
    logger: { info: vi.fn() },
    mcpConfigBuilder: {
      writeConfigFile: vi.fn(async () => mcpConfigPath),
      removeConfigFile: vi.fn(async () => {
        order.push('remove-mcp');
      }),
    },
    readTasks: vi.fn(async () => []),
    logTaskReadWarning: vi.fn(),
    buildNativeAppManagedBootstrapSpecsWithDiagnostics: vi.fn(),
    buildRuntimeBootstrapMemberMcpLaunchConfigs: vi.fn(async () => new Map()),
    validateAgentTeamsMcpRuntime: vi.fn(async () => undefined),
    cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => {
      order.push('cleanup-auth');
    }),
    removeRunMemberMcpConfigFiles: vi.fn(async () => {
      order.push('remove-member-mcp');
    }),
    restorePrelaunchConfig: vi.fn(async () => {
      order.push('restore-config');
    }),
    deleteRun: vi.fn(() => {
      order.push('delete-run');
    }),
    deleteProvisioningRunByTeam: vi.fn(() => {
      order.push('delete-team-run');
    }),
    buildTeamRuntimeLaunchArgsPlan: vi.fn(async () => ({
      settingsArgs: [],
      fastModeArgs: [],
      runtimeTurnSettledHookArgs: [],
      providerArgs: [],
      extraArgs: [],
      inheritedProviderArgs: [],
      appManagedSettingsPath: null,
    })),
    teamMetaStore: {
      writeMeta: vi.fn(async () => undefined),
    },
    membersMetaStore: {
      updateMembers: vi.fn(async (_teamName, update) => {
        update([]);
      }),
    },
    nowMs: vi.fn(() => 123),
    getStopAllTeamsGeneration: vi.fn(() => 7),
    seedLeadBootstrapPermissionRules: vi.fn(async () => undefined),
    spawnCli: vi.fn(() => new EventEmitter() as ChildProcess),
    updateProgress: vi.fn((run: DeterministicLaunchSpawnFlowRun) => run.progress),
    attachStdoutHandler: vi.fn(),
    attachStderrHandler: vi.fn(),
    startStallWatchdog: vi.fn(),
    setTimeout: vi.fn(() => ({ timeout: true }) as unknown as NodeJS.Timeout),
    tryCompleteAfterTimeout: vi.fn(async () => false),
    killTeamProcessAndWait: vi.fn(async () => undefined),
    cleanupRun: vi.fn(),
    handleProcessExit: vi.fn(),
  } as unknown as RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchSpawnFlowRun>;
}

function runPreSpawnFailureFlow(
  run: DeterministicLaunchSpawnFlowRun,
  ports: RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchSpawnFlowRun>
) {
  return runDeterministicLaunchSpawnFlow(
    {
      request,
      syntheticRequest,
      run,
      runId: run.runId,
      claudePath: '/bin/claude',
      shellEnv: {},
      provisioningEnv: { env: {}, anthropicApiKeyHelper },
      stopAllGenerationAtStart: 7,
      resolvedProviderId: 'codex',
      providerArgsForLaunch: [],
      crossProviderMemberArgsForLaunch: { args: [] },
      launchIdentity,
      effectiveMemberSpecs: syntheticRequest.members,
      allEffectiveMemberSpecs: syntheticRequest.members,
      teammateRuntimeDisallowedTools: 'TeamDelete',
    },
    ports
  );
}

describe('TeamProvisioningLaunchDeterministicSpawnFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    flowMocks.materializeDeterministicLaunchBootstrapFiles.mockReset().mockResolvedValue({
      prompt: 'resume work',
      promptSize: { chars: 11, lines: 1 },
      mcpConfigPath,
      bootstrapSpecPath,
      bootstrapUserPromptPath,
    });
    flowMocks.removeDeterministicBootstrapSpecFile.mockReset().mockResolvedValue(undefined);
    flowMocks.removeDeterministicBootstrapUserPromptFile.mockReset().mockResolvedValue(undefined);
  });

  it('builds launch team metadata without persistence side effects', () => {
    expect(
      buildLaunchTeamMetaPayload({
        request,
        syntheticRequest,
        launchIdentity,
        nowMs: 123,
      })
    ).toEqual({
      displayName: 'Demo Team',
      description: 'Existing team',
      color: '#336699',
      cwd: '/repo',
      prompt: 'resume work',
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5',
      effort: 'high',
      fastMode: 'off',
      skipPermissions: false,
      worktree: 'feature-a',
      extraCliArgs: '--flag',
      limitContext: true,
      launchIdentity,
      createdAt: 123,
    });
  });

  it('persists normalized synthetic metadata, backend identity, and tombstones for a sparse relaunch', async () => {
    const sparseRequest: TeamLaunchRequest = {
      teamName: 'demo',
      cwd: '/repo',
      prompt: 'resume work',
    };
    const normalizedSyntheticRequest = buildLaunchSyntheticRequest({
      request: { ...request, fastMode: 'inherit' },
      members: syntheticRequest.members,
      configRaw: '{}',
    });
    const writeMeta = vi.fn(async () => undefined);
    let updatedMembers: TeamCreateRequest['members'] = [];
    const updateMembers = vi.fn(async (_teamName, update) => {
      updatedMembers = update([
        {
          name: 'builder',
          role: 'Removed builder',
          removedAt: Date.parse('2026-07-14T17:00:00.000Z'),
        },
      ]);
    });

    await persistDeterministicLaunchMetadata(
      {
        request: sparseRequest,
        syntheticRequest: normalizedSyntheticRequest,
        launchIdentity,
        allEffectiveMemberSpecs: normalizedSyntheticRequest.members,
      },
      {
        teamMetaStore: { writeMeta },
        membersMetaStore: { updateMembers },
        nowMs: () => 123,
      }
    );

    expect(writeMeta).toHaveBeenCalledWith(
      'demo',
      expect.objectContaining({
        cwd: '/repo',
        prompt: 'resume work',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5',
        effort: 'high',
        fastMode: 'inherit',
        skipPermissions: false,
        worktree: 'feature-a',
        extraCliArgs: '--flag',
        limitContext: true,
        launchIdentity,
        createdAt: 123,
      })
    );
    expect(updateMembers).toHaveBeenCalledWith('demo', expect.any(Function), {
      providerBackendId: 'codex-native',
    });
    expect(updatedMembers).toEqual([
      {
        name: 'builder',
        role: 'Removed builder',
        removedAt: Date.parse('2026-07-14T17:00:00.000Z'),
      },
    ]);
  });

  it('atomically persists only teammates when the launch roster includes team-lead and user', async () => {
    let updatedMembers: TeamCreateRequest['members'] = [];
    const updateMembers = vi.fn(async (_teamName, update) => {
      updatedMembers = update([]);
    });

    await persistDeterministicLaunchMetadata(
      {
        request,
        syntheticRequest,
        launchIdentity,
        allEffectiveMemberSpecs: [
          { name: ' team-lead ', role: 'Lead' },
          { name: 'USER', role: 'User' },
          { name: ' Builder ', role: ' Build ' },
        ],
      },
      {
        teamMetaStore: { writeMeta: vi.fn(async () => undefined) },
        membersMetaStore: { updateMembers },
        nowMs: () => 123,
      }
    );

    expect(updateMembers).toHaveBeenCalledWith('demo', expect.any(Function), {
      providerBackendId: 'codex-native',
    });
    expect(updatedMembers).toEqual([expect.objectContaining({ name: 'Builder', role: 'Build' })]);
  });

  it('rolls back materialized launch artifacts when runtime argument planning rejects', async () => {
    const planningError = new Error('runtime argument planning failed');
    const order: string[] = [];
    const run = createRun();
    const ports = createSpawnFlowPorts(order);
    ports.buildTeamRuntimeLaunchArgsPlan = vi.fn(async () => {
      order.push('plan-runtime-args');
      throw planningError;
    });

    await expect(runPreSpawnFailureFlow(run, ports)).rejects.toBe(planningError);

    expect(order).toEqual([
      'plan-runtime-args',
      'cleanup-auth',
      'remove-mcp',
      'remove-member-mcp',
      'restore-config',
      'delete-run',
      'delete-team-run',
    ]);
    expect(flowMocks.materializeDeterministicLaunchBootstrapFiles).toHaveBeenCalledOnce();
    expect(flowMocks.removeDeterministicBootstrapSpecFile).toHaveBeenCalledWith(bootstrapSpecPath);
    expect(flowMocks.removeDeterministicBootstrapUserPromptFile).toHaveBeenCalledWith(
      bootstrapUserPromptPath
    );
    expect(ports.teamMetaStore.writeMeta).not.toHaveBeenCalled();
    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('rolls back materialized launch artifacts when deterministic metadata persistence rejects', async () => {
    const persistenceError = new Error('members metadata persistence failed');
    const order: string[] = [];
    const run = createRun();
    const ports = createSpawnFlowPorts(order);
    ports.teamMetaStore.writeMeta = vi.fn(async () => {
      order.push('write-team-meta');
    });
    ports.membersMetaStore.updateMembers = vi.fn(async () => {
      order.push('update-members-meta');
      throw persistenceError;
    });

    await expect(runPreSpawnFailureFlow(run, ports)).rejects.toBe(persistenceError);

    expect(order).toEqual([
      'write-team-meta',
      'update-members-meta',
      'cleanup-auth',
      'remove-mcp',
      'remove-member-mcp',
      'restore-config',
      'delete-run',
      'delete-team-run',
    ]);
    expect(ports.buildTeamRuntimeLaunchArgsPlan).toHaveBeenCalledOnce();
    expect(flowMocks.materializeDeterministicLaunchBootstrapFiles).toHaveBeenCalledOnce();
    expect(flowMocks.removeDeterministicBootstrapSpecFile).toHaveBeenCalledWith(bootstrapSpecPath);
    expect(flowMocks.removeDeterministicBootstrapUserPromptFile).toHaveBeenCalledWith(
      bootstrapUserPromptPath
    );
    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('classifies an atomic members metadata update rejection as a launch failure and runs cleanup', async () => {
    const run = createRun();
    const order: string[] = [];

    await expect(
      persistDeterministicLaunchMetadataOrCleanup(
        {
          request,
          syntheticRequest,
          launchIdentity,
          allEffectiveMemberSpecs: syntheticRequest.members,
          run,
          runId: 'run-1',
          provisioningEnv: { env: {} },
        },
        {
          teamMetaStore: { writeMeta: vi.fn(async () => undefined) },
          membersMetaStore: {
            updateMembers: vi.fn(async () => {
              throw new Error('updateMembers failed');
            }),
          },
          nowMs: () => 123,
          cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => undefined),
          deleteRun: vi.fn(() => order.push('delete-run')),
          deleteProvisioningRunByTeam: vi.fn(() => order.push('delete-team-run')),
          mcpConfigBuilder: {
            writeConfigFile: vi.fn(async () => mcpConfigPath),
            removeConfigFile: vi.fn(async () => {
              order.push('remove-mcp');
            }),
          },
          removeRunMemberMcpConfigFiles: vi.fn(async () => {
            order.push('remove-member-mcp');
          }),
          restorePrelaunchConfig: vi.fn(async () => {
            order.push('restore-config');
          }),
        }
      )
    ).rejects.toThrow('updateMembers failed');

    expect(order).toEqual([
      'remove-mcp',
      'remove-member-mcp',
      'restore-config',
      'delete-run',
      'delete-team-run',
    ]);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('centralizes deterministic launch cancellation decisions', () => {
    expect(
      isDeterministicLaunchSpawnCancelled({
        run: { cancelRequested: false, processKilled: false },
        stopAllGenerationAtStart: 7,
        currentStopAllGeneration: 7,
      })
    ).toBe(false);
    expect(
      isDeterministicLaunchSpawnCancelled({
        run: { cancelRequested: true, processKilled: false },
        stopAllGenerationAtStart: 7,
        currentStopAllGeneration: 7,
      })
    ).toBe(true);
    expect(
      isDeterministicLaunchSpawnCancelled({
        run: { cancelRequested: false, processKilled: true },
        stopAllGenerationAtStart: 7,
        currentStopAllGeneration: 7,
      })
    ).toBe(true);
    expect(
      isDeterministicLaunchSpawnCancelled({
        run: { cancelRequested: false, processKilled: false },
        stopAllGenerationAtStart: 7,
        currentStopAllGeneration: 8,
      })
    ).toBe(true);
  });

  it('rechecks cancellation after permission seeding and does not spawn an orphan', async () => {
    const run = createRun();
    const ports = createSpawnFlowPorts([]);
    ports.seedLeadBootstrapPermissionRules = vi.fn(async () => {
      run.cancelRequested = true;
    });

    await expect(runPreSpawnFailureFlow(run, ports)).rejects.toThrow(
      'Team launch cancelled by app shutdown'
    );

    expect(ports.seedLeadBootstrapPermissionRules).toHaveBeenCalledOnce();
    expect(ports.spawnCli).not.toHaveBeenCalled();
    expect(ports.cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith(authHelperDirectory);
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(ports.deleteRun).toHaveBeenCalledWith(run.runId);
    expect(ports.deleteProvisioningRunByTeam).toHaveBeenCalledWith(run.teamName);
  });

  it('retains tracking through helper and artifact cleanup before state removal', async () => {
    const order: string[] = [];
    const run = createRun();

    await cleanupDeterministicLaunchMaterializationFailure(
      {
        request,
        run,
        runId: 'run-1',
        provisioningEnv: { env: {}, anthropicApiKeyHelper },
      },
      {
        deleteRun: vi.fn(() => order.push('delete-run')),
        deleteProvisioningRunByTeam: vi.fn(() => order.push('delete-team-run')),
        cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => {
          order.push('cleanup-auth');
        }),
        mcpConfigBuilder: {
          writeConfigFile: vi.fn(async () => mcpConfigPath),
          removeConfigFile: vi.fn(async () => {
            order.push('remove-mcp');
          }),
        },
        removeRunMemberMcpConfigFiles: vi.fn(async () => {
          order.push('remove-member-mcp');
        }),
        restorePrelaunchConfig: vi.fn(async () => {
          order.push('restore-config');
        }),
      }
    );

    expect(order).toEqual([
      'cleanup-auth',
      'remove-mcp',
      'remove-member-mcp',
      'restore-config',
      'delete-run',
      'delete-team-run',
    ]);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('retains launch tracking when helper cleanup fails and releases it on retry', async () => {
    const run = createRun();
    const deleteRun = vi.fn();
    const deleteProvisioningRunByTeam = vi.fn();
    const cleanupAnthropicApiKeyHelperMaterial = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error('remove failed'))
      .mockResolvedValueOnce(undefined);
    const cleanupPorts = {
      deleteRun,
      deleteProvisioningRunByTeam,
      cleanupAnthropicApiKeyHelperMaterial,
      mcpConfigBuilder: {
        writeConfigFile: vi.fn(async () => mcpConfigPath),
        removeConfigFile: vi.fn(async () => undefined),
      },
      removeRunMemberMcpConfigFiles: vi.fn(async () => undefined),
      restorePrelaunchConfig: vi.fn(async () => undefined),
    };

    await cleanupDeterministicLaunchMaterializationFailure(
      { request, run, runId: run.runId, provisioningEnv: { env: {}, anthropicApiKeyHelper } },
      cleanupPorts
    );

    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(deleteRun).not.toHaveBeenCalled();
    expect(deleteProvisioningRunByTeam).not.toHaveBeenCalled();

    await cleanupDeterministicLaunchMaterializationFailure(
      { request, run, runId: run.runId, provisioningEnv: { env: {}, anthropicApiKeyHelper } },
      cleanupPorts
    );

    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(deleteRun).toHaveBeenCalledWith(run.runId);
    expect(deleteProvisioningRunByTeam).toHaveBeenCalledWith(run.teamName);
  });

  it('cleans spawn failures in the legacy artifact-first order', async () => {
    const order: string[] = [];
    const run = createRun();

    await cleanupDeterministicLaunchSpawnFailure(
      {
        request,
        run,
        runId: 'run-1',
        provisioningEnv: { env: {}, anthropicApiKeyHelper },
      },
      {
        deleteRun: vi.fn(() => order.push('delete-run')),
        deleteProvisioningRunByTeam: vi.fn(() => order.push('delete-team-run')),
        cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => {
          order.push('cleanup-auth');
        }),
        mcpConfigBuilder: {
          writeConfigFile: vi.fn(async () => mcpConfigPath),
          removeConfigFile: vi.fn(async () => {
            order.push('remove-mcp');
          }),
        },
        removeRunMemberMcpConfigFiles: vi.fn(async () => {
          order.push('remove-member-mcp');
        }),
        restorePrelaunchConfig: vi.fn(async () => {
          order.push('restore-config');
        }),
      }
    );

    expect(order).toEqual([
      'remove-mcp',
      'remove-member-mcp',
      'cleanup-auth',
      'delete-run',
      'delete-team-run',
      'restore-config',
    ]);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
  });

  it('registers launch child timeout, error, and close handlers without spawning', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const cleanupRun = vi.fn();
    const handleProcessExit = vi.fn();
    const updateProgress = vi.fn<
      RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchSpawnFlowRun>['updateProgress']
    >((nextRun, state, message) => {
      nextRun.progress = { ...nextRun.progress, state, message };
      return nextRun.progress;
    });

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcessAndWait: vi.fn(async () => undefined),
        cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => undefined),
        updateProgress,
        cleanupRun,
        handleProcessExit,
      }
    );

    child.emit('error', new Error('spawn failed'));
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Failed to start Claude CLI (launch)',
      expect.objectContaining({ error: 'spawn failed' })
    );
    await vi.waitFor(() => {
      expect(cleanupRun).toHaveBeenCalledWith(run);
    });

    child.emit('close', 7);
    expect(handleProcessExit).toHaveBeenCalledWith(run, 7);

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await Promise.resolve();
    await Promise.resolve();
    expect(run.processKilled).toBe(true);
    expect(run.finalizingByTimeout).toBe(true);
  });

  it('does not kill or fail a timed-out launch when timeout recovery succeeds', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const tryCompleteAfterTimeout = vi.fn(async () => true);
    const killTeamProcessAndWait = vi.fn(async () => undefined);
    const updateProgress = vi.fn();
    const cleanupRun = vi.fn();

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout,
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial: vi.fn(async () => undefined),
        updateProgress,
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
    });

    expect(killTeamProcessAndWait).not.toHaveBeenCalled();
    expect(updateProgress).not.toHaveBeenCalled();
    expect(cleanupRun).not.toHaveBeenCalled();
    expect(run.processKilled).toBe(false);
    expect(run.finalizingByTimeout).toBe(true);
  });

  it('tries timeout recovery before killing and cleaning up an unrecovered launch', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const order: string[] = [];
    const tryCompleteAfterTimeout = vi.fn(async () => {
      order.push('recover');
      return false;
    });
    const killTeamProcessAndWait = vi.fn(async () => {
      order.push('kill');
    });
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const updateProgress = vi.fn((nextRun: DeterministicLaunchSpawnFlowRun, state, message) => {
      nextRun.progress = { ...nextRun.progress, state, message };
      return nextRun.progress;
    });

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout,
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress,
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(cleanupRun).toHaveBeenCalledWith(run);
    });

    expect(order).toEqual(['recover', 'kill']);
    expect(tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI (launch)',
      expect.objectContaining({ error: 'Timed out waiting for CLI during team launch.' })
    );
    expect(run.onProgress).toHaveBeenCalledWith(run.progress);
    expect(cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith(authHelperDirectory);
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('retains the timed-out launch and helper when process termination is unconfirmed', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const killTeamProcessAndWait = vi.fn(async () => {
      throw new Error('termination unconfirmed');
    });
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const updateProgress = vi.fn<
      RunDeterministicLaunchSpawnFlowPorts<DeterministicLaunchSpawnFlowRun>['updateProgress']
    >((nextRun, state, message) => {
      nextRun.progress = { ...nextRun.progress, state, message };
      return nextRun.progress;
    });

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback: () => void) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress,
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      const terminationFailureCall = updateProgress.mock.calls.find(
        (call) => call[2] === 'Failed to confirm timed-out CLI termination (launch)'
      );
      expect(terminationFailureCall?.[3]?.error).toContain('remains tracked');
    });

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(cleanupAnthropicApiKeyHelperMaterial).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('retains a terminated timed-out launch when helper cleanup needs retry', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => {
      throw new Error('helper cleanup failed');
    });
    const cleanupRun = vi.fn();

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback: () => void) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcessAndWait: vi.fn(async () => undefined),
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress: vi.fn((nextRun: DeterministicLaunchSpawnFlowRun) => nextRun.progress),
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith(authHelperDirectory);
    });

    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('does not release the launch helper or run before termination is confirmed', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    let confirmTermination!: () => void;
    const killTeamProcessAndWait = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          confirmTermination = resolve;
        })
    );
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback: () => void) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress: vi.fn((nextRun: DeterministicLaunchSpawnFlowRun) => nextRun.progress),
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    });

    expect(cleanupAnthropicApiKeyHelperMaterial).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();

    confirmTermination();
    await vi.waitFor(() => {
      expect(cleanupRun).toHaveBeenCalledWith(run);
    });

    expect(cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith(authHelperDirectory);
    expect(run.anthropicApiKeyHelper).toBeNull();
  });

  it('does not terminate or clean a replacement launch child after timeout probing', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const replacementChild = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    let finishProbe!: (ready: boolean) => void;
    const tryCompleteAfterTimeout = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          finishProbe = resolve;
        })
    );
    const killTeamProcessAndWait = vi.fn(async () => undefined);
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback: () => void) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout,
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress: vi.fn((nextRun: DeterministicLaunchSpawnFlowRun) => nextRun.progress),
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(tryCompleteAfterTimeout).toHaveBeenCalledWith(run);
    });

    run.child = replacementChild;
    finishProbe(false);
    await vi.waitFor(() => {
      expect(run.finalizingByTimeout).toBe(false);
    });

    expect(run.processKilled).toBe(false);
    expect(killTeamProcessAndWait).not.toHaveBeenCalled();
    expect(cleanupAnthropicApiKeyHelperMaterial).not.toHaveBeenCalled();
    expect(run.anthropicApiKeyHelper).toBe(anthropicApiKeyHelper);
    expect(cleanupRun).not.toHaveBeenCalled();
  });

  it('kills and cleans up a timed-out launch when timeout completion persistence rejects', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const killTeamProcessAndWait = vi.fn(async () => undefined);
    const cleanupAnthropicApiKeyHelperMaterial = vi.fn(async () => undefined);
    const cleanupRun = vi.fn();
    const updateProgress = vi.fn((nextRun: DeterministicLaunchSpawnFlowRun, state, message) => {
      nextRun.progress = { ...nextRun.progress, state, message };
      return nextRun.progress;
    });

    registerDeterministicLaunchChildHandlers(
      { run, child },
      {
        setTimeout: vi.fn((callback) => {
          timeoutCallback = callback;
          return { timeout: true } as unknown as NodeJS.Timeout;
        }),
        tryCompleteAfterTimeout: vi.fn(async () => {
          throw new Error('launch state persistence failed');
        }),
        killTeamProcessAndWait,
        cleanupAnthropicApiKeyHelperMaterial,
        updateProgress,
        cleanupRun,
        handleProcessExit: vi.fn(),
      }
    );

    const triggerTimeout = timeoutCallback as (() => void) | null;
    if (!triggerTimeout) {
      throw new Error('Expected launch timeout callback to be registered.');
    }
    triggerTimeout();
    await vi.waitFor(() => {
      expect(cleanupRun).toHaveBeenCalledWith(run);
    });

    expect(killTeamProcessAndWait).toHaveBeenCalledWith(child);
    expect(cleanupAnthropicApiKeyHelperMaterial).toHaveBeenCalledWith(authHelperDirectory);
    expect(run.anthropicApiKeyHelper).toBeNull();
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI (launch)',
      expect.objectContaining({ error: 'Timed out waiting for CLI during team launch.' })
    );
    expect(run.onProgress).toHaveBeenCalledWith(run.progress);
  });
});
