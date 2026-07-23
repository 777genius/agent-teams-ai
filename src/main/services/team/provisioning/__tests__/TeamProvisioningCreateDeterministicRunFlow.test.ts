import fs from 'fs';
import { describe, expect, it, vi } from 'vitest';

import {
  createAnthropicApiKeyHelperCleanupRetryOwner,
  createAnthropicApiKeyHelperSetupLease,
} from '../TeamProvisioningAnthropicApiKeyHelperLease';
import {
  type DeterministicCreateRunFlowRun,
  runDeterministicCreateRunFlow,
} from '../TeamProvisioningCreateDeterministicRunFlow';

import type { DeterministicCreateSetupFlowResult } from '../TeamProvisioningCreateDeterministicSetupFlow';
import type { DeterministicCreateSpawnFlowPorts } from '../TeamProvisioningCreateDeterministicSpawnFlow';
import type {
  MemberSpawnStatusEntry,
  TeamCreateRequest,
  TeamProvisioningProgress,
} from '@shared/types';

interface TestLane {
  memberName: string;
}
type TestRun = DeterministicCreateRunFlowRun & {
  observedProgress: TeamProvisioningProgress[];
};

const request: TeamCreateRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  providerBackendId: 'codex-native',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
  members: [
    { name: 'Lead', role: 'Lead' },
    { name: 'Builder', role: 'Build' },
  ],
  prompt: 'start work',
};

const progress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'demo',
  state: 'validating',
  message: 'Validating team provisioning request',
  startedAt: '2026-07-03T00:00:00.000Z',
  updatedAt: '2026-07-03T00:00:00.000Z',
};

const dynamicAnthropicHelper = {
  teamName: 'demo',
  directory: '/fixtures/demo/run-1',
  helperPath: '/fixtures/demo/run-1/helper.sh',
  keyPath: '/fixtures/demo/run-1/key',
  settingsPath: '/fixtures/demo/run-1/settings.json',
  settingsObject: { apiKeyHelper: '/fixtures/demo/run-1/helper.sh' },
  settingsArgs: ['--settings', '/fixtures/demo/run-1/settings.json'],
  envPatch: {},
};

function createSetup(): DeterministicCreateSetupFlowResult<TestLane> {
  const anthropicApiKeyHelperLease = createAnthropicApiKeyHelperSetupLease();
  anthropicApiKeyHelperLease.coalesce(dynamicAnthropicHelper);
  return {
    teamsBasePathsToProbe: [{ location: 'configured', basePath: '/teams' }],
    claudePath: '/bin/claude',
    provisioningEnv: {
      env: { CLAUDE_TEAM_CONTROL_URL: 'http://localhost:1234' },
      authSource: 'codex_runtime',
      geminiRuntimeAuth: null,
      providerArgs: ['--provider'],
      anthropicApiKeyHelper: null,
    },
    shellEnv: { PATH: '/bin' },
    geminiRuntimeAuth: null,
    resolvedProviderId: 'codex',
    providerArgsForLaunch: ['--provider'],
    inheritedProviderArgsForLaunch: ['--inherited'],
    effectiveMemberSpecs: [request.members[0]],
    allEffectiveMemberSpecs: request.members,
    launchIdentity: null,
    mixedSecondaryLanes: [{ memberName: 'Builder' }],
    workspaceTrustFeatureFlags: {
      enabled: true,
      claudePty: true,
      codexArgs: true,
      retry: true,
      fileLock: true,
    },
    workspaceTrustFullPlan: {
      launchArgPatches: [],
      providers: [],
      workspaces: [],
    },
    largeTeamWarning: null,
    anthropicApiKeyHelperLease,
  };
}

function createTestRun(onProgress: (progress: TeamProvisioningProgress) => void): TestRun {
  const observedProgress: TeamProvisioningProgress[] = [];
  return {
    runId: 'run-1',
    teamName: 'demo',
    progress,
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
    anthropicApiKeyHelper: null,
    anthropicApiKeyHelperCleanupPromise: null,
    bootstrapSpecPath: null,
    bootstrapUserPromptPath: null,
    mcpConfigPath: null,
    requiresFirstRealTurnSuccess: false,
    deterministicBootstrap: true,
    effectiveMembers: [request.members[0]],
    launchStateClearedForRun: false,
    provisioningTraceLines: [],
    lastProvisioningTraceKey: null,
    provisioningOutputParts: [],
    provisioningOutputIndexByMessageId: new Map<string, number>(),
    stallWarningIndex: null,
    apiRetryWarningIndex: null,
    observedProgress,
    onProgress: (nextProgress) => {
      observedProgress.push(nextProgress);
      onProgress(nextProgress);
    },
  } as TestRun;
}

