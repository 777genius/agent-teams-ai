// @vitest-environment node
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
const resolveVerifiedAppManagedOpenCodeRuntimeBinaryPathMock = vi.fn();
const resolveVerifiedAppManagedCodexRuntimeBinaryPathMock = vi.fn();

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
  resolveVerifiedAppManagedOpenCodeRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedOpenCodeRuntimeBinaryPathMock(),
}));

vi.mock('@features/codex-runtime-installer/main', () => ({
  resolveVerifiedAppManagedCodexRuntimeBinaryPath: () =>
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock(),
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
    resolveVerifiedAppManagedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(null);
    resolveVerifiedAppManagedCodexRuntimeBinaryPathMock.mockResolvedValue(null);
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

  it('injects the verified app-managed OpenCode binary for OpenCode launches', async () => {
    resolveVerifiedAppManagedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/opencode/current/opencode'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'opencode',
    });

    expect(applyConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH:
          '/Users/tester/App Support/runtimes/opencode/current/opencode',
      }),
      'opencode',
      undefined
    );
    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBe(
      '/Users/tester/App Support/runtimes/opencode/current/opencode'
    );
  });

  it('does not inject the app-managed OpenCode binary into non-OpenCode provider launches', async () => {
    resolveVerifiedAppManagedOpenCodeRuntimeBinaryPathMock.mockResolvedValue(
      '/Users/tester/App Support/runtimes/opencode/current/opencode'
    );

    const { buildProviderAwareCliEnv } =
      await import('../../../../src/main/services/runtime/providerAwareCliEnv');
    const result = await buildProviderAwareCliEnv({
      providerId: 'anthropic',
    });

    expect(result.env.CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH).toBeUndefined();
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
