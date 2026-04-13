// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>();

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
}));

describe('ProviderConnectionService', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;

  function createConfig(authMode: 'auto' | 'oauth' | 'api_key' = 'auto') {
    return {
      providerConnections: {
        anthropic: {
          authMode,
        },
        codex: {
          apiKeyBetaEnabled: false,
          authMode: 'oauth' as const,
        },
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCachedShellEnvMock.mockReturnValue({});
    delete process.env.OPENAI_API_KEY;
  });

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
      return;
    }

    process.env.OPENAI_API_KEY = originalOpenAiApiKey;
  });

  it('removes Anthropic environment credentials when OAuth mode is selected', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('oauth'),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv(
      {
        ANTHROPIC_API_KEY: 'direct-key',
        ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      },
      'anthropic'
    );

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('injects the stored Anthropic API key when api_key mode is selected', async () => {
    const lookupPreferred = vi.fn().mockResolvedValue({
      envVarName: 'ANTHROPIC_API_KEY',
      value: 'stored-key',
    });
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred,
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv(
      {
        ANTHROPIC_API_KEY: undefined,
        ANTHROPIC_AUTH_TOKEN: 'proxy-token',
      },
      'anthropic'
    );

    expect(lookupPreferred).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    expect(result.ANTHROPIC_API_KEY).toBe('stored-key');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('does not treat ANTHROPIC_AUTH_TOKEN as an API key in api_key mode', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv(
      {
        ANTHROPIC_AUTH_TOKEN: 'oauth-token',
      },
      'anthropic'
    );

    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
    expect(result.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
  });

  it('reports a missing Anthropic API key when api_key mode is selected', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    const issue = await service.getConfiguredConnectionIssue({}, 'anthropic');

    expect(issue).toContain('Anthropic API key mode is enabled');
    expect(issue).toContain('ANTHROPIC_API_KEY');
  });

  it('does not report a missing Anthropic API key once env is populated', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    const issue = await service.getConfiguredConnectionIssue(
      {
        ANTHROPIC_API_KEY: 'env-key',
      },
      'anthropic'
    );

    expect(issue).toBeNull();
  });

  it('augments PTY env with stored Anthropic API key without stripping auth token', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    const result = await service.augmentConfiguredConnectionEnv(
      {
        ANTHROPIC_AUTH_TOKEN: 'oauth-token',
      },
      'anthropic'
    );

    expect(result.ANTHROPIC_API_KEY).toBe('stored-key');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('oauth-token');
  });

  it('prefers stored API key status over environment detection', async () => {
    getCachedShellEnvMock.mockReturnValue({
      ANTHROPIC_API_KEY: 'shell-key',
    });

    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );

    const info = await service.getConnectionInfo('anthropic');

    expect(info).toMatchObject({
      supportsOAuth: true,
      supportsApiKey: true,
      configuredAuthMode: 'auto',
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel: 'Stored in app',
    });
  });

  it('does not report ANTHROPIC_AUTH_TOKEN as an API key credential source', async () => {
    getCachedShellEnvMock.mockReturnValue({
      ANTHROPIC_AUTH_TOKEN: 'oauth-token',
    });

    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );

    const info = await service.getConnectionInfo('anthropic');

    expect(info.apiKeyConfigured).toBe(false);
    expect(info.apiKeySource).toBeNull();
    expect(info.apiKeySourceLabel).toBeNull();
  });

  it('keeps Codex API key beta opt-in disabled by default', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );

    const info = await service.getConnectionInfo('codex');

    expect(info).toMatchObject({
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: [],
      configuredAuthMode: null,
      apiKeyBetaAvailable: true,
      apiKeyBetaEnabled: false,
      apiKeyConfigured: false,
    });
  });

  it('injects OPENAI_API_KEY and selects the API backend when Codex API key mode is enabled', async () => {
    const lookupPreferred = vi.fn().mockResolvedValue({
      envVarName: 'OPENAI_API_KEY',
      value: 'openai-stored-key',
    });
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred,
      } as never,
      {
        getConfig: () => ({
          providerConnections: {
            anthropic: {
              authMode: 'auto',
            },
            codex: {
              apiKeyBetaEnabled: true,
              authMode: 'api_key',
            },
          },
        }),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: undefined,
        CLAUDE_CODE_CODEX_BACKEND: 'auto',
      },
      'codex'
    );

    expect(lookupPreferred).toHaveBeenCalledWith('OPENAI_API_KEY');
    expect(result.OPENAI_API_KEY).toBe('openai-stored-key');
    expect(result.CLAUDE_CODE_CODEX_BACKEND).toBe('api');
    expect(result.CLAUDE_CODE_CODEX_API_KEY_BETA).toBe('1');
  });

  it('forces the Codex adapter and strips OPENAI_API_KEY in OAuth mode', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => ({
          providerConnections: {
            anthropic: {
              authMode: 'auto',
            },
            codex: {
              apiKeyBetaEnabled: true,
              authMode: 'oauth',
            },
          },
        }),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'shell-openai-key',
        CLAUDE_CODE_CODEX_BACKEND: 'auto',
      },
      'codex'
    );

    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.CLAUDE_CODE_CODEX_BACKEND).toBe('adapter');
    expect(result.CLAUDE_CODE_CODEX_API_KEY_BETA).toBe('1');
  });

  it('reports a missing Codex API key when beta api_key mode is enabled', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => ({
          providerConnections: {
            anthropic: {
              authMode: 'auto',
            },
            codex: {
              apiKeyBetaEnabled: true,
              authMode: 'api_key',
            },
          },
        }),
      } as never
    );

    const issue = await service.getConfiguredConnectionIssue({}, 'codex');

    expect(issue).toContain('Codex API key mode is enabled');
    expect(issue).toContain('OPENAI_API_KEY');
  });

  it('augments PTY env for Codex without deleting an existing OPENAI_API_KEY in oauth mode', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => ({
          providerConnections: {
            anthropic: {
              authMode: 'auto',
            },
            codex: {
              apiKeyBetaEnabled: true,
              authMode: 'oauth',
            },
          },
        }),
      } as never
    );

    const result = await service.augmentConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'shell-key',
      },
      'codex'
    );

    expect(result.OPENAI_API_KEY).toBe('shell-key');
    expect(result.CLAUDE_CODE_CODEX_BACKEND).toBe('adapter');
    expect(result.CLAUDE_CODE_CODEX_API_KEY_BETA).toBe('1');
  });
});
