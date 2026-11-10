import { describe, expect, it, vi } from 'vitest';

import { buildDirectTmuxRestartEnvAssignments, shellQuote } from '../TeamProvisioningDirectRestart';
import {
  abortUnspawnedGatewayMembers,
  applyDirectGatewayArgs,
  assertMemberGatewaySpawnCompatibility,
  beginGatewayMemberLaunches,
  buildMemberCodexCliArgs,
  cleanupUnspawnedGatewayLaunch,
  getRuntimeCatalogMembers,
  type MemberGatewayRuntimeSeams,
  MemberGatewaySpawnCompatibilityError,
  resolveGatewayMemberLaunchIdentity,
  resolveMemberGatewayRuntimeArgs,
  resolveOpenCodeGatewayMemberModels,
} from '../TeamProvisioningMemberGatewayRuntime';

import type { ResolvedMemberGatewayConnection } from '@features/gateway-provider/main';

function connection(
  overrides: Partial<ResolvedMemberGatewayConnection> = {}
): ResolvedMemberGatewayConnection {
  return {
    spec: {
      profileId: 'profile-1',
      baseUrl: 'https://gw.example.com',
      allowPrivateNetwork: false,
      credentialRef: 'credential-1',
    },
    apiKey: 'sk-member',
    gatewayUsageRef: 'usage-ref-1',
    teamName: 'team-a',
    memberName: 'builder',
    ...overrides,
  };
}

function seamsWithConnection(
  resolved: ResolvedMemberGatewayConnection | null
): MemberGatewayRuntimeSeams {
  return {
    resolveMemberConnection: vi.fn(async () => resolved),
    configureOpenCodeLocalProvider: vi.fn(async () => ({
      providerId: 'gateway-team-a-builder-0123456789ab',
      modelRoute: 'gateway-team-a-builder-0123456789ab/gpt-5',
    })),
    retireOpenCodeLocalProvider: vi.fn(async () => ({ retired: true })),
    markRuntimeArtifactActive: vi.fn(async () => undefined),
    markRuntimeArtifactRetired: vi.fn(async () => undefined),
  };
}

describe('resolveMemberGatewayRuntimeArgs', () => {
  it('builds the narrow Claude patch and snapshots gatewayUsageRef', async () => {
    const seams = seamsWithConnection(connection());
    const args = await resolveMemberGatewayRuntimeArgs({
      seams,
      teamName: 'team-a',
      memberName: 'builder',
      providerId: 'anthropic',
    });
    expect(args).not.toBeNull();
    expect(args!.gatewayUsageRef).toBe('usage-ref-1');
    expect(args!.envPatch).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
    });
    expect(args!.configOverrides).toBeUndefined();
  });

  it('builds Codex per-member overrides with the custom provider and api login', async () => {
    const seams = seamsWithConnection(connection({ spec: { ...connection().spec } }));
    const args = await resolveMemberGatewayRuntimeArgs({
      seams,
      teamName: 'team-a',
      memberName: 'builder',
      providerId: 'codex',
    });
    expect(args!.envPatch).toEqual({ CODEX_API_KEY: 'sk-member' });
    expect(args!.codexForcedLoginMethod).toBe('api');
    expect(args!.configOverrides).toContain('model_provider="agent_teams_custom"');
    expect(args!.configOverrides).toContain(
      'model_providers.agent_teams_custom.wire_api="responses"'
    );
    expect(args!.gatewayUsageRef).toBe('usage-ref-1');
  });

  it('returns null without a binding or without seams', async () => {
    expect(
      await resolveMemberGatewayRuntimeArgs({
        seams: seamsWithConnection(null),
        teamName: 'team-a',
        memberName: 'builder',
        providerId: 'anthropic',
      })
    ).toBeNull();
    expect(
      await resolveMemberGatewayRuntimeArgs({
        seams: null,
        teamName: 'team-a',
        memberName: 'builder',
        providerId: 'anthropic',
      })
    ).toBeNull();
  });
});

