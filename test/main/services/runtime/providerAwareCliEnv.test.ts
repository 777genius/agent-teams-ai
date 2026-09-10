// @vitest-environment node
import * as fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const execCliMock = vi.fn();
vi.mock('@main/utils/childProcess', () => ({
  execCli: (...args: unknown[]) => execCliMock(...args),
  spawnCli: vi.fn(() => {
    throw new Error('unexpected spawn');
  }),
  killProcessTree: vi.fn(),
}));
vi.mock('@main/services/team/ClaudeBinaryResolver', () => ({
  ClaudeBinaryResolver: { resolve: vi.fn(() => Promise.resolve('/sandbox/agent-teams-cli')) },
}));

const buildEnrichedEnvMock = vi.fn();
const getCachedShellEnvMock = vi.fn();
const getShellPreferredHomeMock = vi.fn();
const augmentAllConfiguredConnectionEnvMock = vi.fn();
const augmentConfiguredConnectionEnvMock = vi.fn();
const applyConfiguredConnectionEnvMock = vi.fn();
const applyAllConfiguredConnectionEnvMock = vi.fn();
const getConfiguredConnectionIssuesMock = vi.fn();
const getConfiguredConnectionLaunchArgsMock = vi.fn();
const resolveAppManagedOpenCodeRuntimeBinaryPathMock = vi.fn();
const resolveCachedVerifiedOpenCodeRuntimeBinaryPathMock = vi.fn();
const resolveVerifiedOpenCodeRuntimeBinaryPathMock = vi.fn();
const isSupportedOpenCodeRuntimeBinaryPathMock = vi.fn();
const resolveAppManagedCodexRuntimeBinaryPathMock = vi.fn();
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.fn();
const resolveAgentTeamsMcpLaunchSpecMock = vi.fn();
const resolvePackagedAgentTeamsMcpEntryMock = vi.fn();

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: (...args: Parameters<typeof buildEnrichedEnvMock>) =>
    buildEnrichedEnvMock(...args),
}));

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
  resolveInteractiveShellEnvBestEffort: () => Promise.resolve(getCachedShellEnvMock()),
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
      providerConnections: {
        anthropic: {
          authMode: 'auto',
          compatibleEndpoint: { enabled: false },
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
  isSupportedOpenCodeRuntimeBinaryPath: (...args: unknown[]) =>
    isSupportedOpenCodeRuntimeBinaryPathMock(...args),
  resolveAppManagedOpenCodeRuntimeBinaryPath: () =>
    resolveAppManagedOpenCodeRuntimeBinaryPathMock(),
  resolveCachedVerifiedOpenCodeRuntimeBinaryPath: () =>
    resolveCachedVerifiedOpenCodeRuntimeBinaryPathMock(),
  resolveVerifiedOpenCodeRuntimeBinaryPath: () => resolveVerifiedOpenCodeRuntimeBinaryPathMock(),
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveAppManagedCodexRuntimeBinaryPath: () => resolveAppManagedCodexRuntimeBinaryPathMock(),
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
}));

vi.mock('@main/services/team/TeamMcpConfigBuilder', () => ({
  resolveAgentTeamsMcpLaunchSpec: () => resolveAgentTeamsMcpLaunchSpecMock(),
  resolvePackagedAgentTeamsMcpEntry: () => resolvePackagedAgentTeamsMcpEntryMock(),
}));

