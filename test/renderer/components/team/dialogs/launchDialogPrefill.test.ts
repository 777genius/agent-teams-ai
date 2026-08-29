import {
  resolveLaunchDialogBackendState,
  resolveLaunchDialogPrefill,
  resolveRelaunchProviderBackend,
} from '@renderer/components/team/dialogs/launchDialogPrefill';
import { describe, expect, it } from 'vitest';

import type { ResolvedTeamMember, TeamCreateRequest, TeamProviderId } from '@shared/types';

function createStoredModelGetter(models: Partial<Record<TeamProviderId, string>>) {
  return (providerId: TeamProviderId): string => models[providerId] ?? '';
}

describe('resolveLaunchDialogPrefill', () => {
  it('keeps identical default and explicit backend tuples semantically distinct', () => {
    const resolve = (authoritativeBackendIsDefault: boolean) =>
      resolveLaunchDialogBackendState({
        selectedProviderId: 'codex',
        hasAuthoritativeLaunchRecord: true,
        authoritativeProviderId: 'codex',
        authoritativeBackendId: 'api',
        authoritativeBackendIsDefault,
        runtimeFallbackBackendId: 'codex-native',
      });

    expect(resolve(true)).toEqual({
      providerBackendId: 'codex-native',
      authoritativeUnavailable: false,
    });
    expect(resolve(false)).toEqual({
      providerBackendId: 'api',
      authoritativeUnavailable: false,
    });
  });

  it('does not synthesize a missing current backend from live runtime status', () => {
    expect(
      resolveRelaunchProviderBackend({
        selectedProviderId: 'codex',
        hasAuthoritativeLaunchRecord: true,
        authoritativeProviderId: 'codex',
        authoritativeBackendId: null,
        fallbackBackendId: 'codex-native',
      })
    ).toBeUndefined();
  });

  it.each(['anthropic', 'codex', 'opencode'] as const)(
    'drops stale default runtime values for %s prefill',
    (providerId) => {
      const result = resolveLaunchDialogPrefill({
        members: [],
        savedRequest: {
          teamName: 'default-prefill',
          cwd: '/safe-test-project',
          providerId,
          providerBackendId:
            providerId === 'codex' ? 'api' : providerId === 'opencode' ? 'adapter' : undefined,
          model: 'stale-model',
          effort: 'high',
          leadRuntimeSelectionProvenance: {
            version: 1,
            providerBackendId: 'default',
            model: 'default',
            effort: 'default',
          },
          members: [],
        },
        previousLaunchParams: {
          providerId,
          model: 'older-stale-model',
          effort: 'low',
        },
        multimodelEnabled: true,
        storedProviderId: providerId,
        storedEffort: 'medium',
        storedFastMode: 'inherit',
        storedLimitContext: false,
        getStoredModel: () => 'stored-stale-model',
      });

      expect(result).toMatchObject({
        providerId,
        providerBackendId: undefined,
        providerBackendIsDefault: true,
        model: '',
        effort: '',
      });
    }
  );

  it('retains exact explicit runtime values and intent in prefill', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: {
        teamName: 'explicit-prefill',
        cwd: '/safe-test-project',
        providerId: 'opencode',
        providerBackendId: 'adapter',
        model: 'openrouter/exact-model',
        effort: 'high',
        leadRuntimeSelectionProvenance: {
          version: 1,
          providerBackendId: 'explicit',
          model: 'explicit',
          effort: 'explicit',
        },
        members: [],
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: () => 'stale-model',
    });

    expect(result).toMatchObject({
      providerId: 'opencode',
      providerBackendId: 'adapter',
      providerBackendIsDefault: false,
      model: 'openrouter/exact-model',
      effort: 'high',
    });
  });

  it('treats complete provenance-free legacy values as exact instead of silently defaulting', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: {
        teamName: 'legacy-prefill',
        cwd: '/safe-test-project',
        providerId: 'codex',
        providerBackendId: 'api',
        model: 'gpt-legacy',
        effort: 'high',
        members: [],
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: () => 'gpt-current',
    });

    expect(result).toMatchObject({
      providerBackendId: 'api',
      providerBackendIsDefault: false,
      model: 'gpt-legacy',
      effort: 'high',
    });
  });

  it('prefers the current lead fast-mode selection over a stale saved request', () => {
    const result = resolveLaunchDialogPrefill({
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          providerBackendId: 'codex-native',
          model: 'gpt-5.6',
          effort: 'high',
          selectedFastMode: 'on',
          color: 'blue',
          currentTaskId: null,
          taskCount: 0,
          status: 'active',
          lastActiveAt: null,
          messageCount: 0,
        },
      ],
      savedRequest: {
        teamName: 'team',
        displayName: 'Team',
        cwd: '/tmp/project',
        members: [],
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        fastMode: 'off',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({ codex: 'gpt-5.4' }),
    });

    expect(result.fastMode).toBe('on');
  });

  it('prefills from the current lead runtime before localStorage defaults', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
      {
        name: 'alice',
        agentType: 'reviewer',
        providerId: 'codex',
        model: 'gpt-5.4-mini',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: undefined,
      model: 'gpt-5.4',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('prefers the current lead runtime over a stale saved request', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'codex',
        model: 'gpt-5.4',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const savedRequest = {
      teamName: 'vector-room-2',
      cwd: '/Users/test/project',
      providerId: 'anthropic',
      model: 'haiku',
      effort: 'low',
      members: [],
    } as TeamCreateRequest;

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: undefined,
      model: 'gpt-5.4',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('falls back to previous launch params when the current team snapshot is unavailable', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.3-codex',
        effort: 'high',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.3-codex',
      effort: 'high',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('falls back to a saved request backend lane when no previous launch params exist', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: {
        teamName: 'vector-room-2',
        cwd: '/Users/test/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.4',
        effort: 'medium',
        members: [],
      } as TeamCreateRequest,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'codex-native',
      model: 'gpt-5.4',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('preserves authoritative current Codex backend absence', () => {
    const result = resolveLaunchDialogPrefill({
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          model: 'gpt-5.4',
          effort: 'medium',
        },
      ] as ResolvedTeamMember[],
      savedRequest: null,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'codex',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: undefined,
      model: 'gpt-5.4',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it.each(['api', 'adapter', 'auto', 'codex-native'] as const)(
    'preserves a current saved Codex %s backend for relaunch',
    (providerBackendId) => {
      const result = resolveLaunchDialogPrefill({
        members: [],
        savedRequest: {
          teamName: 'legacy-codex-team',
          cwd: '/Users/test/project',
          providerId: 'codex',
          providerBackendId,
          model: 'gpt-5.4',
          members: [],
        } as TeamCreateRequest,
        previousLaunchParams: undefined,
        multimodelEnabled: true,
        storedProviderId: 'anthropic',
        storedEffort: 'medium',
        storedFastMode: 'inherit',
        storedLimitContext: false,
        getStoredModel: createStoredModelGetter({ codex: 'gpt-5.4' }),
      });

      expect(result.providerBackendId).toBe(providerBackendId);
    }
  );

  it('prefers committed saved metadata over stale same-provider renderer params after a crash', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: {
        teamName: 'crash-recovery-team',
        cwd: '/safe-test-project',
        providerId: 'codex',
        providerBackendId: 'adapter',
        model: 'gpt-5.6-sol',
        effort: 'high',
        fastMode: 'off',
        limitContext: false,
        members: [],
      },
      previousLaunchParams: {
        providerId: 'codex',
        providerBackendId: 'api',
        model: 'gpt-5.4',
        effort: 'low',
        fastMode: 'on',
        limitContext: true,
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: true,
      getStoredModel: createStoredModelGetter({ codex: 'gpt-5.4' }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: 'adapter',
      model: 'gpt-5.6-sol',
      effort: 'high',
      fastMode: 'off',
      limitContext: false,
    });
  });

  it('prefers the current lead backend over both saved metadata and renderer params', () => {
    const result = resolveLaunchDialogPrefill({
      members: [
        {
          name: 'team-lead',
          agentType: 'team-lead',
          providerId: 'codex',
          providerBackendId: 'adapter',
          model: 'gpt-5.6-sol',
        },
      ] as ResolvedTeamMember[],
      savedRequest: {
        teamName: 'current-route-team',
        cwd: '/safe-test-project',
        providerId: 'codex',
        providerBackendId: 'api',
        members: [],
      },
      previousLaunchParams: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({ codex: 'gpt-5.4' }),
    });

    expect(result.providerBackendId).toBe('adapter');
  });

  it('does not carry a frozen Gemini model into an Anthropic fallback', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'gemini',
        model: 'gemini-2.5-flash-lite',
        effort: 'medium',
      },
    ] as ResolvedTeamMember[];

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest: null,
      previousLaunchParams: undefined,
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'haiku',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('preserves OpenCode relaunch runtime instead of collapsing it to Anthropic', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'opencode',
        model: 'openrouter/moonshotai/kimi-k2',
        effort: 'medium',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        opencode: 'openai/gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'opencode',
      providerBackendId: undefined,
      model: 'openrouter/moonshotai/kimi-k2',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('prefers per-team launch params for limitContext over stale global storage', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'anthropic',
        model: 'opus[1m][1m]',
        effort: 'high',
        limitContext: true,
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'opus',
      effort: 'high',
      fastMode: 'inherit',
      limitContext: true,
    });
  });

  it('does not carry a stale Codex backend into an Anthropic lead prefill', () => {
    const members = [
      {
        name: 'team-lead',
        agentType: 'team-lead',
        providerId: 'anthropic',
        model: 'haiku',
        effort: 'low',
      },
    ] as ResolvedTeamMember[];

    const result = resolveLaunchDialogPrefill({
      members,
      savedRequest: {
        teamName: 'signal-ops-22',
        cwd: '/Users/test/project',
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.5',
        effort: 'medium',
        members: [],
      } as TeamCreateRequest,
      previousLaunchParams: {
        providerId: 'codex',
        providerBackendId: 'codex-native',
        model: 'gpt-5.5',
        effort: 'medium',
        limitContext: false,
      },
      multimodelEnabled: true,
      storedProviderId: 'codex',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'sonnet',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'anthropic',
      providerBackendId: undefined,
      model: 'haiku',
      effort: 'low',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('preserves literal [1m] suffixes for non-anthropic providers', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        model: 'custom-model[1m]',
        effort: 'medium',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: undefined,
      model: 'custom-model[1m]',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });

  it('preserves literal [1m] suffixes for non-anthropic providers', () => {
    const result = resolveLaunchDialogPrefill({
      members: [],
      savedRequest: null,
      previousLaunchParams: {
        providerId: 'codex',
        model: 'custom-model[1m]',
        effort: 'medium',
      },
      multimodelEnabled: true,
      storedProviderId: 'anthropic',
      storedEffort: 'medium',
      storedFastMode: 'inherit',
      storedLimitContext: false,
      getStoredModel: createStoredModelGetter({
        anthropic: 'haiku',
        codex: 'gpt-5.4',
      }),
    });

    expect(result).toMatchObject({
      providerId: 'codex',
      providerBackendId: undefined,
      model: 'custom-model[1m]',
      effort: 'medium',
      fastMode: 'inherit',
      limitContext: false,
    });
  });
});