describe('gateway launch ownership', () => {
  it.each(['anthropic', 'codex'] as const)(
    'persists an unbound %s boundary without changing global credentials',
    async (providerId) => {
      const seams = seamsWithConnection(null);
      seams.snapshotLaunch = vi.fn(async () => 'ordinary-attempt');
      const env = { ANTHROPIC_AUTH_TOKEN: 'default-token', CODEX_API_KEY: 'default-codex' };
      const args = await applyDirectGatewayArgs(
        { getMemberGatewayRuntimeSeams: () => seams },
        { teamName: 'team-a', configuredMember: { name: 'builder' } },
        { providerId, model: 'default-model' },
        env
      );
      expect(args).toMatchObject({ envPatch: {}, codexArgs: [] });
      expect(args?.gatewayUsageRef).toBeUndefined();
      expect(seams.snapshotLaunch).not.toHaveBeenCalled();
      await args?.beginLaunch?.();
      await args?.beginLaunch?.();
      expect(seams.snapshotLaunch).toHaveBeenCalledExactlyOnceWith({
        teamName: 'team-a',
        memberName: 'builder',
        providerId,
        gatewayUsageRef: undefined,
      });
      expect(env).toEqual({
        ANTHROPIC_AUTH_TOKEN: 'default-token',
        CODEX_API_KEY: 'default-codex',
      });
    }
  );

  it('creates no run at prepare and aborts only its exact snapshot after a failed spawn', async () => {
    const seams = seamsWithConnection(connection());
    seams.snapshotLaunch = vi.fn(async () => 'attempt-token');
    seams.abortUnspawnedLaunch = vi.fn(async () => undefined);
    const prepared = await resolveMemberGatewayRuntimeArgs({
      seams,
      teamName: 'team-a',
      memberName: 'builder',
      providerId: 'anthropic',
    });
    expect(seams.snapshotLaunch).not.toHaveBeenCalled();
    const members = new Map([['builder', prepared!]]);
    await beginGatewayMemberLaunches(members);
    expect(seams.snapshotLaunch).toHaveBeenCalledOnce();
    await abortUnspawnedGatewayMembers(members);
    expect(seams.abortUnspawnedLaunch).toHaveBeenCalledExactlyOnceWith('attempt-token');
  });
});

describe('buildMemberCodexCliArgs', () => {
  it('emits the per-member overrides in the claude-bridge --settings form', async () => {
    const args = await resolveMemberGatewayRuntimeArgs({
      seams: seamsWithConnection(connection()),
      teamName: 'team-a',
      memberName: 'builder',
      providerId: 'codex',
    });
    const cliArgs = buildMemberCodexCliArgs(args!);
    expect(cliArgs[0]).toBe('--settings');
    const settings = JSON.parse(cliArgs[1]) as { codex: Record<string, unknown> };
    expect(settings.codex.forced_login_method).toBe('api');
    expect(settings.codex.agent_teams_custom_provider).toEqual({
      config_overrides: args!.configOverrides,
    });
  });

  it('emits nothing for members without Codex overrides', () => {
    expect(
      buildMemberCodexCliArgs({ envPatch: { ANTHROPIC_API_KEY: '' }, gatewayUsageRef: 'ref' })
    ).toEqual([]);
  });
});

describe('applyDirectGatewayArgs env ordering', () => {
  it('wins over inherited auth and blanks the competing ANTHROPIC_API_KEY', async () => {
    const env: NodeJS.ProcessEnv = {
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'subscription',
      ANTHROPIC_API_KEY: 'lead-key',
      ANTHROPIC_AUTH_TOKEN: 'lead-token',
      CLAUDE_CODE_BOOTSTRAP_RUN_ID: 'run-1',
    };
    const result = await applyDirectGatewayArgs(
      { getMemberGatewayRuntimeSeams: () => seamsWithConnection(connection()) },
      { teamName: 'team-a', configuredMember: { name: 'builder' } },
      { providerId: 'anthropic', model: 'claude-sonnet' },
      env
    );
    expect(result).not.toBeNull();
    expect(env.ANTHROPIC_BASE_URL).toBe('https://gw.example.com');
    expect(env.ANTHROPIC_AUTH_TOKEN).toBe('sk-member');
    expect(env.ANTHROPIC_API_KEY).toBe('');
    expect(env.AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE).toBe('compatible');
    expect(env.CLAUDE_CODE_BOOTSTRAP_RUN_ID).toBe('run-1');
    expect(result!.envPatch).toEqual({
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
    });
    expect(result!.codexArgs).toEqual([]);
    expect(result!.gatewayUsageRef).toBe('usage-ref-1');
  });

  it('keeps the patch final over tmux inherited-auth connection policy', () => {
    const env: NodeJS.ProcessEnv = {
      // Explicit api_key mode would otherwise blank the member token.
      AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'api_key',
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
      CLAUDE_CODE_BOOTSTRAP_RUN_ID: 'run-1',
    };
    const finalEnvPatch = {
      ANTHROPIC_BASE_URL: 'https://gw.example.com',
      ANTHROPIC_AUTH_TOKEN: 'sk-member',
      ANTHROPIC_API_KEY: '',
    };

    const withoutPatch = buildDirectTmuxRestartEnvAssignments(env, 'anthropic');
    expect(withoutPatch).toContain('ANTHROPIC_AUTH_TOKEN=' + shellQuote(''));
    expect(withoutPatch).not.toContain(`ANTHROPIC_AUTH_TOKEN=${shellQuote('sk-member')}`);

    const withPatch = buildDirectTmuxRestartEnvAssignments(env, 'anthropic', finalEnvPatch);
    expect(withPatch).toContain(`ANTHROPIC_BASE_URL=${shellQuote('https://gw.example.com')}`);
    expect(withPatch).toContain(`ANTHROPIC_AUTH_TOKEN=${shellQuote('sk-member')}`);
    expect(withPatch).toContain(`ANTHROPIC_API_KEY=${shellQuote('')}`);
    expect(withPatch).not.toContain('-u ' + shellQuote('ANTHROPIC_AUTH_TOKEN'));
  });
});

