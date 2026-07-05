import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  type DeterministicLaunchSetupPorts,
  prepareDeterministicLaunchSetup,
} from '../TeamProvisioningLaunchDeterministicSetupFlow';

import type { CrossProviderMemberArgsResult } from '../TeamProvisioningEnvBuilder';
import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  ProviderModelLaunchIdentity,
  TeamCreateRequest,
  TeamLaunchRequest,
} from '@shared/types';

const request: TeamLaunchRequest = {
  teamName: 'demo',
  cwd: '/tmp',
  providerId: 'codex',
  model: 'gpt-5',
  effort: 'high',
  fastMode: 'off',
  skipPermissions: false,
};

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

const configRaw = JSON.stringify({
  name: ' Demo Team ',
  color: ' blue ',
  projectPath: '/tmp',
});

function createMembers(): TeamCreateRequest['members'] {
  return [
    { name: 'Lead', role: 'Lead', providerId: 'codex' },
    { name: 'Reviewer', role: 'Review', providerId: 'anthropic' },
  ];
}

function createCrossProviderArgs(): CrossProviderMemberArgsResult {
  return {
    args: ['--member-provider', 'anthropic'],
    providerArgsByProvider: new Map([['anthropic', ['--model', 'claude-sonnet']]]),
    envPatch: {
      ANTHROPIC_API_KEY: 'fake-helper-key',
      ANTHROPIC_AUTH_TOKEN: 'fake-token',
    },
    usesAnthropicApiKeyHelper: true,
  };
}

function createPorts(
  overrides: Partial<DeterministicLaunchSetupPorts<{ laneId: string }>> = {}
): DeterministicLaunchSetupPorts<{ laneId: string }> {
  const members = createMembers();
  const lanePlan: TeamRuntimeLanePlan = {
    mode: 'primary_only',
    primaryMembers: [members[0] as TeamRuntimeLanePlan['primaryMembers'][number]],
    allMembers: members as TeamRuntimeLanePlan['allMembers'],
    sideLanes: [],
  };

  return {
    readTeamConfigRaw: vi.fn(async () => configRaw),
    getExistingAliveRunId: vi.fn(() => null),
    getExistingRun: vi.fn(() => null),
    getRunTrackedCwd: vi.fn(() => null),
    deleteProvisioningRunByTeam: vi.fn(),
    launchExpectedMembersPorts: {
      readLaunchState: vi.fn(async () => null),
      readBootstrapLaunchSnapshot: vi.fn(async () => null),
      getMembers: vi.fn(async () => members),
      listInboxNames: vi.fn(async () => []),
      warn: vi.fn(),
    },
    materializeLaunchCompatibilityRepair: vi.fn(async () => undefined),
    normalizeTeamConfigForLaunch: vi.fn(async () => undefined),
    assertConfigLeadOnlyForLaunch: vi.fn(async () => undefined),
    updateConfigProjectPath: vi.fn(async () => undefined),
    restorePrelaunchConfig: vi.fn(async () => undefined),
    resolveClaudePath: vi.fn(async () => '/usr/local/bin/claude'),
    buildProvisioningEnv: vi.fn(async () => ({
      env: {
        BASE_ENV: '1',
        ANTHROPIC_AUTH_TOKEN: 'old-token',
      },
      authSource: 'codex_runtime' as const,
      geminiRuntimeAuth: null,
      providerArgs: ['--primary-provider-arg'],
    })),
    workspaceTrustCoordinator: null,
    workspaceTrustWorkspaceCollectionPorts: {
      getHomeDir: () => '/tmp',
      realpath: vi.fn(async (value: string) => value),
      resolveGitRoot: vi.fn(async () => null),
      resolveCanonicalGitRoot: vi.fn(async (value: string) => value),
      platform: 'posix',
    },
    materializeEffectiveTeamMemberSpecs: vi.fn(async (params) => params.members),
    resolveOpenCodeMemberWorkspacesForRuntime: vi.fn(async (params) => params.members),
    runtimeTurnSettledEnvironmentProvider: vi.fn(async () => ({ CODEX_TURN_SETTLED: '1' })),
    planRuntimeLanesOrThrow: vi.fn(() => lanePlan),
    createMixedSecondaryLaneStates: vi.fn(() => [{ laneId: 'primary' }]),
    buildCrossProviderMemberArgs: vi.fn(async () => createCrossProviderArgs()),
    resolveAndValidateLaunchIdentity: vi.fn(async () => launchIdentity),
    randomUUID: vi.fn(() => 'run-1'),
    nowIso: vi.fn(() => '2026-01-01T00:00:00.000Z'),
    logger: {
      info: vi.fn(),
      warn: vi.fn(),
    },
    ...overrides,
  };
}

