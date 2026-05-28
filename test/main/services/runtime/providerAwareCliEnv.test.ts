// @vitest-environment node
import path from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

const buildEnrichedEnvMock = vi.fn();
const getCachedShellEnvMock = vi.fn();
const getShellPreferredHomeMock = vi.fn();
const augmentAllConfiguredConnectionEnvMock = vi.fn();
const augmentConfiguredConnectionEnvMock = vi.fn();
const applyConfiguredConnectionEnvMock = vi.fn();
const applyAllConfiguredConnectionEnvMock = vi.fn();
const getConfiguredConnectionIssuesMock = vi.fn();
const getConfiguredConnectionLaunchArgsMock = vi.fn();
const resolveVerifiedOpenCodeRuntimeBinaryPathMock = vi.fn();
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.fn();
const resolveAgentTeamsMcpLaunchSpecMock = vi.fn();

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: (...args: Parameters<typeof buildEnrichedEnvMock>) =>
    buildEnrichedEnvMock(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
  getShellPreferredHome: () => getShellPreferredHomeMock(),
}));

vi.mock('../../../../src/main/services/infrastructure/ConfigManager', () => ({
  configManager: {
    getConfig: () => ({
      runtime: {
        providerBackends: {
          gemini: 'cli',
          codex: 'codex-native',
        },
      },
    }),
  },
}));

vi.mock('../../../../src/main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    augmentConfiguredConnectionEnv: (
      ...args: Parameters<typeof augmentConfiguredConnectionEnvMock>
    ) => augmentConfiguredConnectionEnvMock(...args),
    augmentAllConfiguredConnectionEnv: (
      ...args: Parameters<typeof augmentAllConfiguredConnectionEnvMock>
    ) => augmentAllConfiguredConnectionEnvMock(...args),
    applyConfiguredConnectionEnv: (...args: Parameters<typeof applyConfiguredConnectionEnvMock>) =>
      applyConfiguredConnectionEnvMock(...args),
    applyAllConfiguredConnectionEnv: (
      ...args: Parameters<typeof applyAllConfiguredConnectionEnvMock>
    ) => applyAllConfiguredConnectionEnvMock(...args),
    getConfiguredConnectionLaunchArgs: (
      ...args: Parameters<typeof getConfiguredConnectionLaunchArgsMock>
    ) => getConfiguredConnectionLaunchArgsMock(...args),
    getConfiguredConnectionIssues: (
      ...args: Parameters<typeof getConfiguredConnectionIssuesMock>
    ) => getConfiguredConnectionIssuesMock(...args),
  },
}));

vi.mock('../../../../src/main/services/infrastructure/OpenCodeRuntimeInstallerService', () => ({
  resolveVerifiedOpenCodeRuntimeBinaryPath: () => resolveVerifiedOpenCodeRuntimeBinaryPathMock(),
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
}));

vi.mock('@main/services/team/TeamMcpConfigBuilder', () => ({
  resolveAgentTeamsMcpLaunchSpec: () => resolveAgentTeamsMcpLaunchSpecMock(),
}));

