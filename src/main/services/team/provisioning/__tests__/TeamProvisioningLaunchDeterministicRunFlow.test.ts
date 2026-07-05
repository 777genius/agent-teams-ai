import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DeterministicLaunchRunFlowRun,
  type PreparedDeterministicLaunchSetup,
  runDeterministicLaunchRunFlow,
  type RunDeterministicLaunchRunFlowPorts,
} from '../TeamProvisioningLaunchDeterministicRunFlow';

import type {
  MemberSpawnStatusEntry,
  TeamLaunchRequest,
  TeamProvisioningProgress,
} from '@shared/types';

const testArtifactsRoot = '/repo/.agent-teams-test-artifacts';
const authHelperDirectory = `${testArtifactsRoot}/helper`;
const authHelperPath = `${authHelperDirectory}/helper.sh`;
const authHelperKeyPath = `${authHelperDirectory}/key`;
const authHelperSettingsPath = `${authHelperDirectory}/settings.json`;

const mocks = vi.hoisted(() => ({
  createDeterministicLaunchProvisioningRun: vi.fn(),
  prepareDeterministicLaunchRunState: vi.fn(),
  runDeterministicLaunchSpawnFlow: vi.fn(),
}));

vi.mock('../TeamProvisioningLaunchTeamFlow', () => ({
  createDeterministicLaunchProvisioningRun: mocks.createDeterministicLaunchProvisioningRun,
  prepareDeterministicLaunchRunState: mocks.prepareDeterministicLaunchRunState,
}));

vi.mock('../TeamProvisioningLaunchDeterministicSpawnFlow', () => ({
  runDeterministicLaunchSpawnFlow: mocks.runDeterministicLaunchSpawnFlow,
}));

interface TestLane {
  laneId: string;
}

const progress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'demo',
  state: 'validating',
  message: 'Validating team launch request',
  startedAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
};

