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

vi.mock('@main/utils/cliEnv', () => ({
  buildEnrichedEnv: (...args: Parameters<typeof buildEnrichedEnvMock>) => buildEnrichedEnvMock(...args),
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
          codex: 'adapter',
        },
      },
    }),
  },
}));

vi.mock('../../../../src/main/services/runtime/ProviderConnectionService', () => ({
  providerConnectionService: {
    augmentConfiguredConnectionEnv: (...args: Parameters<typeof augmentConfiguredConnectionEnvMock>) =>
      augmentConfiguredConnectionEnvMock(...args),
    augmentAllConfiguredConnectionEnv: (...args: Parameters<typeof augmentAllConfiguredConnectionEnvMock>) =>
      augmentAllConfiguredConnectionEnvMock(...args),
    applyConfiguredConnectionEnv: (...args: Parameters<typeof applyConfiguredConnectionEnvMock>) =>
      applyConfiguredConnectionEnvMock(...args),
    applyAllConfiguredConnectionEnv: (...args: Parameters<typeof applyAllConfiguredConnectionEnvMock>) =>
      applyAllConfiguredConnectionEnvMock(...args),
    getConfiguredConnectionIssues: (...args: Parameters<typeof getConfiguredConnectionIssuesMock>) =>
      getConfiguredConnectionIssuesMock(...args),
  },
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
    getConfiguredConnectionIssuesMock.mockResolvedValue({});
  });

  it('builds provider-pinned CLI env and returns provider-specific issues', async () => {
    getConfiguredConnectionIssuesMock.mockResolvedValue({
      anthropic: 'missing key',
    });

    const { buildProviderAwareCliEnv } = await import(
      '../../../../src/main/services/runtime/providerAwareCliEnv'
    );
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
      'anthropic'
    );
    expect(result.connectionIssues).toEqual({
      anthropic: 'missing key',
    });
  });

  it('builds shared env for generic CLI launches when no provider is specified', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '../../../../src/main/services/runtime/providerAwareCliEnv'
    );
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
  });

  it('uses non-destructive credential augmentation for PTY-style envs', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '../../../../src/main/services/runtime/providerAwareCliEnv'
    );
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
  });

  it('preserves caller-provided HOME and USERPROFILE overrides', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '../../../../src/main/services/runtime/providerAwareCliEnv'
    );
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
      'anthropic'
    );
    expect(result.env.HOME).toBe('/Users/electron-home');
    expect(result.env.USERPROFILE).toBe('/Users/electron-home');
  });

  it('preserves explicit backend overrides passed by the caller', async () => {
    const { buildProviderAwareCliEnv } = await import(
      '../../../../src/main/services/runtime/providerAwareCliEnv'
    );
    const result = await buildProviderAwareCliEnv({
      connectionMode: 'augment',
      env: {
        CLAUDE_CODE_GEMINI_BACKEND: 'api',
      },
    });

    expect(augmentAllConfiguredConnectionEnvMock).toHaveBeenCalledWith(
      expect.objectContaining({
        CLAUDE_CODE_GEMINI_BACKEND: 'api',
        CLAUDE_CODE_CODEX_BACKEND: 'adapter',
      })
    );
    expect(result.env.CLAUDE_CODE_GEMINI_BACKEND).toBe('api');
    expect(result.env.CLAUDE_CODE_CODEX_BACKEND).toBe('adapter');
  });
});
