import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningEnvRuntimePorts,
  resolveControlApiBaseUrlForProvisioning,
} from '../TeamProvisioningEnvRuntimePorts';

import type {
  RuntimeTurnSettledEnvironmentProvider,
  RuntimeTurnSettledHookSettingsProvider,
} from '../TeamProvisioningRuntimeTurnSettledPlanning';

function createDeps(
  overrides: Partial<Parameters<typeof createTeamProvisioningEnvRuntimePorts>[0]> = {}
): Parameters<typeof createTeamProvisioningEnvRuntimePorts>[0] {
  return {
    providerConnectionService: {
      augmentConfiguredConnectionEnv: vi.fn(async (env) => env),
      getConfiguredAnthropicApiKeyForTeamRuntime: vi.fn(async () => null),
    },
    getControlApiBaseUrlResolver: vi.fn(() => null),
    getRuntimeTurnSettledEnvironmentProvider: vi.fn(() => null),
    getRuntimeTurnSettledHookSettingsProvider: vi.fn(() => null),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    processEnv: {},
    ...overrides,
  };
}

describe('TeamProvisioningEnvRuntimePorts', () => {
  it('publishes resolved control API base URL through injectable process env', async () => {
    const processEnv = {};
    const logger = { warn: vi.fn(), error: vi.fn() };

    const result = await resolveControlApiBaseUrlForProvisioning({
      getControlApiBaseUrlResolver: () => vi.fn(async () => 'http://127.0.0.1:4567'),
      logger,
      processEnv,
    });

    expect(result).toBe('http://127.0.0.1:4567');
    expect(processEnv).toEqual({ CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:4567' });
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('normalizes missing control API base URL into runtime launch error', async () => {
    const logger = { warn: vi.fn(), error: vi.fn() };

    await expect(
      resolveControlApiBaseUrlForProvisioning({
        getControlApiBaseUrlResolver: () => vi.fn(async () => null),
        logger,
        processEnv: {},
      })
    ).rejects.toThrow(
      'Team control API failed to start or publish its base URL. Team runtime commands require the desktop Control API. Team control API resolver returned no base URL after startup.'
    );
    expect(logger.error).toHaveBeenCalledWith(
      'Failed to resolve team control API base URL: Team control API resolver returned no base URL after startup.'
    );
  });

  it('builds env builder ports from current runtime provider getters', async () => {
    let environmentProvider: RuntimeTurnSettledEnvironmentProvider | null = vi.fn(async () => ({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/spool/first',
    }));
    const deps = createDeps({
      getRuntimeTurnSettledEnvironmentProvider: vi.fn(() => environmentProvider),
    });
    const runtimePorts = createTeamProvisioningEnvRuntimePorts(deps);
    const builderPorts = runtimePorts.getProvisioningEnvBuilderPorts();

    await expect(builderPorts.buildRuntimeTurnSettledEnvironment('codex')).resolves.toEqual({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/spool/first',
    });

    environmentProvider = vi.fn(async () => ({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/spool/second',
    }));

    await expect(builderPorts.buildRuntimeTurnSettledEnvironment('codex')).resolves.toEqual({
      AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/spool/second',
    });
  });

  it('builds cross-provider args through current hook settings provider getter', async () => {
    let hookSettingsProvider: RuntimeTurnSettledHookSettingsProvider | null = vi.fn(async () => ({
      hooks: { Stop: [{ matcher: '', hooks: [] }] },
    }));
    const deps = createDeps({
      getRuntimeTurnSettledHookSettingsProvider: vi.fn(() => hookSettingsProvider),
    });
    const runtimePorts = createTeamProvisioningEnvRuntimePorts(deps);
    runtimePorts.buildProvisioningEnv = vi.fn(async () => ({
      env: {},
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
    }));

    const result = await runtimePorts.buildCrossProviderMemberArgs(
      'codex',
      [{ name: 'Claude', providerId: 'anthropic', role: 'reviewer' }],
      undefined
    );

    expect(result.args).toEqual([
      '--settings',
      JSON.stringify({ hooks: { Stop: [{ matcher: '', hooks: [] }] } }),
    ]);

    hookSettingsProvider = null;

    const withoutHookSettings = await runtimePorts.buildCrossProviderMemberArgs(
      'codex',
      [{ name: 'Claude', providerId: 'anthropic', role: 'reviewer' }],
      undefined
    );
    expect(withoutHookSettings.args).toEqual([]);
  });
});