const request: TeamLaunchRequest = {
  teamName: 'demo',
  cwd: '/repo',
  providerId: 'codex',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

const setup: PreparedDeterministicLaunchSetup<TestLane> = {
  kind: 'prepared',
  teamsBasePathsToProbe: [{ location: 'configured', basePath: '/teams' }],
  runId: 'run-1',
  startedAt: '2026-01-01T00:00:00.000Z',
  claudePath: '/bin/claude',
  shellEnv: { PATH: '/bin' },
  provisioningEnv: {
    env: { CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:1234' },
    authSource: 'codex_runtime',
    geminiRuntimeAuth: null,
    providerArgs: ['--provider-arg'],
    anthropicApiKeyHelper: {
      teamName: 'team-a',
      directory: authHelperDirectory,
      helperPath: authHelperPath,
      keyPath: authHelperKeyPath,
      settingsPath: authHelperSettingsPath,
      settingsObject: { apiKeyHelper: authHelperPath },
      settingsArgs: ['--settings', authHelperSettingsPath],
      envPatch: { ANTHROPIC_API_KEY_HELPER: authHelperPath },
    },
  },
  workspaceTrustFeatureFlags: {
    enabled: true,
    claudePty: false,
    codexArgs: true,
    retry: true,
    fileLock: true,
  },
  workspaceTrustFullPlan: {
    providers: [],
    workspaces: [],
    launchArgPatches: [],
  },
  resolvedProviderId: 'codex',
  providerArgsForLaunch: ['--model', 'gpt-5'],
  crossProviderMemberArgsForLaunch: {
    args: ['--member-provider'],
    providerArgsByProvider: new Map(),
    envPatch: {},
    usesAnthropicApiKeyHelper: false,
  },
  expectedMembers: ['Lead', 'Builder'],
  effectiveMemberSpecs: [
    { name: 'Lead', role: 'Lead' },
    { name: 'Builder', role: 'Build' },
  ],
  allEffectiveMemberSpecs: [
    { name: 'Lead', role: 'Lead' },
    { name: 'Builder', role: 'Build' },
  ],
  launchIdentity: {
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
  },
  syntheticRequest: {
    ...request,
    members: [
      { name: 'Lead', role: 'Lead' },
      { name: 'Builder', role: 'Build' },
    ],
  },
  mixedSecondaryLanes: [{ laneId: 'secondary-opencode' }],
  initialLaunchWarnings: ['Recovered launch roster'],
  initialLaunchWarningSource: 'members-meta',
};

function createMemberSpawnStatusEntry(): MemberSpawnStatusEntry {
  return {
    status: 'offline',
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    updatedAt: '2026-01-01T00:00:00.000Z',
  };
}

describe('TeamProvisioningLaunchDeterministicRunFlow', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('creates, prepares, and spawns a deterministic launch run with cleanup ports forwarded', async () => {
    const order: string[] = [];
    const run = {
      runId: 'run-1',
      teamName: 'demo',
      progress,
      mixedSecondaryLanes: setup.mixedSecondaryLanes,
    } as DeterministicLaunchRunFlowRun<TestLane>;
    const onProgress = vi.fn();

    mocks.createDeterministicLaunchProvisioningRun.mockImplementation((input) => {
      order.push('create-run');
      expect(input).toMatchObject({
        runId: 'run-1',
        teamName: 'demo',
        startedAt: setup.startedAt,
        onProgress,
        teamsBasePathsToProbe: setup.teamsBasePathsToProbe,
        syntheticRequest: setup.syntheticRequest,
        expectedMembers: setup.expectedMembers,
        effectiveMemberSpecs: setup.effectiveMemberSpecs,
        allEffectiveMemberSpecs: setup.allEffectiveMemberSpecs,
        launchIdentity: setup.launchIdentity,
        mixedSecondaryLanes: setup.mixedSecondaryLanes,
        workspaceTrustFullPlan: setup.workspaceTrustFullPlan,
        anthropicApiKeyHelper: setup.provisioningEnv.anthropicApiKeyHelper,
        initialLaunchWarnings: setup.initialLaunchWarnings,
        initialLaunchWarningSource: setup.initialLaunchWarningSource,
      });
      expect(input.createInitialMemberSpawnStatusEntry()).toEqual(createMemberSpawnStatusEntry());
      return run;
    });

    mocks.prepareDeterministicLaunchRunState.mockImplementation(async (input) => {
      order.push('prepare-run-state');
      expect(input.teamName).toBe('demo');
      expect(input.run).toBe(run);
      input.resetTeamScopedTransientStateForNewRun('demo');
      input.registerRun('run-1', run);
      input.setProvisioningRunByTeam('demo', 'run-1');
      await input.prepareWorkspaceTrustForDeterministicRun();
      await input.clearPersistedLaunchState('demo', { expectedRunId: 'run-1' });
      await input.publishMixedSecondaryLaneStatusChange(run, setup.mixedSecondaryLanes[0]);
    });

    mocks.runDeterministicLaunchSpawnFlow.mockImplementation(async (input, ports) => {
      order.push('spawn');
      expect(input).toMatchObject({
        request,
        syntheticRequest: setup.syntheticRequest,
        run,
        runId: 'run-1',
        claudePath: setup.claudePath,
        shellEnv: setup.shellEnv,
        provisioningEnv: setup.provisioningEnv,
        stopAllGenerationAtStart: 7,
        resolvedProviderId: setup.resolvedProviderId,
        providerArgsForLaunch: setup.providerArgsForLaunch,
        crossProviderMemberArgsForLaunch: setup.crossProviderMemberArgsForLaunch,
        launchIdentity: setup.launchIdentity,
        effectiveMemberSpecs: setup.effectiveMemberSpecs,
        allEffectiveMemberSpecs: setup.allEffectiveMemberSpecs,
        teammateRuntimeDisallowedTools: 'Bash(rm:*)',
      });
      ports.deleteRun('run-1');
      ports.deleteProvisioningRunByTeam('demo');
      await ports.restorePrelaunchConfig('demo');
      return { runId: 'run-1' };
    });

    const ports = {
      createInitialMemberSpawnStatusEntry: vi.fn(createMemberSpawnStatusEntry),
      prepareWorkspaceTrustForDeterministicRun: vi.fn(async (input) => {
        order.push('workspace-trust');
        expect(input).toEqual({
          mode: 'launch',
          run,
          claudePath: setup.claudePath,
          shellEnv: setup.shellEnv,
          stopAllGenerationAtStart: 7,
          workspaceTrustPlan: setup.workspaceTrustFullPlan,
          featureFlags: setup.workspaceTrustFeatureFlags,
          provisioningEnv: setup.provisioningEnv,
        });
      }),
      resetTeamScopedTransientStateForNewRun: vi.fn((teamName: string) => {
        order.push(`reset:${teamName}`);
      }),
      registerRun: vi.fn((runId: string, nextRun) => {
        order.push(`register:${runId}`);
        expect(nextRun).toBe(run);
      }),
      setProvisioningRunByTeam: vi.fn((teamName: string, runId: string) => {
        order.push(`set-team-run:${teamName}:${runId}`);
      }),
      clearPersistedLaunchState: vi.fn(async (teamName: string, options) => {
        order.push(`clear-launch-state:${teamName}:${options.expectedRunId}`);
      }),
      publishMixedSecondaryLaneStatusChange: vi.fn(async (nextRun, lane) => {
        order.push(`publish-lane:${lane.laneId}`);
        expect(nextRun).toBe(run);
      }),
      deleteRun: vi.fn((runId: string) => {
        order.push(`delete-run:${runId}`);
      }),
      deleteProvisioningRunByTeam: vi.fn((teamName: string) => {
        order.push(`delete-team-run:${teamName}`);
      }),
      restorePrelaunchConfig: vi.fn(async (teamName: string) => {
        order.push(`restore-prelaunch:${teamName}`);
      }),
    } as unknown as RunDeterministicLaunchRunFlowPorts<TestLane>;

    await expect(
      runDeterministicLaunchRunFlow(
        {
          request,
          setup,
          stopAllGenerationAtStart: 7,
          onProgress,
          teammateRuntimeDisallowedTools: 'Bash(rm:*)',
        },
        ports
      )
    ).resolves.toEqual({ runId: 'run-1' });

    expect(order).toEqual([
      'create-run',
      'prepare-run-state',
      'reset:demo',
      'register:run-1',
      'set-team-run:demo:run-1',
      'workspace-trust',
      'clear-launch-state:demo:run-1',
      'publish-lane:secondary-opencode',
      'spawn',
      'delete-run:run-1',
      'delete-team-run:demo',
      'restore-prelaunch:demo',
    ]);
    expect(mocks.createDeterministicLaunchProvisioningRun).toHaveBeenCalledTimes(1);
    expect(mocks.prepareDeterministicLaunchRunState).toHaveBeenCalledTimes(1);
    expect(mocks.runDeterministicLaunchSpawnFlow).toHaveBeenCalledTimes(1);
  });
});