describe('buildProviderAwareCliEnv', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    buildEnrichedEnvMock.mockReturnValue({
      PATH: '/usr/bin',
    });
    getCachedShellEnvMock.mockReturnValue({
      SHELL: '/bin/zsh',
    });
    getShellPreferredHomeMock.mockReturnValue('/Users/tester');
    augmentConfiguredConnectionEnvMock.mockImplementation((env: NodeJS.ProcessEnv) =>
      Promise.resolve(env)
    );
    augmentAllConfiguredConnectionEnvMock.mockImplementation((env: NodeJS.ProcessEnv) =>
      Promise.resolve(env)
    );
    applyConfiguredConnectionEnvMock.mockImplementation((env: NodeJS.ProcessEnv) =>
      Promise.resolve(env)
    );
    applyAllConfiguredConnectionEnvMock.mockImplementation((env: NodeJS.ProcessEnv) =>
      Promise.resolve(env)
    );
    getConfiguredConnectionLaunchArgsMock.mockResolvedValue([]);
    getConfiguredConnectionIssuesMock.mockResolvedValue({});
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(null);
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(null);
    resolveAgentTeamsMcpLaunchSpecMock.mockResolvedValue({
      command: 'node',
      args: ['/app/mcp-server/index.js'],
    });
  });

  it('returns narrow provider status stored credential allowlists', async () => {
    const {
      getAggregateProviderStatusStoredCredentialAllowlist,
      getProviderStatusStoredCredentialAllowlist,
    } = await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    expect(getProviderStatusStoredCredentialAllowlist('anthropic')).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
    ]);
    expect(getProviderStatusStoredCredentialAllowlist('codex')).toEqual(['OPENAI_API_KEY']);
    expect(getProviderStatusStoredCredentialAllowlist('gemini')).toBeUndefined();
    expect(getProviderStatusStoredCredentialAllowlist('opencode')).toBeUndefined();
    expect(getProviderStatusStoredCredentialAllowlist(undefined)).toBeUndefined();
    expect(getAggregateProviderStatusStoredCredentialAllowlist()).toEqual([
      'ANTHROPIC_AUTH_TOKEN',
      'OPENAI_API_KEY',
    ]);
  });

  it('builds provider-pinned CLI env and returns provider-specific issues', async () => {
    getConfiguredConnectionIssuesMock.mockResolvedValue({
      anthropic: 'missing key',
    });

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude',
      providerId: 'anthropic',
      shellEnv: {
        EXTRA_FLAG: '1',
      },
    });

    expect(buildEnrichedEnvMock).toHaveBeenCalledWith('/mock/claude');
    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: '/Users/tester',
        USERPROFILE: '/Users/tester',
        EXTRA_FLAG: '1',
        CLAUDE_CODE_PROVIDER_MANAGED_BY_HOST: '1',
        CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      }),
      'anthropic',
      undefined
    );
    expect(result.connectionIssues).toEqual({
      anthropic: 'missing key',
    });
    expect(result.providerArgs).toEqual([]);
  });

  it('keeps enriched PATH entries when a provider shell env has a narrower PATH', async () => {
    buildEnrichedEnvMock.mockReturnValue({
      PATH: ['/mock/runtime/bin', '/usr/local/bin', '/usr/bin'].join(path.delimiter),
    });

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude',
      providerId: 'codex',
      shellEnv: {
        PATH: ['/usr/bin', '/bin'].join(path.delimiter),
      },
    });

    expect(result.env.PATH?.split(path.delimiter).slice(0, 4)).toEqual([
      '/usr/bin',
      '/bin',
      '/mock/runtime/bin',
      '/usr/local/bin',
    ]);
    const appliedEnv = applyConfiguredConnectionEnvMock.mock.calls[0]?.[0] as NodeJS.ProcessEnv;
    expect(appliedEnv.PATH?.split(path.delimiter).slice(0, 4)).toEqual([
      '/usr/bin',
      '/bin',
      '/mock/runtime/bin',
      '/usr/local/bin',
    ]);
    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.any(Object),
      'codex',
      undefined
    );
  });

  it('passes metadata-only stored API key access through provider env building', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    await buildProviderAwareCliEnv({
      providerId: 'anthropic',
      allowStoredApiKeyDecryption: false,
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      }),
      'anthropic',
      undefined,
      { allowStoredApiKeyDecryption: false }
    );
  });

  it('passes a stored API key decrypt allowlist through provider env building', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    await buildProviderAwareCliEnv({
      providerId: 'anthropic',
      allowStoredApiKeyDecryption: false,
      allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_ENTRY_PROVIDER: 'anthropic',
      }),
      'anthropic',
      undefined,
      {
        allowStoredApiKeyDecryption: false,
        allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
      }
    );
  });

  it('passes a stored API key decrypt allowlist through augment env building', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    await buildProviderAwareCliEnv({
      connectionMode: 'augment',
      allowStoredApiKeyDecryption: false,
      allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
    });

    expect(augmentAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.any(Object),
      {
        allowStoredApiKeyDecryption: false,
        allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
      }
    );
    expect(applyAllConfiguredConnectionEnvMock).not.toHaveBeenCalled();
  });

  it('passes a stored API key decrypt allowlist through shared env building', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    await buildProviderAwareCliEnv({
      allowStoredApiKeyDecryption: false,
      allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'],
    });

    expect(applyAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(expect.any(Object), {
      allowStoredApiKeyDecryption: false,
      allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN', 'OPENAI_API_KEY'],
    });
    expect(applyConfiguredConnectionEnvMock).not.toHaveBeenCalled();
  });

  it('builds shared env for generic CLI launches when no provider is specified', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv();

    expect(applyAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: '/Users/tester',
        USERPROFILE: '/Users/tester',
        SHELL: '/bin/zsh',
      })
    );
    expect(getConfiguredConnectionIssuesMock).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: '/Users/tester',
      })
    );
    expect(result.connectionIssues).toEqual({});
    expect(result.providerArgs).toEqual([]);
    expect(result.env.OPENCODE_DISABLE_AUTOUPDATE).toBe('1');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe('node');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('/app/mcp-server/index.js');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBe(
      '["/app/mcp-server/index.js"]'
    );
  });

  it('adds local Agent Teams MCP launch env for OpenCode provider runtime commands', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
    });

    expect(resolveAgentTeamsMcpLaunchSpecMock).toHaveBeenCalledTimes(1);
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe('node');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('/app/mcp-server/index.js');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBe(
      '["/app/mcp-server/index.js"]'
    );
  });

  it('serializes Agent Teams MCP launch env overrides for OpenCode provider commands', async () => {
    resolveAgentTeamsMcpLaunchSpecMock.mockResolvedValue({
      command: '/opt/Agent Teams AI/agent-teams-ai',
      args: ['/app/mcp-server/index.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      env: { ELECTRON_RUN_AS_NODE: 'inherited-global-value' },
    });

    expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBe(
      '{"ELECTRON_RUN_AS_NODE":"1"}'
    );
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe(
      '/opt/Agent Teams AI/agent-teams-ai'
    );
  });

  it('preserves explicit local Agent Teams MCP launch env for OpenCode provider commands', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      env: {
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: 'custom-node',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/custom/mcp.js',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["/custom/mcp.js"]',
        ELECTRON_RUN_AS_NODE: '1',
      },
    });

    expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBe('custom-node');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('/custom/mcp.js');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBe('["/custom/mcp.js"]');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON).toBe(
      '{"ELECTRON_RUN_AS_NODE":"1"}'
    );
    expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
  });

  it('allows OpenCode auto-update only behind an explicit app override', async () => {
    buildEnrichedEnvMock.mockReturnValue({
      PATH: '/usr/bin',
      OPENCODE_DISABLE_AUTOUPDATE: '1',
    });
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = await buildProviderAwareCliEnv({
      env: {
        CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE: '1',
      },
    });

    expect(result.env.CLAUDE_TEAM_OPENCODE_ALLOW_AUTOUPDATE).toBe('1');
    expect(result.env.OPENCODE_DISABLE_AUTOUPDATE).toBeUndefined();
  });

  it('uses non-destructive credential augmentation for PTY-style envs', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      connectionMode: 'augment',
      env: {
        OPENAI_API_KEY: 'shell-key',
      },
    });

    expect(applyAllConfiguredConnectionEnvMock).not.toHaveBeenCalled();
    expect(augmentAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENAI_API_KEY: 'shell-key',
      })
    );
    expect(result.connectionIssues).toEqual({});
    expect(result.providerArgs).toEqual([]);
  });

  it('preserves caller-provided HOME and USERPROFILE overrides', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'anthropic',
      env: {
        HOME: '/Users/electron-home',
        USERPROFILE: '/Users/electron-home',
      },
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        HOME: '/Users/electron-home',
        USERPROFILE: '/Users/electron-home',
      }),
      'anthropic',
      undefined
    );
    expect(result.env.HOME).toBe('/Users/electron-home');
    expect(result.env.USERPROFILE).toBe('/Users/electron-home');
    expect(result.providerArgs).toEqual([]);
  });

  it('preserves explicit backend overrides passed by the caller', async () => {
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      connectionMode: 'augment',
      env: {
        CLAUDE_CODE_GEMINI_BACKEND: 'api',
      },
    });

    expect(augmentAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_GEMINI_BACKEND: 'api',
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      })
    );
    expect(result.env.CLAUDE_CODE_GEMINI_BACKEND).toBe('api');
    expect(result.env.CLAUDE_CODE_CODEX_BACKEND).toBe('codex-native');
    expect(result.providerArgs).toEqual([]);
  });

  it('preserves codex-native backend env across provider-aware child env building', async () => {
    buildEnrichedEnvMock.mockReturnValue({
      PATH: '/usr/bin',
    });

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'codex',
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      }),
      'codex',
      undefined
    );
    expect(result.env.CLAUDE_CODE_CODEX_BACKEND).toBe('codex-native');
    expect(result.providerArgs).toEqual([]);
  });

  it('returns provider launch args for strict codex launches', async () => {
    getConfiguredConnectionLaunchArgsMock.mockResolvedValue([
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
    ]);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'codex',
    });

    expect(getConfiguredConnectionLaunchArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_CODEX_BACKEND: 'codex-native',
      }),
      'codex',
      undefined,
      '/mock/claude-multimodel'
    );
    expect(result.providerArgs).toEqual([
      '--settings',
      '{"codex":{"forced_login_method":"chatgpt"}}',
    ]);
  });

  it('passes Codex env refreshed by strict credential application into launch args and issue checks', async () => {
    applyConfiguredConnectionEnvMock.mockImplementation(
      async (env: NodeJS.ProcessEnv, providerId: string) => {
        expect(providerId).toBe('codex');
        env.CODEX_CLI_PATH = '/Users/tester/.local/bin/codex';
        env.CODEX_HOME = '/Users/tester/.codex-custom';
        env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'chatgpt';
        delete env.OPENAI_API_KEY;
        delete env.CODEX_API_KEY;
        return env;
      }
    );
    getConfiguredConnectionLaunchArgsMock.mockResolvedValue([
      '-c',
      'forced_login_method="chatgpt"',
    ]);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'codex',
      env: {
        OPENAI_API_KEY: 'ambient-openai-key',
        CODEX_API_KEY: 'ambient-codex-key',
      },
    });

    const launchArgsEnv = getConfiguredConnectionLaunchArgsMock.mock.calls[0]?.[0] as
      | NodeJS.ProcessEnv
      | undefined;
    expect(launchArgsEnv).toBeDefined();
    expect(launchArgsEnv).toMatchObject({
      CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
      CODEX_HOME: '/Users/tester/.codex-custom',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
    });
    expect(launchArgsEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(launchArgsEnv?.CODEX_API_KEY).toBeUndefined();
    expect(getConfiguredConnectionLaunchArgsMock).toHaveBeenCalledWith(
      launchArgsEnv,
      'codex',
      undefined,
      '/mock/claude-multimodel'
    );
    const connectionIssuesEnv = getConfiguredConnectionIssuesMock.mock.calls[0]?.[0] as
      | NodeJS.ProcessEnv
      | undefined;
    expect(connectionIssuesEnv).toBeDefined();
    expect(connectionIssuesEnv).toMatchObject({
      CODEX_CLI_PATH: '/Users/tester/.local/bin/codex',
      CODEX_HOME: '/Users/tester/.codex-custom',
      CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
    });
    expect(connectionIssuesEnv?.OPENAI_API_KEY).toBeUndefined();
    expect(connectionIssuesEnv?.CODEX_API_KEY).toBeUndefined();
    expect(getConfiguredConnectionIssuesMock).toHaveBeenCalledWith(
      connectionIssuesEnv,
      ['codex'],
      { codex: undefined }
    );
    expect(result.env.CODEX_CLI_PATH).toBe('/Users/tester/.local/bin/codex');
    expect(result.env.CODEX_HOME).toBe('/Users/tester/.codex-custom');
    expect(result.env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD).toBe('chatgpt');
    expect(result.env.OPENAI_API_KEY).toBeUndefined();
    expect(result.env.CODEX_API_KEY).toBeUndefined();
    expect(result.providerArgs).toEqual(['-c', 'forced_login_method="chatgpt"']);
  });

  it('injects the verified app-managed OpenCode binary for OpenCode launches', async () => {
    const appManagedBinaryPath = path.join(
      process.cwd(),
      'App Support',
      'runtimes',
      'opencode',
      'current',
      'opencode'
    );
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(appManagedBinaryPath);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: appManagedBinaryPath,
        OPENCODE_BIN_PATH: appManagedBinaryPath,
      }),
      'opencode',
      undefined
    );
    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(appManagedBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(appManagedBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(appManagedBinaryPath));
  });

  it('exposes an explicit OpenCode binary override on PATH when the app-managed resolver is cold', async () => {
    const explicitBinaryPath = path.join(process.cwd(), 'custom opencode', 'opencode');

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      env: {
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: explicitBinaryPath,
      },
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(explicitBinaryPath));
  });

  it('does not inject the app-managed OpenCode binary into non-OpenCode provider launches', async () => {
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/opencode/current/opencode'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'anthropic',
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();
    expect(result.env.OPENCODE_BIN_PATH).toBeUndefined();
  });

  it('injects the verified app-managed Codex binary for Codex launches', async () => {
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/codex/current/codex'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'codex',
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CODEX_CLI_PATH: '/Users/tester/App Support/runtimes/codex/current/codex',
      }),
      'codex',
      undefined
    );
    expect(result.env.CODEX_CLI_PATH).toBe(
      '/Users/tester/App Support/runtimes/codex/current/codex'
    );
  });

  it('preserves explicit CODEX_CLI_PATH over the app-managed Codex binary', async () => {
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/codex/current/codex'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'codex',
      env: {
        CODEX_CLI_PATH: '/custom/codex',
      },
    });

    expect(result.env.CODEX_CLI_PATH).toBe('/custom/codex');
  });

  it('does not inject the app-managed Codex binary into non-Codex provider launches', async () => {
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/codex/current/codex'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'anthropic',
    });

    expect(result.env.CODEX_CLI_PATH).toBeUndefined();
  });
});