describe('assertMemberGatewaySpawnCompatibility', () => {
  const boundMemberArgs = new Map([['builder', { envPatch: {}, gatewayUsageRef: 'usage-ref-1' }]]);

  it('requires a separate-process spawn for gateway-bound teammates', () => {
    expect(() =>
      assertMemberGatewaySpawnCompatibility({
        memberArgsByMember: boundMemberArgs,
        usesAnthropicApiKeyHelper: false,
        teammateModeIsInProcess: true,
      })
    ).toThrow(MemberGatewaySpawnCompatibilityError);
  });

  it('rejects the Anthropic API key helper alongside gateway bindings', () => {
    expect(() =>
      assertMemberGatewaySpawnCompatibility({
        memberArgsByMember: boundMemberArgs,
        usesAnthropicApiKeyHelper: true,
        teammateModeIsInProcess: false,
      })
    ).toThrow(MemberGatewaySpawnCompatibilityError);
  });

  it('allows unbound teams and separate-process spawns', () => {
    expect(() =>
      assertMemberGatewaySpawnCompatibility({
        memberArgsByMember: new Map(),
        usesAnthropicApiKeyHelper: true,
        teammateModeIsInProcess: true,
      })
    ).not.toThrow();
    expect(() =>
      assertMemberGatewaySpawnCompatibility({
        memberArgsByMember: boundMemberArgs,
        usesAnthropicApiKeyHelper: false,
        teammateModeIsInProcess: false,
      })
    ).not.toThrow();
  });
});

describe('app-owned OpenCode gateway members', () => {
  it('configures only bound OpenCode teammates and carries their route into primary/secondary launch members', async () => {
    const resolved = connection({ spec: { ...connection().spec, model: 'gpt-5' } });
    const seams = seamsWithConnection(resolved);
    const snapshots: string[] = [];
    seams.snapshotLaunch = async (input) => {
      snapshots.push(input.gatewayUsageRef ?? 'unbound');
    };
    const members = await resolveOpenCodeGatewayMemberModels({
      teamName: 'team-a',
      leadProviderId: 'opencode',
      seams,
      members: [
        { name: 'team-lead', providerId: 'opencode', model: 'lead/default' },
        {
          name: 'builder',
          providerId: 'opencode',
          model: 'gateway-team-a-builder-0123456789ab/gpt-5',
        },
        { name: 'other', providerId: 'anthropic', model: 'claude-sonnet' },
      ],
    });
    expect(members.map((member) => member.model)).toEqual([
      'lead/default',
      'gateway-team-a-builder-0123456789ab/gpt-5',
      'claude-sonnet',
    ]);
    expect(seams.resolveMemberConnection).toHaveBeenCalledExactlyOnceWith(
      'team-a',
      'builder',
      'gpt-5'
    );
    expect(seams.configureOpenCodeLocalProvider).toHaveBeenCalledWith(
      expect.objectContaining({
        setAsDefault: false,
        setAsSmallModel: false,
        apiKey: 'sk-member',
      }),
      { teamName: 'team-a', memberName: 'builder', gatewayUsageRef: 'usage-ref-1' }
    );
    expect(seams.markRuntimeArtifactActive).toHaveBeenCalledWith('usage-ref-1');
    expect(snapshots).toEqual([]);
  });
});

