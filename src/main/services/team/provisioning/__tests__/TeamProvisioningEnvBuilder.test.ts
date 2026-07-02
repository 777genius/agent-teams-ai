/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { describe, expect, it, vi } from 'vitest';

import {
  buildCrossProviderMemberArgs,
  buildProvisioningEnv,
  type TeamProvisioningEnvBuilderPorts,
} from '../TeamProvisioningEnvBuilder';

import type {
  ProviderAwareCliEnvOptions,
  ProviderAwareCliEnvResult,
} from '@main/services/runtime/providerAwareCliEnv';

function createPorts(
  overrides: Partial<TeamProvisioningEnvBuilderPorts> = {}
): TeamProvisioningEnvBuilderPorts {
  const processEnv = overrides.processEnv ?? {
    PATH: '/usr/bin',
    SHELL: '/bin/bash',
    USER: 'process-user',
  };
  const buildProviderAwareCliEnv = vi.fn(
    async (options: ProviderAwareCliEnvOptions = {}): Promise<ProviderAwareCliEnvResult> => ({
      env: options.env ?? {},
      connectionIssues: {},
      providerArgs: ['--provider-arg'],
    })
  );

  return {
    providerConnectionService: {
      augmentConfiguredConnectionEnv: vi.fn(async (env) => env),
      getConfiguredAnthropicApiKeyForTeamRuntime: vi.fn(async () => null),
    },
    buildRuntimeTurnSettledEnvironment: vi.fn(async () => ({})),
    resolveControlApiBaseUrl: vi.fn(async () => null),
    logger: {
      warn: vi.fn(),
      error: vi.fn(),
    },
    processEnv,
    platform: 'darwin',
    resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({
      PATH: '/usr/bin',
      SHELL: '/bin/zsh',
    })),
    getHomeDir: vi.fn(() => '/home/tester'),
    getClaudeBasePath: vi.fn(() => '/home/tester/.claude'),
    getAutoDetectedClaudeBasePath: vi.fn(() => '/home/tester/.claude'),
    getOsUsername: vi.fn(() => 'os-user'),
    buildProviderAwareCliEnv,
    prepareAgentChildProcessWritableEnv: vi.fn(async () => ({ applied: false })),
    ...overrides,
  };
}

describe('TeamProvisioningEnvBuilder', () => {
  it('returns codex runtime auth source for Codex provider env', async () => {
    const ports = createPorts({
      buildRuntimeTurnSettledEnvironment: vi.fn(async () => ({
        AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT: '/tmp/runtime-hooks',
      })),
      resolveControlApiBaseUrl: vi.fn(async () => 'http://control.test'),
    });

    const result = await buildProvisioningEnv({ providerId: 'codex', ports });

    expect(result.authSource).toBe('codex_runtime');
    expect(result.geminiRuntimeAuth).toBeNull();
    expect(result.providerArgs).toEqual(['--provider-arg']);
    expect(result.env.AGENT_TEAMS_RUNTIME_TURN_SETTLED_SPOOL_ROOT).toBe('/tmp/runtime-hooks');
    expect(result.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://control.test');
  });

  it('short-circuits auth decision with configured provider warnings', async () => {
    const ports = createPorts({
      buildProviderAwareCliEnv: vi.fn(
        async (options: ProviderAwareCliEnvOptions = {}): Promise<ProviderAwareCliEnvResult> => ({
          env: options.env ?? {},
          connectionIssues: {
            codex: 'Codex CLI login status is not active',
          },
          providerArgs: ['--codex-runtime'],
        })
      ),
    });

    const result = await buildProvisioningEnv({ providerId: 'codex', ports });

    expect(result.authSource).toBe('configured_api_key_missing');
    expect(result.warning).toBe('Codex CLI login status is not active');
    expect(result.providerArgs).toEqual(['--codex-runtime']);
  });

  it('copies ANTHROPIC_AUTH_TOKEN into ANTHROPIC_API_KEY for headless Anthropic auth', async () => {
    const ports = createPorts({
      resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({
        ANTHROPIC_AUTH_TOKEN: 'proxy-token',
        PATH: '/usr/bin',
        SHELL: '/bin/zsh',
      })),
    });

    const result = await buildProvisioningEnv({ providerId: 'anthropic', ports });

    expect(result.authSource).toBe('anthropic_auth_token');
    expect(result.env.ANTHROPIC_API_KEY).toBe('proxy-token');
    expect(result.env.ANTHROPIC_AUTH_TOKEN).toBe('proxy-token');
  });

  it('sets non-Windows SHELL and XDG directories from injected environment inputs', async () => {
    const ports = createPorts({
      platform: 'linux',
      processEnv: {
        PATH: '/usr/bin',
        SHELL: '/bin/bash',
        USER: 'process-user',
        XDG_CONFIG_HOME: '/process/config',
        XDG_STATE_HOME: '/process/state',
      },
      resolveInteractiveShellEnvBestEffort: vi.fn(async () => ({
        HOME: ' /home/shell-user ',
        PATH: '/usr/bin',
        SHELL: ' /bin/fish ',
        XDG_CONFIG_HOME: ' /shell/config ',
        XDG_STATE_HOME: ' /shell/state ',
      })),
    });

    const result = await buildProvisioningEnv({ providerId: 'anthropic', ports });

    expect(result.env.HOME).toBe('/home/shell-user');
    expect(result.env.USERPROFILE).toBe('/home/shell-user');
    expect(result.env.SHELL).toBe('/bin/fish');
    expect(result.env.XDG_CONFIG_HOME).toBe('/shell/config');
    expect(result.env.XDG_STATE_HOME).toBe('/shell/state');
  });

  it('builds cross-provider runtime args and safe Codex env patch', async () => {
    const buildProvisioningEnvForMember = vi.fn(async () => ({
      env: {
        CODEX_HOME: '/tmp/codex-home',
        CODEX_CLI_PATH: '/usr/local/bin/codex',
        CLAUDE_CODE_CODEX_BACKEND: 'api',
        ANTHROPIC_API_KEY: 'should-not-leak-for-codex',
      },
      authSource: 'codex_runtime' as const,
      geminiRuntimeAuth: null,
      providerArgs: ['--codex-provider-arg'],
    }));

    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'anthropic',
      memberSpecs: [
        { name: 'Native', role: 'native member' },
        { name: 'Codex', providerId: 'codex', role: 'codex member' },
      ],
      ports: {
        buildProvisioningEnv: buildProvisioningEnvForMember,
        buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => ['--runtime-hook-arg']),
        logger: { error: vi.fn() },
      },
    });

    expect(buildProvisioningEnvForMember).toHaveBeenCalledWith('codex', undefined, {
      teamRuntimeAuth: undefined,
    });
    expect(result.args).toEqual(['--runtime-hook-arg', '--codex-provider-arg']);
    expect(result.providerArgsByProvider.get('codex')).toEqual(['--codex-provider-arg']);
    expect(result.envPatch).toEqual({
      CLAUDE_CODE_CODEX_BACKEND: 'api',
      CODEX_CLI_PATH: '/usr/local/bin/codex',
      CODEX_HOME: '/tmp/codex-home',
    });
    expect(result.usesAnthropicApiKeyHelper).toBe(false);
  });
});
/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */
