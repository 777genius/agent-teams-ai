import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';

import {
  buildLaunchTeamMetaPayload,
  cleanupDeterministicLaunchMaterializationFailure,
  cleanupDeterministicLaunchSpawnFailure,
  type DeterministicLaunchSpawnFlowRun,
  isDeterministicLaunchSpawnCancelled,
  registerDeterministicLaunchChildHandlers,
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
    onProgress: vi.fn(),
    ...overrides,
  } as DeterministicLaunchSpawnFlowRun;
}

describe('TeamProvisioningLaunchDeterministicSpawnFlow', () => {
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

  it('persists normalized synthetic metadata when the relaunch request is sparse', () => {
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

    expect(
      buildLaunchTeamMetaPayload({
        request: sparseRequest,
        syntheticRequest: normalizedSyntheticRequest,
        launchIdentity,
        nowMs: 123,
      })
    ).toMatchObject({
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
    });
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

  it('cleans materialization failures in the legacy state-removal order', async () => {
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
      'delete-run',
      'delete-team-run',
      'cleanup-auth',
      'remove-mcp',
      'remove-member-mcp',
      'restore-config',
    ]);
    expect(run.bootstrapSpecPath).toBeNull();
    expect(run.bootstrapUserPromptPath).toBeNull();
    expect(run.mcpConfigPath).toBeNull();
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
        tryCompleteAfterTimeout: vi.fn(async () => false),
        killTeamProcess: vi.fn(),
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
    expect(cleanupRun).toHaveBeenCalledWith(run);

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

  it('kills and cleans up a timed-out launch when timeout completion persistence rejects', async () => {
    let timeoutCallback: (() => void) | null = null;
    const child = new EventEmitter() as ChildProcess;
    const run = createRun({ child });
    const killTeamProcess = vi.fn();
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
        killTeamProcess,
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

    expect(killTeamProcess).toHaveBeenCalledWith(child);
    expect(updateProgress).toHaveBeenCalledWith(
      run,
      'failed',
      'Timed out waiting for CLI (launch)',
      expect.objectContaining({ error: 'Timed out waiting for CLI during team launch.' })
    );
    expect(run.onProgress).toHaveBeenCalledWith(run.progress);
  });
});