describe('gateway model authority', () => {
  it('excludes only members with resolved gateway credentials from the global catalog', () => {
    const members = [
      { name: 'gateway', model: 'private-model' },
      { name: 'ordinary', model: 'unknown-global-model' },
      { name: 'unresolved', model: 'another-model' },
    ];
    expect(
      getRuntimeCatalogMembers(
        members,
        new Map([
          ['gateway', { envPatch: {}, gatewayUsageRef: 'resolved-exact-key' }],
          ['unresolved', { envPatch: {} }],
        ])
      )
    ).toEqual(members.slice(1));
    expect(getRuntimeCatalogMembers(members, undefined)).toEqual(members);
  });

  it('retains an exact custom Codex model and API billing for a direct restart', async () => {
    const seams = seamsWithConnection(
      connection({
        spec: { ...connection().spec, model: 'gateway-only-model' },
      })
    );
    const identity = await resolveGatewayMemberLaunchIdentity({
      seams,
      teamName: 'team-a',
      providerId: 'codex',
      memberSpec: { name: 'builder', model: 'gateway-only-model', effort: 'high' },
    });
    expect(identity).toMatchObject({
      providerBackendId: 'codex-native',
      billingMode: 'api',
      selectedModel: 'gateway-only-model',
      resolvedLaunchModel: 'gateway-only-model',
      selectedEffort: 'high',
      resolvedEffort: 'high',
    });
    expect(seams.resolveMemberConnection).toHaveBeenCalledExactlyOnceWith(
      'team-a',
      'builder',
      'gateway-only-model'
    );
    expect(seams.configureOpenCodeLocalProvider).not.toHaveBeenCalled();
    expect(seams.markRuntimeArtifactActive).not.toHaveBeenCalled();
  });

  it('keeps unbound members on normal validation and fails closed for edited credentials', async () => {
    const input = {
      seams: seamsWithConnection(null),
      teamName: 'team-a',
      providerId: 'codex' as const,
      memberSpec: { name: 'builder', model: 'gateway-only-model' },
    };
    expect(await resolveGatewayMemberLaunchIdentity(input)).toBeNull();
    input.seams.resolveMemberConnection = vi.fn(async () => {
      throw new Error('credential_changed');
    });
    await expect(resolveGatewayMemberLaunchIdentity(input)).rejects.toThrow('credential_changed');
  });
});

it('rejects a bound unsupported runtime instead of falling back to its global credentials', async () => {
  const seams = seamsWithConnection(connection({ spec: { ...connection().spec, model: 'model' } }));
  await expect(
    resolveMemberGatewayRuntimeArgs({
      seams,
      teamName: 'team-a',
      memberName: 'builder',
      providerId: 'gemini',
      model: 'model',
    })
  ).rejects.toThrow('Claude, Codex and OpenCode');
  await expect(
    resolveGatewayMemberLaunchIdentity({
      seams,
      teamName: 'team-a',
      providerId: 'gemini',
      memberSpec: { name: 'builder', model: 'model' },
    })
  ).rejects.toThrow('Claude, Codex and OpenCode');
});

describe('unspawned launch rollback', () => {
  it('closes captured streams and retains the original spawn failure if rollback also fails', async () => {
    const abortUnspawnedLaunch = vi.fn().mockRejectedValue(new Error('cleanup unavailable'));
    const stream = { destroy: vi.fn() };
    const failure = new Error('sendKeys failed');
    const launch = async () => {
      try {
        throw failure;
      } catch (error) {
        await cleanupUnspawnedGatewayLaunch({ abortUnspawnedLaunch }, [stream]);
        throw error;
      }
    };
    await expect(launch()).rejects.toBe(failure);
    expect(console.warn).toHaveBeenCalledWith(
      '[GatewayMemberLaunch]',
      expect.stringContaining('cleanup unavailable')
    );
    vi.mocked(console.warn).mockClear();
    expect(stream.destroy).toHaveBeenCalledOnce();
    expect(abortUnspawnedLaunch).toHaveBeenCalledOnce();
  });
  it('does not close an active snapshot after tmux accepted the command', async () => {
    const abortUnspawnedLaunch = vi.fn();
    await cleanupUnspawnedGatewayLaunch({ abortUnspawnedLaunch }, [], true);
    expect(abortUnspawnedLaunch).not.toHaveBeenCalled();
  });
});
