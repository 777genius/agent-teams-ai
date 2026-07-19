/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';
import fs from 'fs';
import os from 'os';
import path from 'path';
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

  it('carries Anthropic connection intent through a non-Anthropic primary runtime', async () => {
    const buildProvisioningEnvForMember = vi.fn(async () => ({
      env: {
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'subscription',
        CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      },
      authSource: 'none' as const,
      geminiRuntimeAuth: null,
      providerArgs: [],
    }));

    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'codex',
      memberSpecs: [
        { name: 'Codex', providerId: 'codex', role: 'primary member' },
        { name: 'Claude', providerId: 'anthropic', role: 'anthropic member' },
      ],
      ports: {
        buildProvisioningEnv: buildProvisioningEnvForMember,
        buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
        logger: { error: vi.fn() },
      },
    });

    expect(result.envPatch).toEqual({
      [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'subscription',
    });
    expect(result.usesAnthropicApiKeyHelper).toBe(false);
  });

  it('pre-materializes app-managed Anthropic helper auth for a future dynamic spawn', async () => {
    const helper = {
      teamName: 'mixed-team',
      directory: '/tmp/team-runtime-auth/mixed-team/run-1',
      helperPath: '/tmp/team-runtime-auth/mixed-team/run-1/helper.sh',
      keyPath: '/tmp/team-runtime-auth/mixed-team/run-1/key',
      settingsPath: '/tmp/team-runtime-auth/mixed-team/run-1/settings.json',
      settingsObject: { apiKeyHelper: "'/tmp/team-runtime-auth/mixed-team/run-1/helper.sh'" },
      settingsArgs: ['--settings', '/tmp/team-runtime-auth/mixed-team/run-1/settings.json'],
      envPatch: {
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH:
          '/tmp/team-runtime-auth/mixed-team/run-1/settings.json',
      },
    };
    const buildProvisioningEnvForMember = vi.fn(async () => ({
      env: {
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'api_key',
        ...helper.envPatch,
      },
      authSource: 'anthropic_api_key_helper' as const,
      geminiRuntimeAuth: null,
      providerArgs: helper.settingsArgs,
      anthropicApiKeyHelper: helper,
    }));
    const buildRuntimeTurnSettledHookSettingsArgs = vi.fn(async () => ['--runtime-hook-arg']);

    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'codex',
      memberSpecs: [{ name: 'Codex', providerId: 'codex', role: 'only initial member' }],
      options: {
        teamRuntimeAuth: {
          teamName: 'mixed-team',
          authMaterialId: 'run-1',
          allowAnthropicApiKeyHelper: true,
        },
      },
      ports: {
        buildProvisioningEnv: buildProvisioningEnvForMember,
        buildRuntimeTurnSettledHookSettingsArgs,
        logger: { error: vi.fn() },
      },
    });

    expect(buildProvisioningEnvForMember).toHaveBeenCalledWith('anthropic', undefined, {
      teamRuntimeAuth: {
        teamName: 'mixed-team',
        authMaterialId: 'run-1',
        allowAnthropicApiKeyHelper: true,
      },
    });
    expect(buildRuntimeTurnSettledHookSettingsArgs).not.toHaveBeenCalled();
    expect(result.args).toEqual([]);
    expect(result.providerArgsByProvider.has('anthropic')).toBe(false);
    expect(result.anthropicApiKeyHelper).toBe(helper);
    expect(result.envPatch).toMatchObject({
      [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'api_key',
      CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
      CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH:
        '/tmp/team-runtime-auth/mixed-team/run-1/settings.json',
    });
  });

  it('cleans Anthropic helper material when a later cross-provider validation fails', async () => {
    const helperDirectory = await fs.promises.mkdtemp(
      path.join(os.tmpdir(), 'anthropic-cross-provider-helper-')
    );
    const helper = {
      teamName: 'mixed-team',
      directory: helperDirectory,
      helperPath: path.join(helperDirectory, 'helper.sh'),
      keyPath: path.join(helperDirectory, 'key'),
      settingsPath: path.join(helperDirectory, 'settings.json'),
      settingsObject: { apiKeyHelper: `'${path.join(helperDirectory, 'helper.sh')}'` },
      settingsArgs: ['--settings', path.join(helperDirectory, 'settings.json')],
      envPatch: {
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH: path.join(
          helperDirectory,
          'settings.json'
        ),
      },
    };
    await Promise.all([
      fs.promises.writeFile(helper.helperPath, '#!/bin/sh\n'),
      fs.promises.writeFile(helper.keyPath, 'sk-ant-test\n'),
      fs.promises.writeFile(helper.settingsPath, '{}\n'),
    ]);

    try {
      await expect(
        buildCrossProviderMemberArgs({
          primaryProviderId: 'gemini',
          memberSpecs: [
            { name: 'Claude', providerId: 'anthropic', role: 'anthropic member' },
            { name: 'Codex', providerId: 'codex', role: 'codex member' },
          ],
          ports: {
            buildProvisioningEnv: vi.fn(async (providerId) =>
              providerId === 'anthropic'
                ? {
                    env: helper.envPatch,
                    authSource: 'anthropic_api_key_helper' as const,
                    geminiRuntimeAuth: null,
                    providerArgs: helper.settingsArgs,
                    anthropicApiKeyHelper: helper,
                  }
                : {
                    env: {},
                    authSource: 'configured_api_key_missing' as const,
                    geminiRuntimeAuth: null,
                    providerArgs: [],
                    warning: 'Codex auth is unavailable',
                  }
            ),
            buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
            logger: { error: vi.fn() },
          },
        })
      ).rejects.toThrow('Codex: Codex auth is unavailable');

      await expect(fs.promises.stat(helperDirectory)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally {
      await fs.promises.rm(helperDirectory, { recursive: true, force: true });
    }
  });

  it('prepares an authless compatible endpoint for a future dynamic Anthropic spawn', async () => {
    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'gemini',
      memberSpecs: [{ name: 'Gemini', providerId: 'gemini', role: 'only initial member' }],
      ports: {
        buildProvisioningEnv: vi.fn(async () => ({
          env: {
            [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible',
            ANTHROPIC_BASE_URL: 'http://localhost:1234',
            ANTHROPIC_API_KEY: '',
          },
          authSource: 'none' as const,
          geminiRuntimeAuth: null,
          providerArgs: [],
        })),
        buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
        logger: { error: vi.fn() },
      },
    });

    expect(result.envPatch).toMatchObject({
      [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible',
      ANTHROPIC_BASE_URL: 'http://localhost:1234',
      ANTHROPIC_API_KEY: '',
      ANTHROPIC_AUTH_TOKEN: '',
    });
  });

  it('preserves Auto Bedrock routing for a future dynamic Anthropic spawn', async () => {
    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'codex',
      memberSpecs: [{ name: 'Codex', providerId: 'codex', role: 'only initial member' }],
      ports: {
        buildProvisioningEnv: vi.fn(async () => ({
          env: {
            [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'auto',
            CLAUDE_CODE_USE_BEDROCK: '1',
            AWS_PROFILE: 'bedrock-profile',
            AWS_REGION: 'us-east-1',
            AWS_CONFIG_FILE: '/tmp/aws-config',
            AWS_SHARED_CREDENTIALS_FILE: '/tmp/aws-credentials',
            ANTHROPIC_DEFAULT_SONNET_MODEL: 'bedrock-sonnet-id',
          },
          authSource: 'none' as const,
          geminiRuntimeAuth: null,
          providerArgs: [],
        })),
        buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
        logger: { error: vi.fn() },
      },
    });

    expect(result.envPatch).toMatchObject({
      [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'auto',
      CLAUDE_CODE_USE_BEDROCK: '1',
      AWS_PROFILE: 'bedrock-profile',
      AWS_REGION: 'us-east-1',
      AWS_CONFIG_FILE: '/tmp/aws-config',
      AWS_SHARED_CREDENTIALS_FILE: '/tmp/aws-credentials',
      ANTHROPIC_DEFAULT_SONNET_MODEL: 'bedrock-sonnet-id',
    });
  });
});
/* eslint-enable sonarjs/publicly-writable-directories -- Re-enable after temp-path fixtures. */