function createSpawnPorts(order: string[]): DeterministicCreateSpawnFlowPorts<TestRun> {
  return {
    cleanupRun: vi.fn(() => order.push('cleanup-run')),
    removeRunMemberMcpConfigFiles: vi.fn(async () => {
      order.push('remove-member-mcp');
    }),
    unregisterRun: vi.fn(() => order.push('unregister-run')),
  } as unknown as DeterministicCreateSpawnFlowPorts<TestRun>;
}

describe('TeamProvisioningCreateDeterministicRunFlow', () => {
  it.each(['codex', 'gemini'] as const)(
    'retains a dynamically prepared Anthropic helper on a successful %s run',
    async (providerId) => {
      const order: string[] = [];
      const onProgress = vi.fn();
      const setup = createSetup();
      const providerRequest: TeamCreateRequest = {
        ...request,
        providerId,
        providerBackendId: providerId === 'codex' ? 'codex-native' : undefined,
        model: providerId === 'codex' ? 'gpt-5' : 'gemini-2.5-pro',
      };
      const spawnPorts = createSpawnPorts(order);
      const spawnFlow = vi.fn(async (input) => {
        order.push('spawn-flow');
        expect(input.run.launchStateClearedForRun).toBe(true);
        expect(input.run.anthropicApiKeyHelper).toBe(dynamicAnthropicHelper);
        expect(input.ports).toBe(spawnPorts);
        expect(input.stopAllGenerationAtStart).toBe(3);
        expect(input.providerArgsForLaunch).toBe(setup.providerArgsForLaunch);
        return { runId: input.runId };
      });

      const result = await runDeterministicCreateRunFlow({
        request: providerRequest,
        onProgress,
        createSetup: setup,
        runId: 'run-1',
        startedAt: '2026-07-03T00:00:00.000Z',
        stopAllGenerationAtStart: 3,
        disallowedTools: 'TeamDelete',
        logger: { info: vi.fn() },
        spawnPorts,
        ports: {
          anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
          createInitialMemberSpawnStatusEntry: vi.fn(
            (): MemberSpawnStatusEntry => ({
              status: 'waiting',
              launchState: 'starting',
              updatedAt: '2026-07-03T00:00:00.000Z',
            })
          ),
          createProvisioningRun: vi.fn((input) => {
            order.push('create-run');
            expect(input.runId).toBe('run-1');
            expect(input.startedAt).toBe('2026-07-03T00:00:00.000Z');
            expect(input.mixedSecondaryLanes).toBe(setup.mixedSecondaryLanes);
            return createTestRun(input.onProgress);
          }),
          resetTeamScopedTransientStateForNewRun: vi.fn(() => order.push('reset-transient')),
          registerRun: vi.fn(() => order.push('register-run')),
          setProvisioningRunByTeam: vi.fn(() => order.push('set-team-run')),
          initializeProvisioningTrace: vi.fn(() => order.push('initialize-trace')),
          prepareWorkspaceTrustForDeterministicRun: vi.fn(async (input) => {
            order.push('workspace-trust');
            expect(input.mode).toBe('create');
            expect(input.claudePath).toBe('/bin/claude');
            expect(input.shellEnv).toBe(setup.shellEnv);
            expect(input.stopAllGenerationAtStart).toBe(3);
          }),
          emitProvisioningCheckpoint: vi.fn((run, message) => {
            order.push(`checkpoint:${message}`);
            expect(run.runId).toBe('run-1');
          }),
          clearPersistedLaunchState: vi.fn(async (teamName, options) => {
            order.push('clear-launch-state');
            expect(teamName).toBe('demo');
            expect(options).toEqual({ expectedRunId: 'run-1' });
          }),
          runDeterministicCreateSpawnFlow: spawnFlow,
        },
      });

      expect(result).toEqual({ runId: 'run-1' });
      expect(onProgress).toHaveBeenCalledWith(progress);
      expect(order).toEqual([
        'create-run',
        'reset-transient',
        'register-run',
        'set-team-run',
        'initialize-trace',
        'workspace-trust',
        'checkpoint:Clearing persisted launch state',
        'clear-launch-state',
        'spawn-flow',
      ]);
    }
  );

  it('passes cleanup and unregister hooks through the spawn-flow ports', async () => {
    const order: string[] = [];
    const setup = createSetup();
    const spawnPorts = createSpawnPorts(order);
    let capturedRunId: string | null = null;

    await runDeterministicCreateRunFlow({
      request,
      onProgress: vi.fn(),
      createSetup: setup,
      runId: 'run-1',
      startedAt: '2026-07-03T00:00:00.000Z',
      stopAllGenerationAtStart: 3,
      disallowedTools: 'TeamDelete',
      logger: { info: vi.fn() },
      spawnPorts,
      ports: {
        anthropicApiKeyHelperCleanupRetryOwner: createAnthropicApiKeyHelperCleanupRetryOwner(),
        createInitialMemberSpawnStatusEntry: vi.fn(
          (): MemberSpawnStatusEntry => ({
            status: 'waiting',
            launchState: 'starting',
            updatedAt: '2026-07-03T00:00:00.000Z',
          })
        ),
        createProvisioningRun: vi.fn((input) => createTestRun(input.onProgress)),
        resetTeamScopedTransientStateForNewRun: vi.fn(),
        registerRun: vi.fn(),
        setProvisioningRunByTeam: vi.fn(),
        initializeProvisioningTrace: vi.fn(),
        prepareWorkspaceTrustForDeterministicRun: vi.fn(async () => undefined),
        emitProvisioningCheckpoint: vi.fn(),
        clearPersistedLaunchState: vi.fn(async () => undefined),
        runDeterministicCreateSpawnFlow: vi.fn(async (input) => {
          capturedRunId = input.run.runId;
          input.ports.cleanupRun(input.run);
          await input.ports.removeRunMemberMcpConfigFiles(input.run);
          input.ports.unregisterRun(input.runId, input.request.teamName);
          return { runId: input.runId };
        }),
      },
    });

    expect(capturedRunId).toBe('run-1');
    expect(order).toEqual(['cleanup-run', 'remove-member-mcp', 'unregister-run']);
  });

  it('retains an explicit retry owner when transfer cleanup fails before registration', async () => {
    const setup = createSetup();
    const retryOwner = createAnthropicApiKeyHelperCleanupRetryOwner();
    const cleanupError = Object.assign(new Error('helper cleanup busy'), { code: 'EACCES' });
    const readDirectory = vi.spyOn(fs.promises, 'readdir').mockRejectedValueOnce(cleanupError);
    let createdRun!: TestRun;

    await expect(
      runDeterministicCreateRunFlow({
        request,
        onProgress: vi.fn(),
        createSetup: setup,
        runId: 'run-transfer-failure',
        startedAt: '2026-07-03T00:00:00.000Z',
        stopAllGenerationAtStart: 3,
        disallowedTools: 'TeamDelete',
        logger: { info: vi.fn() },
        spawnPorts: createSpawnPorts([]),
        ports: {
          anthropicApiKeyHelperCleanupRetryOwner: retryOwner,
          createInitialMemberSpawnStatusEntry: vi.fn(
            (): MemberSpawnStatusEntry => ({
              status: 'waiting',
              launchState: 'starting',
              updatedAt: '2026-07-03T00:00:00.000Z',
            })
          ),
          createProvisioningRun: vi.fn((input) => {
            createdRun = createTestRun(input.onProgress);
            return createdRun;
          }),
          resetTeamScopedTransientStateForNewRun: vi.fn(() => {
            throw new Error('pre-registration failure');
          }),
          registerRun: vi.fn(),
          setProvisioningRunByTeam: vi.fn(),
          initializeProvisioningTrace: vi.fn(),
          prepareWorkspaceTrustForDeterministicRun: vi.fn(async () => undefined),
          emitProvisioningCheckpoint: vi.fn(),
          clearPersistedLaunchState: vi.fn(async () => undefined),
          runDeterministicCreateSpawnFlow: vi.fn(),
        },
      })
    ).rejects.toThrow('pre-registration failure');

    expect(createdRun.anthropicApiKeyHelper).toBe(dynamicAnthropicHelper);
    expect(retryOwner.getPendingOwnerCount()).toBe(1);

    readDirectory.mockRestore();
    await retryOwner.retryPendingForTeam('demo');
    expect(retryOwner.getPendingOwnerCount()).toBe(0);
    expect(createdRun.anthropicApiKeyHelper).toBeNull();
  });
});
