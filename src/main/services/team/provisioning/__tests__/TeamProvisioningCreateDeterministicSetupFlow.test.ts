import { describe, expect, it, vi } from 'vitest';

import {
  type DeterministicCreateSetupFlowPorts,
  prepareDeterministicCreateSetupFlow,
} from '../TeamProvisioningCreateDeterministicSetupFlow';

import type { TeamRuntimeLanePlan } from '@features/team-runtime-lanes';
import type {
  WorkspaceTrustCoordinator,
  WorkspaceTrustFeatureFlags,
  WorkspaceTrustLaunchArgPatch,
} from '@features/workspace-trust/main';
import type { ProviderModelLaunchIdentity, TeamCreateRequest, TeamProviderId } from '@shared/types';

interface MixedLane {
  memberName: string;
}

const disabledWorkspaceTrustFlags: WorkspaceTrustFeatureFlags = {
  enabled: false,
  claudePty: false,
  codexArgs: false,
  retry: false,
  fileLock: false,
};

const enabledWorkspaceTrustFlags: WorkspaceTrustFeatureFlags = {
  enabled: true,
  claudePty: false,
  codexArgs: true,
  retry: false,
  fileLock: false,
};

function buildRequest(overrides: Partial<TeamCreateRequest> = {}): TeamCreateRequest {
  return {
    teamName: 'setup-team',
    displayName: 'Setup Team',
    description: 'Prepare deterministic setup',
    color: '#225588',
    cwd: '/repo',
    prompt: 'Build it',
    providerId: 'codex',
    providerBackendId: 'codex-native',
    model: 'gpt-5.4',
    effort: 'high',
    fastMode: 'on',
    skipPermissions: true,
    worktree: undefined,
    extraCliArgs: undefined,
    limitContext: true,
    members: [
      { name: 'Lead', role: 'Lead' },
      { name: 'Builder', role: 'Build', providerId: 'anthropic' },
      { name: 'Side', role: 'Side', providerId: 'opencode' },
    ],
    ...overrides,
  } as TeamCreateRequest;
}

function buildLanePlan(members: TeamCreateRequest['members']): TeamRuntimeLanePlan {
  const primaryMembers = members
    .filter((member) => member.name !== 'Side')
    .map((member) => ({ ...member, providerId: member.providerId ?? 'codex' }));
  const sideMember = members.find((member) => member.name === 'Side');
  return {
    mode: 'mixed_opencode_side_lanes',
    primaryMembers,
    allMembers: members.map((member) => ({ ...member, providerId: member.providerId ?? 'codex' })),
    sideLanes: sideMember
      ? [
          {
            laneId: 'opencode-side',
            providerId: 'opencode',
            member: { ...sideMember, providerId: 'opencode' },
          },
        ]
      : [],
  };
}

function buildWorkspaceTrustCollectionPorts() {
  return {
    getHomeDir: () => '/home/user',
    realpath: async (value: string) => value,
    resolveGitRoot: async () => null,
    resolveCanonicalGitRoot: async (value: string) => value,
    platform: 'posix' as const,
  };
}

function buildLaunchIdentity(): ProviderModelLaunchIdentity {
  return {
    providerId: 'codex',
    providerBackendId: 'codex-native',
    selectedModel: 'gpt-5.4',
    selectedModelKind: 'explicit',
    resolvedLaunchModel: 'gpt-5.4',
    catalogId: 'gpt-5.4',
    catalogSource: 'runtime',
    catalogFetchedAt: null,
    selectedEffort: 'high',
    resolvedEffort: 'high',
  };
}