describe('buildProviderAwareCliEnv', () => {
  afterEach(() => vi.unstubAllEnvs());

  it.each(['active', 'passive'] as const)(
    'projects current app root/control into %s outer and MCP child env without stale shell contamination',
    async (mode) => {
      const { setClaudeBasePathOverride } = await import('@main/utils/pathDecoder');
      const { buildProviderAwareCliEnv, buildPassiveProviderStatusCliEnv } =
        await import('@main/services/runtime/providerAwareCliEnv');
      setClaudeBasePathOverride('/sandbox/private-claude');
      vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://127.0.0.1:4569');
      const options = {
        providerId: 'opencode' as const,
        env: {
          HOME: '/sandbox/home',
          CLAUDE_CONFIG_DIR: '/sandbox/auth-namespace',
          AGENT_TEAMS_MCP_CLAUDE_DIR: '/stale/root',
          CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:9999',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND: '/sandbox/electron',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY: '/sandbox/mcp.js',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON: '["/sandbox/mcp.js"]',
          CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: JSON.stringify({
            ELECTRON_RUN_AS_NODE: '1',
            OWNER_FIXTURE: 'unchanged',
            AGENT_TEAMS_MCP_CLAUDE_DIR: '/stale/child',
            CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:9998',
          }),
        },
      };
      try {
        const result =
          mode === 'active'
            ? await buildProviderAwareCliEnv(options)
            : buildPassiveProviderStatusCliEnv(options);
        expect(result.env.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe('/sandbox/private-claude');
        expect(result.env.CLAUDE_TEAM_CONTROL_URL).toBe('http://127.0.0.1:4569');
        expect(JSON.parse(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).toEqual({
          ELECTRON_RUN_AS_NODE: '1',
          OWNER_FIXTURE: 'unchanged',
          AGENT_TEAMS_MCP_CLAUDE_DIR: '/sandbox/private-claude',
          CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:4569',
        });
        expect(result.env.HOME).toBe('/sandbox/home');
        expect(result.env.CLAUDE_CONFIG_DIR).toBe('/sandbox/auth-namespace');
        expect(options.env.AGENT_TEAMS_MCP_CLAUDE_DIR).toBe('/stale/root');
        expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
        if (mode === 'passive') {
          expect(resolveVerifiedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
          expect(resolveVerifiedAppManagedCodexRuntimeBinaryPathMock).not.toHaveBeenCalled();
          expect(augmentConfiguredConnectionEnvMock).not.toHaveBeenCalled();
          expect(applyConfiguredConnectionEnvMock).not.toHaveBeenCalled();
        }
      } finally {
        setClaudeBasePathOverride(null);
      }
    }
  );

  it('keeps passive reads passive when no server or MCP launch metadata exists and strips dead endpoints', async () => {
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', undefined);
    const { buildPassiveProviderStatusCliEnv } =
      await import('@main/services/runtime/providerAwareCliEnv');
    const result = buildPassiveProviderStatusCliEnv({
      providerId: 'opencode',
      shellEnv: {
        CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:9999',
        CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON:
          '{"CLAUDE_TEAM_CONTROL_URL":"http://127.0.0.1:9998"}',
      },
    });
    expect(result.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
    expect(
      JSON.parse(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!).CLAUDE_TEAM_CONTROL_URL
    ).toBeUndefined();
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
    expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
    expect(resolvePackagedAgentTeamsMcpEntryMock).not.toHaveBeenCalled();
    expect(resolveVerifiedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
    expect(augmentConfiguredConnectionEnvMock).not.toHaveBeenCalled();
  });

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
    resolveAppManagedOpenCodeRuntimeBinaryPathMock.mockReturnValue(null);
    resolveCachedVerifiedOpenCodeRuntimeBinaryPathMock.mockReturnValue(null);
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(null);
    isSupportedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(true);
    resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(null);
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(null);
    resolveAgentTeamsMcpLaunchSpecMock.mockResolvedValue({
      command: 'node',
      args: ['/app/mcp-server/index.js'],
    });
    resolvePackagedAgentTeamsMcpEntryMock.mockResolvedValue(null);
  });

  it('passes cold Host publication and changed-port reopen to direct provider catalog without provisioning', async () => {
    const root = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'app-catalog-context-'));
    const { setClaudeBasePathOverride } = await import('@main/utils/pathDecoder');
    const { writeTeamControlApiState, clearTeamControlApiState } =
      await import('@main/services/team/TeamControlApiState');
    const { AgentTeamsRuntimeProviderManagementCliClient } =
      await import('@features/runtime-provider-management/main/infrastructure/AgentTeamsRuntimeProviderManagementCliClient');
    vi.stubEnv('CLAUDE_TEAM_CONTROL_URL', 'http://127.0.0.1:9999');
    setClaudeBasePathOverride(root);
    getCachedShellEnvMock.mockReturnValue({
      HOME: root,
      CLAUDE_CONFIG_DIR: path.join(root, 'auth-namespace'),
      AGENT_TEAMS_MCP_CLAUDE_DIR: '/stale/shell-root',
      CLAUDE_TEAM_CONTROL_URL: 'http://127.0.0.1:9998',
    });
    resolveAgentTeamsMcpLaunchSpecMock.mockResolvedValue({
      command: '/sandbox/electron',
      args: ['/sandbox/mcp.js'],
      env: { ELECTRON_RUN_AS_NODE: '1' },
    });
    const response = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      models: {
        runtimeId: 'opencode',
        providerId: 'xai',
        models: [],
        defaultModelId: null,
        diagnostics: [],
        catalogState: 'fresh',
      },
    };
    execCliMock.mockResolvedValue({ stdout: JSON.stringify(response), stderr: '' });
    try {
      await clearTeamControlApiState();
      for (const port of [4580, 4581]) {
        await writeTeamControlApiState(`http://127.0.0.1:${port}`);
        const client = new AgentTeamsRuntimeProviderManagementCliClient();
        await expect(
          client.loadModels({ runtimeId: 'opencode', providerId: 'xai' })
        ).resolves.toEqual(response);
        const [command, args, options] = execCliMock.mock.calls.at(-1)!;
        expect(command).toBe('/sandbox/agent-teams-cli');
        expect(args).toEqual([
          'runtime',
          'providers',
          'models',
          '--runtime',
          'opencode',
          '--provider',
          'xai',
          '--json',
        ]);
        expect(options.env).toMatchObject({
          AGENT_TEAMS_MCP_CLAUDE_DIR: root,
          CLAUDE_TEAM_CONTROL_URL: `http://127.0.0.1:${port}`,
          HOME: root,
          CLAUDE_CONFIG_DIR: path.join(root, 'auth-namespace'),
        });
        expect(JSON.parse(options.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON)).toEqual({
          ELECTRON_RUN_AS_NODE: '1',
          AGENT_TEAMS_MCP_CLAUDE_DIR: root,
          CLAUDE_TEAM_CONTROL_URL: `http://127.0.0.1:${port}`,
        });
        await clearTeamControlApiState();
        expect(process.env.CLAUDE_TEAM_CONTROL_URL).toBeUndefined();
      }
      expect(execCliMock).toHaveBeenCalledTimes(2);
    } finally {
      await clearTeamControlApiState();
      setClaudeBasePathOverride(null);
      await fs.promises.rm(root, { recursive: true, force: true });
    }
  });

  it.each(['null', '[]', '{"OWNER":42}', '{broken'])(
    'rejects malformed existing MCP child env %s without repairing away owner fields',
    async (raw) => {
      const { buildPassiveProviderStatusCliEnv } =
        await import('@main/services/runtime/providerAwareCliEnv');
      expect(() =>
        buildPassiveProviderStatusCliEnv({
          providerId: 'opencode',
          env: { CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON: raw },
        })
      ).toThrow();
      expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
      expect(augmentConfiguredConnectionEnvMock).not.toHaveBeenCalled();
    }
  );

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

  it('keeps passive status env out of runtime probes, MCP, auth, and launch resolution', async () => {
    const { buildPassiveProviderStatusCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const mkdirSpy = vi.spyOn(fs.promises, 'mkdir');
    const copyFileSpy = vi.spyOn(fs.promises, 'copyFile');
    const rmSpy = vi.spyOn(fs.promises, 'rm');

    try {
      const result = buildPassiveProviderStatusCliEnv({
        binaryPath: '/mock/runtime',
        providerId: 'codex',
        env: { ELECTRON_RUN_AS_NODE: '1' },
      });

      expect(result.connectionIssues).toEqual({});
      expect(result.providerArgs).toEqual([]);
      expect(result.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
      expect(result.env.CLAUDE_CODE_ENTRY_PROVIDER).toBe('codex');
      expect(result.env.CODEX_CLI_PATH).toBeUndefined();
      expect(resolveAppManagedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
      expect(resolveVerifiedAppManagedCodexRuntimeBinaryPathMock).not.toHaveBeenCalled();
      expect(resolveVerifiedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
      expect(isSupportedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
      expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
      expect(resolvePackagedAgentTeamsMcpEntryMock).not.toHaveBeenCalled();
      expect(augmentConfiguredConnectionEnvMock).not.toHaveBeenCalled();
      expect(applyConfiguredConnectionEnvMock).not.toHaveBeenCalled();
      expect(getConfiguredConnectionLaunchArgsMock).not.toHaveBeenCalled();
      expect(getConfiguredConnectionIssuesMock).not.toHaveBeenCalled();
      expect(augmentAllConfiguredConnectionEnvMock).not.toHaveBeenCalled();
      expect(applyAllConfiguredConnectionEnvMock).not.toHaveBeenCalled();
      expect(mkdirSpy).not.toHaveBeenCalled();
      expect(copyFileSpy).not.toHaveBeenCalled();
      expect(rmSpy).not.toHaveBeenCalled();
    } finally {
      mkdirSpy.mockRestore();
      copyFileSpy.mockRestore();
      rmSpy.mockRestore();
    }
  });

  it('projects existing app-managed OpenCode metadata into passive status env', async () => {
    const managedBinaryPath = path.join('/managed', 'opencode', 'bin', 'opencode');
    resolveAppManagedOpenCodeRuntimeBinaryPathMock.mockReturnValue(managedBinaryPath);
    const { buildPassiveProviderStatusCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = buildPassiveProviderStatusCliEnv({
      binaryPath: '/mock/runtime',
      providerId: 'opencode',
      env: {},
    });

    expect(resolveAppManagedOpenCodeRuntimeBinaryPathMock).toHaveBeenCalledTimes(1);
    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(managedBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(managedBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(managedBinaryPath));
    expect(resolveVerifiedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
    expect(isSupportedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
    expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
    expect(applyConfiguredConnectionEnvMock).not.toHaveBeenCalled();
  });

  it.each([undefined, 'codex'] as const)(
    'projects managed Codex metadata into passive status for provider %s without probes',
    async (providerId) => {
      const managedBinary = '/managed/codex/bin/codex';
      resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue(managedBinary);
      const { buildPassiveProviderStatusCliEnv } =
        await import('../../../../src/main/services/runtime/providerAwareCliEnv');

      const { env } = buildPassiveProviderStatusCliEnv({ providerId });

      expect(env.CODEX_CLI_PATH).toBe(managedBinary);
      expect(resolveVerifiedAppManagedCodexRuntimeBinaryPathMock).not.toHaveBeenCalled();
      expect(applyConfiguredConnectionEnvMock).not.toHaveBeenCalled();
      expect(resolveAgentTeamsMcpLaunchSpecMock).not.toHaveBeenCalled();
    }
  );

  it.each(['call', 'shell', 'inherited'])(
    'preserves a %s Codex binary override over passive managed metadata',
    async (source) => {
      const override = { CODEX_CLI_PATH: '/custom/codex' };
      resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue('/managed/codex');
      if (source === 'shell') getCachedShellEnvMock.mockReturnValue(override);
      if (source === 'inherited') buildEnrichedEnvMock.mockReturnValue(override);
      const { buildPassiveProviderStatusCliEnv } =
        await import('../../../../src/main/services/runtime/providerAwareCliEnv');

      const { env } = buildPassiveProviderStatusCliEnv({
        providerId: 'codex',
        env: source === 'call' ? override : undefined,
      });

      expect(env.CODEX_CLI_PATH).toBe('/custom/codex');
    }
  );

  it.each(['anthropic', 'gemini', 'opencode'] as const)(
    'does not project managed Codex into passive %s status',
    async (providerId) => {
      resolveAppManagedCodexRuntimeBinaryPathMock.mockReturnValue('/managed/codex');
      const { buildPassiveProviderStatusCliEnv } =
        await import('../../../../src/main/services/runtime/providerAwareCliEnv');

      const { env } = buildPassiveProviderStatusCliEnv({ providerId });

      expect(env.CODEX_CLI_PATH).toBeUndefined();
      expect(resolveAppManagedCodexRuntimeBinaryPathMock).not.toHaveBeenCalled();
    }
  );

  it('projects a previously verified PATH runtime into passive status without probing again', async () => {
    const cachedBinaryPath = path.join('/opt', 'homebrew', 'bin', 'opencode');
    resolveCachedVerifiedOpenCodeRuntimeBinaryPathMock.mockReturnValue(cachedBinaryPath);
    const { buildPassiveProviderStatusCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = buildPassiveProviderStatusCliEnv({
      binaryPath: '/mock/runtime',
      providerId: 'opencode',
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(cachedBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(cachedBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(cachedBinaryPath));
    expect(resolveVerifiedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
    expect(isSupportedOpenCodeRuntimeBinaryPathMock).not.toHaveBeenCalled();
  });

  it('preserves an explicit OpenCode binary override for passive status', async () => {
    const explicitBinaryPath = path.join('/explicit', 'opencode');
    resolveAppManagedOpenCodeRuntimeBinaryPathMock.mockReturnValue(
      path.join('/managed', 'opencode')
    );
    const { buildPassiveProviderStatusCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = buildPassiveProviderStatusCliEnv({
      binaryPath: '/mock/runtime',
      providerId: 'opencode',
      env: { CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: explicitBinaryPath },
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(explicitBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(explicitBinaryPath));
  });

  it('replaces a stale login-shell OpenCode override with app-managed metadata', async () => {
    const managedBinaryPath = path.join('/managed', 'opencode');
    getCachedShellEnvMock.mockReturnValue({
      OPENCODE_BIN_PATH: path.join('/stale', 'shell', 'opencode'),
      PATH: '/usr/bin',
    });
    resolveAppManagedOpenCodeRuntimeBinaryPathMock.mockReturnValue(managedBinaryPath);
    const { buildPassiveProviderStatusCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = buildPassiveProviderStatusCliEnv({
      binaryPath: '/mock/runtime',
      providerId: 'opencode',
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(managedBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(managedBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(managedBinaryPath));
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
        AGENT_TEAMS_ANTHROPIC_CONNECTION_MODE: 'auto',
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

    expect(augmentAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(expect.any(Object), {
      allowStoredApiKeyDecryption: false,
      allowedStoredApiKeyEnvVarNames: ['ANTHROPIC_AUTH_TOKEN'],
      allowClaudeUserSettingsAuthEnv: false,
    });
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

  it('forwards a packaged MCP entry when full launch spec resolution fails', async () => {
    resolveAgentTeamsMcpLaunchSpecMock.mockRejectedValue(new Error('Node runtime unavailable'));
    resolvePackagedAgentTeamsMcpEntryMock.mockResolvedValue('/app/mcp-server/index.js');
    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');

    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
    });

    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENTRY).toBe('/app/mcp-server/index.js');
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_COMMAND).toBeUndefined();
    expect(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ARGS_JSON).toBeUndefined();
    vi.mocked(console.warn).mockClear();
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
    expect(JSON.parse(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
    });
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
    expect(JSON.parse(result.env.CLAUDE_MULTIMODEL_AGENT_TEAMS_MCP_ENV_JSON!)).toMatchObject({
      ELECTRON_RUN_AS_NODE: '1',
    });
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
      }),
      {
        allowClaudeUserSettingsAuthEnv: false,
      }
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
      }),
      {
        allowClaudeUserSettingsAuthEnv: false,
      }
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

  it('returns Codex custom provider launch args after API-key env application', async () => {
    applyConfiguredConnectionEnvMock.mockImplementation((env: NodeJS.ProcessEnv) => {
      env.OPENAI_API_KEY = 'stored-key';
      env.CODEX_API_KEY = 'stored-key';
      return Promise.resolve(env);
    });
    const customSettings = JSON.stringify({
      codex: {
        forced_login_method: 'api',
        agent_teams_custom_provider: {
          config_overrides: [
            'model_provider="agent_teams_custom"',
            'model_providers.agent_teams_custom.name="Agent Teams Custom"',
            'model_providers.agent_teams_custom.base_url="https://gateway.example.com/v1"',
            'model_providers.agent_teams_custom.wire_api="responses"',
            'model_providers.agent_teams_custom.env_key="CODEX_API_KEY"',
          ],
        },
      },
    });
    getConfiguredConnectionLaunchArgsMock.mockResolvedValue(['--settings', customSettings]);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      binaryPath: '/mock/claude-multimodel',
      providerId: 'codex',
    });

    expect(getConfiguredConnectionLaunchArgsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        OPENAI_API_KEY: 'stored-key',
        CODEX_API_KEY: 'stored-key',
      }),
      'codex',
      undefined,
      '/mock/claude-multimodel'
    );
    expect(result.providerArgs).toEqual(['--settings', customSettings]);
    expect(result.env.OPENAI_API_KEY).toBe('stored-key');
    expect(result.env.CODEX_API_KEY).toBe('stored-key');
  });

  it('passes Codex env refreshed by strict credential application into launch args and issue checks', async () => {
    applyConfiguredConnectionEnvMock.mockImplementation(
      (env: NodeJS.ProcessEnv, providerId: string) => {
        expect(providerId).toBe('codex');
        env.CODEX_CLI_PATH = '/Users/tester/.local/bin/codex';
        env.CODEX_HOME = '/Users/tester/.codex-custom';
        env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD = 'chatgpt';
        delete env.OPENAI_API_KEY;
        delete env.CODEX_API_KEY;
        return Promise.resolve(env);
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
    expect(getConfiguredConnectionIssuesMock).toHaveBeenCalledWith(connectionIssuesEnv, ['codex'], {
      codex: undefined,
    });
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
    const staleShellBinaryPath = path.join(process.cwd(), 'old shell opencode', 'opencode');
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(appManagedBinaryPath);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      shellEnv: {
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: staleShellBinaryPath,
        OPENCODE_BIN_PATH: staleShellBinaryPath,
        PATH: [path.dirname(staleShellBinaryPath), path.dirname(appManagedBinaryPath)].join(
          path.delimiter
        ),
      },
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
    expect(
      result.env.PATH?.split(path.delimiter).filter(
        (entry) => entry === path.dirname(appManagedBinaryPath)
      )
    ).toHaveLength(1);
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

  it('ignores an unsupported explicit OpenCode override and uses the verified runtime', async () => {
    const explicitBinaryPath = path.join(process.cwd(), 'old opencode', 'opencode');
    const verifiedBinaryPath = path.join(process.cwd(), 'managed opencode', 'opencode');
    isSupportedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(false);
    resolveVerifiedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(verifiedBinaryPath);

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
      env: {
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH: explicitBinaryPath,
      },
    });

    expect(isSupportedOpenCodeRuntimeBinaryPathMock).toHaveBeenCalledWith(explicitBinaryPath);
    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(verifiedBinaryPath);
    expect(result.env.OPENCODE_BIN_PATH).toBe(verifiedBinaryPath);
    expect(result.env.PATH?.split(path.delimiter)[0]).toBe(path.dirname(verifiedBinaryPath));
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

  it('restores Windows per-user base dirs when merged spawn envs dropped or emptied them', async () => {
    const originalPlatform = process.platform;
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
    try {
      const { buildProviderAwareCliEnv } =
        await import('../../../../src/main/services/runtime/providerAwareCliEnv');
      // An empty LOCALAPPDATA is what makes PowerShell children recreate
      // Microsoft/Windows/PowerShell/ModuleAnalysisCache relative to the cwd.
      const result = await buildProviderAwareCliEnv({ env: { LOCALAPPDATA: '' } });

      expect(result.env.LOCALAPPDATA?.trim()).toBeTruthy();
      expect(result.env.APPDATA?.trim()).toBeTruthy();
      expect(result.env.TEMP?.trim()).toBeTruthy();
      expect(result.env.TMP?.trim()).toBeTruthy();
    } finally {
      Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
    }
  });
});
