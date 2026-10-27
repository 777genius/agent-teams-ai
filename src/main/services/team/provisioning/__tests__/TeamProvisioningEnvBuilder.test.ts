// @vitest-environment node
/* eslint-disable sonarjs/publicly-writable-directories -- Test fixtures intentionally use temp paths. */

import { configureDesktopMcpEnvironment } from '@features/external-agent-connection/main';
import { configManager } from '@main/services/infrastructure/ConfigManager';
import {
  clearShellEnvCache,
  resolveInteractiveShellEnvBestEffort,
  waitForPendingShellEnv,
} from '@main/utils/shellEnv';
import { AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV } from '@shared/constants/anthropicConnectionMode';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it, vi } from 'vitest';

import { createAnthropicApiKeyHelperSetupLease } from '../TeamProvisioningAnthropicApiKeyHelperLease';
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
  it.skipIf(process.platform === 'win32').each([0, 1_700])(
    'discovers shell-only Anthropic Auto credentials and models on a cold launch with %ims shell delay',
    async (shellDelayMs) => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-auto-launch-'));
      const shellPath = path.join(tempDir, 'fixture-shell.cjs');
      const invocationsPath = path.join(tempDir, 'shell-invocations');
      const previousShell = process.env.SHELL;
      const configured = configManager.getConfig();
      const configSpy = vi.spyOn(configManager, 'getConfig').mockReturnValue({
        ...configured,
        providerConnections: {
          ...configured.providerConnections,
          anthropic: {
            ...configured.providerConnections.anthropic,
            authMode: 'auto',
            compatibleEndpoint: { enabled: false, baseUrl: '' },
          },
        },
      });
      const anthropicEnv = {
        ANTHROPIC_BASE_URL: 'http://127.0.0.1:15721',
        ANTHROPIC_AUTH_TOKEN: 'synthetic-shell-token',
        ANTHROPIC_MODEL: 'gateway-main',
        ANTHROPIC_SMALL_FAST_MODEL: 'gateway-fast',
      };
      clearShellEnvCache();
      try {
        fs.writeFileSync(
          shellPath,
          `#!/usr/bin/env node\nconst fs = require('node:fs');\n` +
            `fs.appendFileSync(${JSON.stringify(invocationsPath)}, 'probe\\n');\n` +
            `const env = ${JSON.stringify({ ...anthropicEnv, HOME: tempDir, PATH: '/usr/bin' })};\n` +
            `setTimeout(() => {\n` +
            `  const result = require('node:child_process').spawnSync('/bin/sh', ['-c', process.argv[3]], { env, stdio: 'inherit' });\n` +
            `  if (result.error) throw result.error;\n` +
            `  process.exitCode = result.status ?? 1;\n` +
            `}, ${shellDelayMs});\n`,
          { mode: 0o700 }
        );
        process.env.SHELL = shellPath;
        const ports = createPorts({
          processEnv: { PATH: '/usr/bin', SHELL: shellPath },
          resolveInteractiveShellEnvBestEffort,
          waitForPendingShellEnv,
        });

        const initial = await buildProvisioningEnv({ providerId: 'anthropic', ports });
        const repeated = await buildProvisioningEnv({ providerId: 'anthropic', ports });

        expect(fs.readFileSync(invocationsPath, 'utf8')).toBe('probe\n');
        for (const result of [initial, repeated]) {
          expect(result.env).toMatchObject(anthropicEnv);
          expect(result.authSource).toBe('anthropic_auth_token');
          expect(result.env.ANTHROPIC_API_KEY).toBeUndefined();
        }
        const isolated = await buildProvisioningEnv({
          providerId: 'anthropic',
          ports: createPorts(),
        });
        expect(isolated.authSource).toBe('none');
        expect(isolated.env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
      } finally {
        await waitForPendingShellEnv();
        configSpy.mockRestore();
        clearShellEnvCache();
        if (previousShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it.skipIf(process.platform === 'win32')(
    'retains inherited HOME when pending Anthropic Auto discovery fails after the soft timeout',
    async () => {
      const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'anthropic-auto-fallback-'));
      const shellPath = path.join(tempDir, 'failing-shell.cjs');
      const inheritedHome = path.join(tempDir, 'inherited-home');
      const previousShell = process.env.SHELL;
      const processEnv = { HOME: inheritedHome, PATH: '/fallback/bin', REVIEW_EMPTY: '' };
      const configured = configManager.getConfig();
      const configSpy = vi.spyOn(configManager, 'getConfig').mockReturnValue({
        ...configured,
        providerConnections: {
          ...configured.providerConnections,
          anthropic: {
            ...configured.providerConnections.anthropic,
            authMode: 'auto',
            compatibleEndpoint: { enabled: false, baseUrl: '' },
          },
        },
      });
      const warnSpy = vi.spyOn(console, 'warn');
      clearShellEnvCache();
      try {
        fs.writeFileSync(
          shellPath,
          `#!/usr/bin/env node\n` +
            `setTimeout(() => {\n` +
            `  process.stdout.write('PLUGIN_INIT=failed\\n');\n` +
            `  process.exit(42);\n` +
            `}, process.argv[2] === '-lic' ? 1_700 : 0);\n`,
          { mode: 0o700 }
        );
        process.env.SHELL = shellPath;
        const processEnvBefore = { ...process.env };
        const result = await buildProvisioningEnv({
          providerId: 'anthropic',
          ports: createPorts({
            processEnv,
            resolveInteractiveShellEnvBestEffort,
            waitForPendingShellEnv,
          }),
        });

        expect(result.env).toMatchObject({ ...processEnv, USERPROFILE: inheritedHome });
        expect(result.authSource).toBe('none');
        expect(process.env).toEqual(processEnvBefore);
        expect(await waitForPendingShellEnv()).toBeNull();
        expect(warnSpy).toHaveBeenCalledWith(
          '[Utils:shellEnv]',
          expect.stringContaining('Failed to resolve shell env after login and interactive probes')
        );
      } finally {
        await waitForPendingShellEnv();
        warnSpy.mockClear();
        configSpy.mockRestore();
        clearShellEnvCache();
        if (previousShell === undefined) delete process.env.SHELL;
        else process.env.SHELL = previousShell;
        fs.rmSync(tempDir, { recursive: true, force: true });
      }
    }
  );

  it.each([
    ['subscription', 'anthropic', 'oauth', false, false],
    ['API key', 'anthropic', 'api_key', false, false],
    ['saved compatible endpoint', 'anthropic', 'auto', true, false],
    ['gateway member', 'anthropic', 'auto', false, true],
    ['Codex', 'codex', 'auto', false, false],
    ['OpenCode', 'opencode', 'auto', false, false],
  ] as const)(
    'keeps shell discovery cached-only for %s launches',
    async (_label, providerId, authMode, enabled, gatewayMember) => {
      const configured = configManager.getConfig();
      const configSpy = vi.spyOn(configManager, 'getConfig').mockReturnValue({
        ...configured,
        providerConnections: {
          ...configured.providerConnections,
          anthropic: {
            ...configured.providerConnections.anthropic,
            authMode,
            compatibleEndpoint: { enabled, baseUrl: 'https://gateway.example' },
          },
        },
      });
      try {
        const pendingShell = vi.fn(async () => ({ ANTHROPIC_AUTH_TOKEN: 'unrelated-token' }));
        const ports = createPorts({ waitForPendingShellEnv: pendingShell });
        await buildProvisioningEnv({ providerId, options: { gatewayMember }, ports });
        expect(ports.resolveInteractiveShellEnvBestEffort).toHaveBeenCalledWith(
          expect.objectContaining({ background: false, fallbackEnv: ports.processEnv })
        );
        expect(pendingShell).not.toHaveBeenCalled();
      } finally {
        configSpy.mockRestore();
      }
    }
  );

  it.each(['anthropic', 'codex'] as const)(
    'prepares a verified %s gateway member without global auth or a lead helper',
    async (providerId) => {
      const ports = createPorts();
      const result = await buildProvisioningEnv({
        providerId,
        options: { gatewayMember: true },
        ports,
      });
      expect(ports.buildProviderAwareCliEnv).toHaveBeenCalledWith(
        expect.objectContaining({ connectionMode: 'runtime-only' })
      );
      expect(
        ports.providerConnectionService.getConfiguredAnthropicApiKeyForTeamRuntime
      ).not.toHaveBeenCalled();
      expect(result.authSource).toBe('none');
      expect(result.warning).toBeUndefined();
      expect(result.providerArgs).toEqual([]);
    }
  );

  it('passes the resolved desktop binding to the runtime process instead of inherited values', async () => {
    const bound = {
      AGENT_TEAMS_BOUND_CONTROL_URL: 'http://127.0.0.1:4588',
      AGENT_TEAMS_BOUND_CONTEXT_JSON: 'synthetic-resolved-context',
    };
    const revoke = configureDesktopMcpEnvironment(() => bound);
    try {
      const ports = createPorts({
        buildProviderAwareCliEnv: vi.fn(async () => ({
          env: { AGENT_TEAMS_BOUND_CONTEXT_JSON: 'stale-context' },
          connectionIssues: {},
          providerArgs: [],
        })),
      });
      const result = await buildProvisioningEnv({ providerId: 'opencode', ports });
      expect(result.env).toMatchObject(bound);
    } finally {
      revoke();
    }
  });
  it('projects the late launch-resolved control URL and app root into MCP child env as well as outer env', async () => {
    const ports = createPorts({
      getClaudeBasePath: () => '/sandbox/private-claude',
      resolveControlApiBaseUrl: vi.fn(async () => 'http://127.0.0.1:4588'),
      buildProviderAwareCliEnv: vi.fn(async () => ({
        env: {
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON:
            '{"ELECTRON_RUN_AS_NODE":"1","CLAUDE_TEAM_CONTROL_URL":"http://stale:9999"}',
        },
        connectionIssues: {},
        providerArgs: [],
      })),
    });
    const result = await buildProvisioningEnv({ providerId: 'opencode', ports });
    expect(result.env.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe('/sandbox/private-claude');
    expect(result.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:4588');
    expect(JSON.parse(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).toEqual({
      ELECTRON_RUN_AS_NODE: '1',
      AGENT_TEAMS_MCP_CLAUDE_DIR: '/sandbox/private-claude',
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:4588',
    });
  });

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

  it('launches gateway-bound Codex members without a global Codex credential', async () => {
    const buildGlobalEnv = vi.fn(async () => {
      throw new Error('No global Codex credential');
    });
    const result = await buildCrossProviderMemberArgs({
      primaryProviderId: 'anthropic',
      memberSpecs: [{ name: 'bound', providerId: 'codex', model: 'gpt-5' }],
      options: { teamRuntimeAuth: { teamName: 'sandbox' } },
      ports: {
        buildProvisioningEnv: buildGlobalEnv,
        buildRuntimeTurnSettledHookSettingsArgs: async () => [],
        logger: { error: vi.fn() },
        getMemberGatewayRuntimeSeams: () => ({
          resolveMemberConnection: async () => ({
            teamName: 'sandbox',
            memberName: 'bound',
            gatewayUsageRef: 'member-source',
            apiKey: 'member-only-key',
            spec: {
              profileId: 'profile',
              baseUrl: 'https://gateway.example',
              credentialRef: 'key-ref',
              allowPrivateNetwork: false,
              model: 'gpt-5',
            },
          }),
          configureOpenCodeLocalProvider: async () => ({ providerId: '', modelRoute: '' }),
          retireOpenCodeLocalProvider: async () => ({ retired: false }),
          markRuntimeArtifactActive: async () => undefined,
          markRuntimeArtifactRetired: async () => undefined,
        }),
      },
    });
    expect(buildGlobalEnv).not.toHaveBeenCalled();
    expect(result.envPatch.CODEX_API_KEY).toBeUndefined();
    expect(result.memberArgsByMember.get('bound')?.envPatch.CODEX_API_KEY).toBe('member-only-key');
    expect(result.memberArgsByMember.get('bound')?.gatewayUsageRef).toBe('member-source');
  });

  it.each(['anthropic', 'codex'] as const)(
    'keeps global %s preparation when unbound members only have attribution hooks',
    async (providerId) => {
      const snapshotLaunch = vi.fn(async () => 'unbound-launch');
      const buildGlobalEnv = vi.fn(async () => ({
        env: { CODEX_HOME: '/sandbox/codex', ANTHROPIC_AUTH_TOKEN: 'synthetic-global-token' },
        authSource: 'none' as const,
        geminiRuntimeAuth: null,
        providerArgs: ['--global-provider-settings'],
      }));
      const result = await buildCrossProviderMemberArgs({
        primaryProviderId: providerId === 'codex' ? 'anthropic' : 'codex',
        memberSpecs: [{ name: 'ordinary', providerId }],
        options: { teamRuntimeAuth: { teamName: 'sandbox' } },
        ports: {
          buildProvisioningEnv: buildGlobalEnv,
          buildRuntimeTurnSettledHookSettingsArgs: async () => [],
          logger: { error: vi.fn() },
          getMemberGatewayRuntimeSeams: () => ({
            resolveMemberConnection: async () => null,
            snapshotLaunch,
            configureOpenCodeLocalProvider: async () => ({ providerId: '', modelRoute: '' }),
            retireOpenCodeLocalProvider: async () => ({ retired: false }),
            markRuntimeArtifactActive: async () => undefined,
            markRuntimeArtifactRetired: async () => undefined,
          }),
        },
      });
      expect(buildGlobalEnv).toHaveBeenCalledWith(providerId, undefined, {
        teamRuntimeAuth: { teamName: 'sandbox' },
      });
      expect(result.providerArgsByProvider.get(providerId)).toEqual(['--global-provider-settings']);
      expect(result.envPatch).toMatchObject(
        providerId === 'codex'
          ? { CODEX_HOME: '/sandbox/codex' }
          : { ANTHROPIC_AUTH_TOKEN: 'synthetic-global-token' }
      );
      const memberArgs = result.memberArgsByMember.get('ordinary');
      expect(memberArgs?.gatewayUsageRef).toBeUndefined();
      await memberArgs?.beginLaunch?.();
      expect(snapshotLaunch).toHaveBeenCalledWith({
        teamName: 'sandbox',
        memberName: 'ordinary',
        providerId,
        gatewayUsageRef: undefined,
      });
    }
  );

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

  it('carries the Codex API key in the cross-provider patch only for api login mode', async () => {
    const makePorts = (loginMethod: string) => ({
      buildProvisioningEnv: vi.fn(async () => ({
        env: {
          CODEX_HOME: '/tmp/codex-home',
          CODEX_CLI_PATH: '/usr/local/bin/codex',
          CLAUDE_CODE_CODEX_BACKEND: 'api',
          CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: loginMethod,
          OPENAI_API_KEY: 'sk-proj-cross-provider',
          CODEX_API_KEY: 'sk-proj-cross-provider',
        },
        authSource: 'codex_runtime' as const,
        geminiRuntimeAuth: null,
        providerArgs: [],
      })),
      buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
      logger: { error: vi.fn() },
    });

    const apiMode = await buildCrossProviderMemberArgs({
      primaryProviderId: 'anthropic',
      memberSpecs: [{ name: 'Codex', providerId: 'codex', role: 'codex member' }],
      ports: makePorts('api'),
    });
    expect(apiMode.envPatch.OPENAI_API_KEY).toBe('sk-proj-cross-provider');
    expect(apiMode.envPatch.CODEX_API_KEY).toBe('sk-proj-cross-provider');

    const chatgptMode = await buildCrossProviderMemberArgs({
      primaryProviderId: 'anthropic',
      memberSpecs: [{ name: 'Codex', providerId: 'codex', role: 'codex member' }],
      ports: makePorts('chatgpt'),
    });
    expect(chatgptMode.envPatch.OPENAI_API_KEY).toBeUndefined();
    expect(chatgptMode.envPatch.CODEX_API_KEY).toBeUndefined();
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

  it.each(['codex', 'gemini'] as const)(
    'pre-materializes and leases Anthropic helper auth for a future %s-primary dynamic spawn',
    async (primaryProviderId) => {
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
      const anthropicApiKeyHelperLease = createAnthropicApiKeyHelperSetupLease();
      const teamRuntimeAuth = {
        teamName: 'mixed-team',
        authMaterialId: 'run-1',
        allowAnthropicApiKeyHelper: true,
        anthropicApiKeyHelperLease,
      };

      const result = await buildCrossProviderMemberArgs({
        primaryProviderId,
        memberSpecs: [
          {
            name: primaryProviderId === 'codex' ? 'Codex' : 'Gemini',
            providerId: primaryProviderId,
            role: 'only initial member',
          },
        ],
        options: {
          teamRuntimeAuth,
        },
        ports: {
          buildProvisioningEnv: buildProvisioningEnvForMember,
          buildRuntimeTurnSettledHookSettingsArgs,
          logger: { error: vi.fn() },
        },
      });

      expect(buildProvisioningEnvForMember).toHaveBeenCalledWith('anthropic', undefined, {
        teamRuntimeAuth,
      });
      expect(buildRuntimeTurnSettledHookSettingsArgs).not.toHaveBeenCalled();
      expect(result.args).toEqual([]);
      expect(result.providerArgsByProvider.has('anthropic')).toBe(false);
      expect(result.anthropicApiKeyHelper).toBe(helper);
      expect(anthropicApiKeyHelperLease.getOwnedMaterial()).toBe(helper);
      expect(result.envPatch).toMatchObject({
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'api_key',
        CLAUDE_TEAM_ANTHROPIC_AUTH_MODE: 'api_key_helper',
        CLAUDE_TEAM_ANTHROPIC_API_KEY_HELPER_SETTINGS_PATH:
          '/tmp/team-runtime-auth/mixed-team/run-1/settings.json',
      });
    }
  );

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

  it.each([
    ['authless', '', 'none'],
    ['token-authenticated', 'gateway-token', 'anthropic_auth_token'],
  ] as const)(
    'prepares %s compatible models for a future dynamic Anthropic spawn',
    async (_label, token, authSource) => {
      const customModels = {
        ANTHROPIC_MODEL: 'gateway-large',
        ANTHROPIC_SMALL_FAST_MODEL: 'gateway-small',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'gateway-sonnet',
      };
      const result = await buildCrossProviderMemberArgs({
        primaryProviderId: 'gemini',
        memberSpecs: [{ name: 'Gemini', providerId: 'gemini', role: 'only initial member' }],
        ports: {
          buildProvisioningEnv: vi.fn(async () => ({
            env: {
              ...customModels,
              [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible',
              ANTHROPIC_BASE_URL: 'http://localhost:1234',
              ANTHROPIC_API_KEY: '',
              ANTHROPIC_AUTH_TOKEN: token,
            },
            authSource,
            geminiRuntimeAuth: null,
            providerArgs: [],
          })),
          buildRuntimeTurnSettledHookSettingsArgs: vi.fn(async () => []),
          logger: { error: vi.fn() },
        },
      });

      expect(result.envPatch).toMatchObject({
        ...customModels,
        [AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE_ENV]: 'compatible',
        ANTHROPIC_BASE_URL: 'http://localhost:1234',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: token,
      });
    }
  );

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