function buildPorts(
  overrides: Partial<DeterministicCreateSetupFlowPorts<MixedLane>> = {}
): DeterministicCreateSetupFlowPorts<MixedLane> {
  return {
    pathExists: vi.fn(async () => false),
    resolveClaudePath: vi.fn(async () => '/usr/local/bin/claude'),
    buildMissingCliError: () => new Error('missing cli'),
    buildProvisioningEnv: vi.fn(async () => ({
      env: {
        BASE_ENV: '1',
        ANTHROPIC_API_KEY: 'lead-key',
        ANTHROPIC_AUTH_TOKEN: 'lead-token',
      },
      authSource: 'codex_runtime' as const,
      geminiRuntimeAuth: null,
      providerArgs: ['--provider-base'],
      anthropicApiKeyHelper: { directory: '/repo/.agent-teams/helpers/anthropic' } as never,
    })),
    materializeEffectiveTeamMemberSpecs: vi.fn(async (params) => params.members),
    resolveOpenCodeMemberWorkspacesForRuntime: vi.fn(async (params) => params.members),
    planRuntimeLanesOrThrow: vi.fn((_leadProviderId, members) => buildLanePlan(members)),
    buildCrossProviderMemberArgs: vi.fn(async () => ({
      args: ['--cross-provider'],
      providerArgsByProvider: new Map<TeamProviderId, string[]>([
        ['anthropic', ['--anthropic-member']],
      ]),
      envPatch: {
        ANTHROPIC_API_KEY: 'helper-key',
        ANTHROPIC_AUTH_TOKEN: 'helper-token',
        MEMBER_SYNC: '1',
      },
      usesAnthropicApiKeyHelper: true,
    })),
    resolveAndValidateLaunchIdentity: vi.fn(async () => buildLaunchIdentity()),
    createMixedSecondaryLaneStates: vi.fn((plan) =>
      plan.sideLanes.map((lane: TeamRuntimeLanePlan['sideLanes'][number]) => ({
        memberName: lane.member.name,
      }))
    ),
    workspaceTrustCoordinator: null,
    workspaceTrustWorkspaceCollectionPorts: buildWorkspaceTrustCollectionPorts(),
    runtimeTurnSettledEnvironmentProvider: vi.fn(async () => ({ CODEX_TURN_SETTLED: '1' })),
    logger: { warn: vi.fn() },
    getTeamsBasePathsToProbe: () => [{ location: 'configured', basePath: '/teams' }],
    ensureCwdExists: vi.fn(async () => undefined),
    resolveWorkspaceTrustFeatureFlags: () => disabledWorkspaceTrustFlags,
    ...overrides,
  };
}

function workspaceTrustPatch(
  targetSurface: WorkspaceTrustLaunchArgPatch['targetSurface'],
  configKey: string
): WorkspaceTrustLaunchArgPatch {
  return {
    id: `patch-${targetSurface}`,
    owner: 'workspace-trust',
    targetProvider: 'codex',
    targetSurface,
    dialect: 'claude-codex-runtime-settings',
    args: [
      '--settings',
      JSON.stringify({
        codex: {
          agent_teams_workspace_trust: {
            config_overrides: [`projects."${configKey}".trust_level="trusted"`],
          },
        },
      }),
    ],
    dedupeKey: targetSurface,
    sourceWorkspaceIds: ['workspace-1'],
    reason: 'test',
  };
}