describe('TeamProvisioningLaunchDeterministicSetupFlow', () => {
  beforeEach(() => {
    vi.stubEnv('AGENT_TEAMS_WORKSPACE_TRUST', '0');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('reuses a matching live launch run before mutating launch config', async () => {
    const ports = createPorts({
      getExistingAliveRunId: vi.fn(() => 'run-existing'),
      getExistingRun: vi.fn(() => ({ child: {}, processKilled: false, cancelRequested: false })),
      getRunTrackedCwd: vi.fn(() => '/tmp'),
    });

    await expect(prepareDeterministicLaunchSetup(request, ports)).resolves.toEqual({
      kind: 'reuse',
      runId: 'run-existing',
    });

    expect(ports.deleteProvisioningRunByTeam).toHaveBeenCalledWith('demo');
    expect(ports.launchExpectedMembersPorts.getMembers).not.toHaveBeenCalled();
    expect(ports.normalizeTeamConfigForLaunch).not.toHaveBeenCalled();
  });

  it('restores the prelaunch config when CLI resolution fails after normalization', async () => {
    const ports = createPorts({
      resolveClaudePath: vi.fn(async () => null),
    });

    await expect(prepareDeterministicLaunchSetup(request, ports)).rejects.toThrow();

    expect(ports.normalizeTeamConfigForLaunch).toHaveBeenCalledWith('demo', configRaw);
    expect(ports.assertConfigLeadOnlyForLaunch).toHaveBeenCalledWith('demo');
    expect(ports.updateConfigProjectPath).toHaveBeenCalledWith('demo', '/tmp');
    expect(ports.restorePrelaunchConfig).toHaveBeenCalledWith('demo');
    expect(ports.buildProvisioningEnv).not.toHaveBeenCalled();
  });

  it('prepares launch identity, member args, auth cleanup, and synthetic request', async () => {
    const ports = createPorts();

    const result = await prepareDeterministicLaunchSetup(request, ports);

    expect(result.kind).toBe('prepared');
    if (result.kind !== 'prepared') {
      return;
    }
    expect(result).toMatchObject({
      runId: 'run-1',
      startedAt: '2026-01-01T00:00:00.000Z',
      claudePath: '/usr/local/bin/claude',
      resolvedProviderId: 'codex',
      expectedMembers: ['Lead'],
      providerArgsForLaunch: ['--primary-provider-arg'],
      crossProviderMemberArgsForLaunch: {
        args: ['--member-provider', 'anthropic'],
        usesAnthropicApiKeyHelper: true,
      },
      mixedSecondaryLanes: [{ laneId: 'primary' }],
      syntheticRequest: {
        teamName: 'demo',
        displayName: 'Demo Team',
        color: 'blue',
        members: createMembers(),
      },
    });
    expect(result.allEffectiveMemberSpecs.map((member) => member.name)).toEqual([
      'Lead',
      'Reviewer',
    ]);
    expect(result.effectiveMemberSpecs.map((member) => member.name)).toEqual(['Lead']);
    expect(result.shellEnv).toMatchObject({
      BASE_ENV: '1',
      CODEX_TURN_SETTLED: '1',
    });
    expect(result.shellEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.shellEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(ports.buildProvisioningEnv).toHaveBeenCalledWith('codex', undefined, {
      includeCodexTeammateAuth: false,
      teamRuntimeAuth: {
        teamName: 'demo',
        authMaterialId: 'run-1',
        allowAnthropicApiKeyHelper: true,
      },
    });
    expect(ports.buildCrossProviderMemberArgs).toHaveBeenCalledWith('codex', [createMembers()[0]], {
      teamRuntimeAuth: {
        teamName: 'demo',
        authMaterialId: 'run-1',
        allowAnthropicApiKeyHelper: true,
      },
    });
    expect(ports.resolveAndValidateLaunchIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        claudePath: '/usr/local/bin/claude',
        cwd: '/tmp',
        request,
        effectiveMembers: [createMembers()[0]],
      })
    );
  });
});
