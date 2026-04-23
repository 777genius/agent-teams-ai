// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>();

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
}));

describe('ProviderConnectionService', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalCodexApiKey = process.env.CODEX_API_KEY;

  function createConfig(authMode: 'auto' | 'oauth' | 'api_key' = 'auto') {
    return {
      providerConnections: {
        anthropic: {
          authMode,
        },
        codex: {
          preferredAuthMode: 'auto' as const,
        },
      },
      runtime: {
        providerBackends: {
          gemini: 'auto' as const,
          codex: 'codex-native' as const,
        },
      },
    };
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCachedShellEnvMock.mockReturnValue({});
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
  });

  afterEach(() => {
    if (originalOpenAiApiKey === undefined) {
      delete process.env.OPENAI_API_KEY;
    } else {
      process.env.OPENAI_API_KEY = originalOpenAiApiKey;
    }

    if (originalCodexApiKey === undefined) {
      delete process.env.CODEX_API_KEY;
    } else {
      process.env.CODEX_API_KEY = originalCodexApiKey;
    }
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

  it('treats a stored Anthropic API key as configured even when env is empty', async () => {
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

    const issue = await service.getConfiguredConnectionIssue({}, 'anthropic');

    expect(lookupPreferred).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
    expect(issue).toBeNull();
  });

  it('can swap to the shared API key service after construction', async () => {
    const staleApiKeyService = {
      lookupPreferred: vi.fn().mockResolvedValue(null),
    };
    const sharedApiKeyService = {
      lookupPreferred: vi.fn().mockResolvedValue({
        envVarName: 'ANTHROPIC_API_KEY',
        value: 'shared-key',
      }),
    };
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      staleApiKeyService as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    expect(await service.getConfiguredConnectionIssue({}, 'anthropic')).toContain(
      'Anthropic API key mode is enabled'
    );

    service.setApiKeyService(sharedApiKeyService as never);

    expect(await service.getConfiguredConnectionIssue({}, 'anthropic')).toBeNull();
    expect(sharedApiKeyService.lookupPreferred).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('prefers stored API key status over environment detection for Anthropic', async () => {
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

  it('exposes Codex as native-only API-key runtime', async () => {
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
      supportsOAuth: false,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
      configuredAuthMode: 'auto',
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
    });
  });

  it('mirrors a stored OpenAI key into CODEX_API_KEY for native Codex launches', async () => {
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
        getConfig: () => createConfig('auto'),
      } as never
    );

    const result = await service.applyConfiguredConnectionEnv({}, 'codex');

    expect(lookupPreferred).toHaveBeenCalledWith('OPENAI_API_KEY');
    expect(result.OPENAI_API_KEY).toBe('openai-stored-key');
    expect(result.CODEX_API_KEY).toBe('openai-stored-key');
  });

  it('keeps ambient OpenAI credentials for native Codex launches', async () => {
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

    const result = await service.applyConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'shell-openai-key',
      },
      'codex'
    );

    expect(result.OPENAI_API_KEY).toBe('shell-openai-key');
    expect(result.CODEX_API_KEY).toBe('shell-openai-key');
  });

  it('accepts CODEX_API_KEY as the native external credential source for Codex', async () => {
    getCachedShellEnvMock.mockReturnValue({
      CODEX_API_KEY: 'native-key',
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

    const info = await service.getConnectionInfo('codex');
    const issue = await service.getConfiguredConnectionIssue(
      {
        CODEX_API_KEY: 'native-key',
      },
      'codex'
    );

    expect(info.apiKeyConfigured).toBe(true);
    expect(info.apiKeySource).toBe('environment');
    expect(info.apiKeySourceLabel).toBe('Detected from CODEX_API_KEY');
    expect(issue).toBeNull();
  });

  it('reports a missing native Codex credential when neither OPENAI_API_KEY nor CODEX_API_KEY exist', async () => {
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

    const issue = await service.getConfiguredConnectionIssue({}, 'codex');

    expect(issue).toContain('Codex native requires OPENAI_API_KEY or CODEX_API_KEY');
  });

  it('reports a pinned Codex ChatGPT mode as a missing active CLI login instead of flattening it to generic auth advice', async () => {
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        launchReadinessState: 'missing_auth',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: false,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const issue = await service.getConfiguredConnectionIssue(
      {
        OPENAI_API_KEY: 'env-key',
      },
      'codex'
    );

    expect(issue).toBe(
      'Codex ChatGPT account mode is selected, but Codex CLI reports no active ChatGPT login. Connect ChatGPT again or switch Codex auth mode to API key.'
    );
  });

  it('mentions local Codex account artifacts when pinned ChatGPT mode has no active managed session', async () => {
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        launchReadinessState: 'missing_auth',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const issue = await service.getConfiguredConnectionIssue(
      {
        OPENAI_API_KEY: 'env-key',
      },
      'codex'
    );

    expect(issue).toBe(
      'Codex ChatGPT account mode is selected, but Codex CLI reports no active ChatGPT login. Local Codex account data exists, but no active managed session is selected. Connect ChatGPT again or switch Codex auth mode to API key.'
    );
  });

  it('asks for reconnect when pinned ChatGPT mode still has a locally selected Codex account', async () => {
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
        launchReadinessState: 'missing_auth',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        localActiveChatgptAccountPresent: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const issue = await service.getConfiguredConnectionIssue(
      {
        OPENAI_API_KEY: 'env-key',
      },
      'codex'
    );

    expect(issue).toBe(
      'Codex ChatGPT account mode is selected, and Codex has a locally selected ChatGPT account, but the current session needs reconnect. Reconnect ChatGPT or switch Codex auth mode to API key.'
    );
  });

  it('reports a pinned Codex API-key mode as missing only the API key credential', async () => {
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'api_key',
        effectiveAuthMode: null,
        launchAllowed: false,
        launchIssueMessage: 'Add OPENAI_API_KEY or CODEX_API_KEY to use Codex API key mode.',
        launchReadinessState: 'missing_auth',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        apiKey: {
          available: false,
          source: null,
          sourceLabel: null,
        },
        requiresOpenaiAuth: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const issue = await service.getConfiguredConnectionIssue({}, 'codex');

    expect(issue).toBe(
      'Codex API key mode is selected, but no OPENAI_API_KEY or CODEX_API_KEY credential is available. Add one before launching Codex.'
    );
  });

  it('augments PTY env for native Codex without dropping existing OpenAI credentials', async () => {
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

    const result = await service.augmentConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'shell-key',
      },
      'codex'
    );

    expect(result.OPENAI_API_KEY).toBe('shell-key');
    expect(result.CODEX_API_KEY).toBe('shell-key');
  });

  it('returns a chatgpt forced_login_method override for managed Codex launches', async () => {
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: 'chatgpt',
        launchAllowed: true,
        launchIssueMessage: null,
        launchReadinessState: 'ready_chatgpt',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from OPENAI_API_KEY',
        },
        requiresOpenaiAuth: true,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const args = await service.getConfiguredConnectionLaunchArgs(
      {
        OPENAI_API_KEY: undefined,
        CODEX_API_KEY: undefined,
      },
      'codex',
      undefined,
      '/mock/claude-multimodel'
    );

    expect(args).toEqual(['--settings', '{"codex":{"forced_login_method":"chatgpt"}}']);
  });

  it('returns an api forced_login_method override for Codex API-key launches', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'OPENAI_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );

    const args = await service.getConfiguredConnectionLaunchArgs(
      {
        OPENAI_API_KEY: 'stored-key',
        CODEX_API_KEY: 'stored-key',
      },
      'codex',
      undefined,
      '/mock/claude-multimodel'
    );

    expect(args).toEqual(['--settings', '{"codex":{"forced_login_method":"api"}}']);
  });

  it('keeps codex exec style config overrides for direct Codex binary launches', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'OPENAI_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );

    const args = await service.getConfiguredConnectionLaunchArgs(
      {
        OPENAI_API_KEY: 'stored-key',
        CODEX_API_KEY: 'stored-key',
      },
      'codex',
      undefined,
      '/usr/local/bin/codex'
    );

    expect(args).toEqual(['-c', 'forced_login_method="api"']);
  });
});