describe('TeamProvisioningCreateDeterministicSetupFlow', () => {
  it('prepares deterministic create setup and keeps service-owned ports at the boundary', async () => {
    const request = buildRequest();
    const ports = buildPorts();

    const result = await prepareDeterministicCreateSetupFlow({
      request,
      runtimeAuthMaterialId: 'auth-material-1',
      ports,
    });

    expect(ports.pathExists).toHaveBeenCalledWith('/teams/setup-team/config.json');
    expect(ports.buildProvisioningEnv).toHaveBeenCalledWith('codex', 'codex-native', {
      includeCodexTeammateAuth: true,
      teamRuntimeAuth: {
        teamName: 'setup-team',
        authMaterialId: 'auth-material-1',
        allowAnthropicApiKeyHelper: true,
      },
    });
    expect(ports.materializeEffectiveTeamMemberSpecs).toHaveBeenCalledWith(
      expect.objectContaining({
        claudePath: '/usr/local/bin/claude',
        cwd: '/repo',
        defaults: { providerId: 'codex', model: 'gpt-5.4', effort: 'high' },
        limitContext: true,
      })
    );
    expect(ports.buildCrossProviderMemberArgs).toHaveBeenCalledWith(
      'codex',
      [
        { name: 'Lead', role: 'Lead' },
        { name: 'Builder', role: 'Build', providerId: 'anthropic' },
      ],
      {
        teamRuntimeAuth: {
          teamName: 'setup-team',
          authMaterialId: 'auth-material-1',
          allowAnthropicApiKeyHelper: true,
        },
      }
    );
    expect(ports.resolveAndValidateLaunchIdentity).toHaveBeenCalledWith(
      expect.objectContaining({
        claudePath: '/usr/local/bin/claude',
        cwd: '/repo',
        effectiveMembers: [
          { name: 'Lead', role: 'Lead' },
          { name: 'Builder', role: 'Build', providerId: 'anthropic' },
        ],
      })
    );
    expect(result.effectiveMemberSpecs.map((member) => member.name)).toEqual(['Lead', 'Builder']);
    expect(result.allEffectiveMemberSpecs.map((member) => member.name)).toEqual([
      'Lead',
      'Builder',
      'Side',
    ]);
    expect(result.mixedSecondaryLanes).toEqual([{ memberName: 'Side' }]);
    expect(result.providerArgsForLaunch).toEqual(['--provider-base']);
    expect(result.inheritedProviderArgsForLaunch).toEqual(['--cross-provider']);
    expect(result.shellEnv).toMatchObject({ BASE_ENV: '1', MEMBER_SYNC: '1' });
    expect(result.shellEnv.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.shellEnv.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(result.geminiRuntimeAuth).toBeNull();
    expect(result.workspaceTrustFullPlan).toBeNull();
  });

  it('feeds workspace trust launch args into default-model and launch planning', async () => {
    const request = buildRequest();
    const materializeEffectiveTeamMemberSpecs = vi.fn(async (params) => {
      const resolvedArgs = params.providerArgsResolver?.({
        providerId: 'codex',
        providerArgs: [],
        phase: 'default-model-resolution',
      });
      expect(resolvedArgs?.[0]).toBe('--settings');
      expect(JSON.parse(resolvedArgs?.[1] ?? '{}')).toEqual({
        codex: {
          agent_teams_workspace_trust: {
            config_overrides: ['projects."default-model".trust_level="trusted"'],
          },
        },
      });
      return params.members;
    });
    const coordinator: WorkspaceTrustCoordinator = {
      planArgsOnly: vi.fn(async () => ({
        launchArgPatches: [workspaceTrustPatch('default_model_probe', 'default-model')],
      })),
      planFull: vi.fn(async (planRequest) => ({
        providers: planRequest.providers,
        workspaces: planRequest.workspaces,
        launchArgPatches: [workspaceTrustPatch('primary_provider_args', 'primary-launch')],
      })),
      execute: vi.fn(async () => ({
        status: 'ok',
        strategies: [],
        diagnostics: [],
      })) as never,
    };
    const ports = buildPorts({
      workspaceTrustCoordinator: coordinator,
      materializeEffectiveTeamMemberSpecs,
      resolveWorkspaceTrustFeatureFlags: () => enabledWorkspaceTrustFlags,
    });

    const result = await prepareDeterministicCreateSetupFlow({
      request,
      runtimeAuthMaterialId: 'auth-material-2',
      ports,
    });

    expect(coordinator.planArgsOnly).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ['claude', 'codex', 'opencode'],
        targetSurfaces: ['default_model_probe'],
        featureFlags: enabledWorkspaceTrustFlags,
      })
    );
    expect(coordinator.planFull).toHaveBeenCalledWith(
      expect.objectContaining({
        providers: ['claude', 'codex', 'opencode'],
        featureFlags: enabledWorkspaceTrustFlags,
      })
    );
    expect(result.workspaceTrustFullPlan?.launchArgPatches).toHaveLength(1);
    expect(result.providerArgsForLaunch.slice(0, 2)).toEqual(['--provider-base', '--settings']);
    expect(JSON.parse(result.providerArgsForLaunch[2] ?? '{}')).toEqual({
      codex: {
        agent_teams_workspace_trust: {
          config_overrides: ['projects."primary-launch".trust_level="trusted"'],
        },
      },
    });
  });

  it('throws provisioning environment warnings before planning launch identity', async () => {
    const request = buildRequest();
    const resolveAndValidateLaunchIdentity = vi.fn();
    const ports = buildPorts({
      buildProvisioningEnv: vi.fn(async () => ({
        env: {},
        authSource: 'none' as const,
        geminiRuntimeAuth: null,
        warning: 'Provider auth failed',
      })),
      resolveAndValidateLaunchIdentity,
    });

    await expect(
      prepareDeterministicCreateSetupFlow({
        request,
        runtimeAuthMaterialId: 'auth-material-3',
        ports,
      })
    ).rejects.toThrow('Provider auth failed');
    expect(resolveAndValidateLaunchIdentity).not.toHaveBeenCalled();
  });
});
