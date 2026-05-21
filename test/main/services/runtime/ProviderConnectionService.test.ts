// @vitest-environment node
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

const getCachedShellEnvMock = vi.fn<() => NodeJS.ProcessEnv | null>();
const execCliMock = vi.fn<
  (
    binaryPath: string | null,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      windowsHide?: boolean;
      maxBuffer?: number;
    }
  ) => Promise<{ stdout: string; stderr: string }>
>();

vi.mock('@main/utils/shellEnv', () => ({
  getCachedShellEnv: () => getCachedShellEnvMock(),
}));

vi.mock('@main/utils/childProcess', () => ({
  execCli: (
    binaryPath: string | null,
    args: string[],
    options?: {
      env?: NodeJS.ProcessEnv;
      timeout?: number;
      windowsHide?: boolean;
      maxBuffer?: number;
    }
  ) => execCliMock(binaryPath, args, options),
}));

describe('ProviderConnectionService', () => {
  const originalOpenAiApiKey = process.env.OPENAI_API_KEY;
  const originalCodexApiKey = process.env.CODEX_API_KEY;
  const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;
  const originalAnthropicAuthToken = process.env.ANTHROPIC_AUTH_TOKEN;
  const originalAnthropicBaseUrl = process.env.ANTHROPIC_BASE_URL;

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

  function createCodexSnapshot(
    overrides: Partial<CodexAccountSnapshotDto> = {}
  ): CodexAccountSnapshotDto {
    return {
      preferredAuthMode: 'auto',
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
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: false,
      localAccountArtifactsPresent: true,
      localActiveChatgptAccountPresent: true,
      runtimeContext: {
        binaryPath: '/opt/codex/bin/codex',
        codexHome: '/Users/tester/.codex-custom',
      },
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: '2026-04-20T00:00:00.000Z',
      ...overrides,
    };
  }

  function createCodexRuntimeMissingSnapshot(
    overrides: Partial<CodexAccountSnapshotDto> = {}
  ): CodexAccountSnapshotDto {
    return createCodexSnapshot({
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Codex CLI not found',
      launchReadinessState: 'runtime_missing',
      appServerState: 'runtime-missing',
      appServerStatusMessage: 'Codex CLI not found',
      managedAccount: null,
      requiresOpenaiAuth: null,
      localAccountArtifactsPresent: false,
      localActiveChatgptAccountPresent: false,
      runtimeContext: {
        binaryPath: null,
        codexHome: null,
      },
      ...overrides,
    });
  }

  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
    getCachedShellEnvMock.mockReturnValue({});
    execCliMock.mockResolvedValue({ stdout: 'Logged in using ChatGPT', stderr: '' });
    delete process.env.OPENAI_API_KEY;
    delete process.env.CODEX_API_KEY;
    delete process.env.ANTHROPIC_API_KEY;
    delete process.env.ANTHROPIC_AUTH_TOKEN;
    delete process.env.ANTHROPIC_BASE_URL;
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

    if (originalAnthropicApiKey === undefined) {
      delete process.env.ANTHROPIC_API_KEY;
    } else {
      process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
    }

    if (originalAnthropicAuthToken === undefined) {
      delete process.env.ANTHROPIC_AUTH_TOKEN;
    } else {
      process.env.ANTHROPIC_AUTH_TOKEN = originalAnthropicAuthToken;
    }

    if (originalAnthropicBaseUrl === undefined) {
      delete process.env.ANTHROPIC_BASE_URL;
    } else {
      process.env.ANTHROPIC_BASE_URL = originalAnthropicBaseUrl;
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

  it('preserves Anthropic-compatible bearer token env even when OAuth mode is selected', async () => {
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
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      },
      'anthropic'
    );

    expect(result.ANTHROPIC_BASE_URL).toBe('http://localhost:11434');
    expect(result.ANTHROPIC_API_KEY).toBe('');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
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

  it('does not replace Anthropic-compatible bearer token env with stored API key mode credentials', async () => {
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
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      },
      'anthropic'
    );

    expect(lookupPreferred).not.toHaveBeenCalled();
    expect(result.ANTHROPIC_API_KEY).toBe('');
    expect(result.ANTHROPIC_AUTH_TOKEN).toBe('ollama');
  });

  it('does not decrypt stored Anthropic keys when metadata-only env building is requested', async () => {
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

    const result = await service.applyConfiguredConnectionEnv({}, 'anthropic', undefined, {
      allowStoredApiKeyDecryption: false,
    });

    expect(lookupPreferred).not.toHaveBeenCalled();
    expect(result.ANTHROPIC_API_KEY).toBeUndefined();
  });

  it('injects stored Gemini API keys for runtime launches', async () => {
    const lookupPreferred = vi.fn().mockResolvedValue({
      envVarName: 'GEMINI_API_KEY',
      value: 'gemini-stored-key',
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

    const result = await service.applyConfiguredConnectionEnv({}, 'gemini');

    expect(lookupPreferred).toHaveBeenCalledWith('GEMINI_API_KEY');
    expect(result.GEMINI_API_KEY).toBe('gemini-stored-key');
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

  it('does not report a missing Anthropic API key for Anthropic-compatible bearer token env', async () => {
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
        ANTHROPIC_BASE_URL: 'http://localhost:11434',
        ANTHROPIC_API_KEY: '',
        ANTHROPIC_AUTH_TOKEN: 'ollama',
      },
      'anthropic'
    );

    expect(issue).toBeNull();
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

  it('does not report stored Anthropic API key mode as connected until runtime verifies the API key', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const verifyAnthropicApiKey = vi.fn().mockResolvedValue({ state: 'unknown' });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never,
      undefined,
      verifyAnthropicApiKey
    );

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      statusMessage: 'Connected via Anthropic subscription',
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusMessage:
        'Anthropic API key is configured, but has not been verified by the runtime yet.',
      connection: {
        configuredAuthMode: 'api_key',
        apiKeyConfigured: true,
        apiKeySource: 'stored',
        apiKeySourceLabel: 'Stored in app',
      },
    });
    expect(verifyAnthropicApiKey).toHaveBeenCalledWith('stored-key', null);
  });

  it('reports Anthropic API key mode as connected after direct API verification succeeds', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const verifyAnthropicApiKey = vi.fn().mockResolvedValue({ state: 'valid', status: 200 });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never,
      undefined,
      verifyAnthropicApiKey
    );

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      statusMessage: 'Connected via Anthropic subscription',
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      verificationState: 'verified',
      statusMessage: 'Connected via API key',
      connection: {
        configuredAuthMode: 'api_key',
        apiKeyConfigured: true,
        apiKeySource: 'stored',
        apiKeySourceLabel: 'Stored in app',
      },
    });
    expect(verifyAnthropicApiKey).toHaveBeenCalledTimes(1);
  });

  it('verifies Anthropic API keys against ANTHROPIC_BASE_URL when configured', async () => {
    getCachedShellEnvMock.mockReturnValue({
      ANTHROPIC_BASE_URL: 'https://gateway.example/anthropic/',
    });
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const fetchMock = vi.fn(async () => new Response('{}', { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    try {
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

      await service.enrichProviderStatus({
        providerId: 'anthropic',
        displayName: 'Anthropic',
        supported: true,
        authenticated: true,
        authMethod: 'claude.ai',
        verificationState: 'verified',
        statusMessage: 'Connected via Anthropic subscription',
        models: ['claude-sonnet-4-6'],
        canLoginFromUi: true,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
        },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      } as never);

      expect(fetchMock).toHaveBeenCalledWith(
        'https://gateway.example/anthropic/v1/models',
        expect.objectContaining({
          headers: expect.objectContaining({
            'x-api-key': 'stored-key',
            'anthropic-version': '2023-06-01',
          }),
          method: 'GET',
        })
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reports an invalid Anthropic API key after direct API verification fails', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const verifyAnthropicApiKey = vi.fn().mockResolvedValue({
      state: 'invalid',
      status: 401,
      errorType: 'authentication_error',
      errorMessage: 'invalid x-api-key',
    });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never,
      undefined,
      verifyAnthropicApiKey
    );

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      statusMessage: 'Connected via Anthropic subscription',
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'error',
      statusMessage: 'Anthropic API key verification failed: invalid x-api-key',
    });
  });

  it('reports Anthropic API key mode as connected after runtime verifies the API key', async () => {
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

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'api_key',
      verificationState: 'verified',
      statusMessage: null,
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: true,
      authMethod: 'api_key',
      verificationState: 'verified',
      statusMessage: 'Connected via API key',
      connection: {
        configuredAuthMode: 'api_key',
        apiKeyConfigured: true,
        apiKeySource: 'stored',
        apiKeySourceLabel: 'Stored in app',
      },
    });
  });

  it('treats Anthropic API-key helper runtime auth as verified API-key mode', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const verifyAnthropicApiKey = vi.fn().mockResolvedValue({ state: 'unknown' });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never,
      undefined,
      verifyAnthropicApiKey
    );

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'api_key_helper',
      verificationState: 'verified',
      statusMessage: null,
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: true,
      authMethod: 'api_key_helper',
      verificationState: 'verified',
      statusMessage: 'Connected via API key',
    });
    expect(verifyAnthropicApiKey).not.toHaveBeenCalled();
  });

  it('does not treat a subscription session as connected when Anthropic API key mode has no key', async () => {
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

    const status = await service.enrichProviderStatus({
      providerId: 'anthropic',
      displayName: 'Anthropic',
      supported: true,
      authenticated: true,
      authMethod: 'claude.ai',
      verificationState: 'verified',
      statusMessage: 'Connected via Anthropic subscription',
      models: ['claude-sonnet-4-6'],
      canLoginFromUi: true,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: { mcp: 'unsupported', skills: 'unsupported', plugins: 'unsupported' },
      },
      selectedBackendId: null,
      resolvedBackendId: null,
      availableBackends: [],
      externalRuntimeDiagnostics: [],
      backend: null,
      connection: null,
    } as never);

    expect(status).toMatchObject({
      authenticated: false,
      authMethod: null,
      verificationState: 'unknown',
      statusMessage: 'API key mode is selected, but no Anthropic API credential is available yet.',
      connection: {
        configuredAuthMode: 'api_key',
        apiKeyConfigured: false,
      },
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

  it('passes Codex runtime context while clearing API keys for ChatGPT launches', async () => {
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
          available: false,
          source: null,
          sourceLabel: null,
        },
        requiresOpenaiAuth: false,
        runtimeContext: {
          binaryPath: '/opt/codex/bin/codex',
          codexHome: '/Users/tester/.codex-custom',
        },
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const result = await service.applyConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'ambient-openai-key',
        CODEX_API_KEY: 'ambient-codex-key',
      },
      'codex'
    );

    expect(result.OPENAI_API_KEY).toBeUndefined();
    expect(result.CODEX_API_KEY).toBeUndefined();
    expect(result.CODEX_CLI_PATH).toBe('/opt/codex/bin/codex');
    expect(result.CODEX_HOME).toBe('/Users/tester/.codex-custom');
  });

  it('keeps Codex runtime context when API-key mode mirrors credentials', async () => {
    const lookupPreferred = vi.fn().mockResolvedValue({
      envVarName: 'OPENAI_API_KEY',
      value: 'stored-openai-key',
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

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'api_key',
        effectiveAuthMode: 'api_key',
        launchAllowed: true,
        launchIssueMessage: null,
        launchReadinessState: 'ready_api_key',
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        apiKey: {
          available: true,
          source: 'stored',
          sourceLabel: 'Stored in app',
        },
        requiresOpenaiAuth: false,
        runtimeContext: {
          binaryPath: '/opt/codex/bin/codex.cmd',
          codexHome: 'C:\\Users\\tester\\.codex',
        },
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    const result = await service.applyConfiguredConnectionEnv({}, 'codex');

    expect(result.OPENAI_API_KEY).toBe('stored-openai-key');
    expect(result.CODEX_API_KEY).toBe('stored-openai-key');
    expect(result.CODEX_CLI_PATH).toBe('/opt/codex/bin/codex.cmd');
    expect(result.CODEX_HOME).toBe('C:\\Users\\tester\\.codex');
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

  it('refreshes a runtime-missing Codex snapshot before blocking launch preflight', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const runtimeMissingSnapshot = createCodexRuntimeMissingSnapshot();
    const refreshSnapshot = vi.fn().mockResolvedValue(
      createCodexSnapshot({
        effectiveAuthMode: 'api_key',
        launchReadinessState: 'ready_api_key',
        managedAccount: null,
      })
    );

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );
    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue(runtimeMissingSnapshot),
      refreshSnapshot,
    });

    const issue = await service.getConfiguredConnectionIssue(
      {
        CODEX_API_KEY: 'native-key',
      },
      'codex'
    );

    expect(issue).toBeNull();
    expect(refreshSnapshot).toHaveBeenCalledWith({ forceRefreshToken: true });
  });

  it('refreshes a runtime-missing Codex snapshot before mutating strict launch env', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const refreshSnapshot = vi.fn().mockResolvedValue(createCodexSnapshot());
    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );
    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue(createCodexRuntimeMissingSnapshot()),
      refreshSnapshot,
    });

    const env = await service.applyConfiguredConnectionEnv(
      {
        OPENAI_API_KEY: 'ambient-openai-key',
        CODEX_API_KEY: 'ambient-codex-key',
      },
      'codex'
    );

    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.CODEX_API_KEY).toBeUndefined();
    expect(env.CODEX_CLI_PATH).toBe('/opt/codex/bin/codex');
    expect(env.CODEX_HOME).toBe('/Users/tester/.codex-custom');
    expect(env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD).toBe('chatgpt');
    expect(refreshSnapshot).toHaveBeenCalledWith({ forceRefreshToken: true });
  });

  it('refreshes a runtime-missing Codex snapshot before augmenting API-key launch env', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const refreshSnapshot = vi.fn().mockResolvedValue(
      createCodexSnapshot({
        preferredAuthMode: 'api_key',
        effectiveAuthMode: 'api_key',
        launchReadinessState: 'ready_api_key',
        managedAccount: null,
        apiKey: {
          available: true,
          source: 'environment',
          sourceLabel: 'Detected from CODEX_API_KEY',
        },
      })
    );
    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );
    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue(createCodexRuntimeMissingSnapshot()),
      refreshSnapshot,
    });

    const env = await service.augmentConfiguredConnectionEnv(
      {
        CODEX_API_KEY: 'native-key',
      },
      'codex'
    );

    expect(env.OPENAI_API_KEY).toBe('native-key');
    expect(env.CODEX_API_KEY).toBe('native-key');
    expect(env.CODEX_CLI_PATH).toBe('/opt/codex/bin/codex');
    expect(env.CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD).toBe('api');
    expect(refreshSnapshot).toHaveBeenCalledWith({ forceRefreshToken: true });
  });

  it('keeps the original runtime-missing issue when the forced Codex snapshot refresh fails', async () => {
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
      getSnapshot: vi.fn().mockResolvedValue(createCodexRuntimeMissingSnapshot()),
      refreshSnapshot: vi.fn().mockRejectedValue(new Error('refresh failed')),
    });

    const issue = await service.getConfiguredConnectionIssue({}, 'codex');

    expect(issue).toBe('Codex CLI not found');
  });

  it('refreshes a runtime-missing Codex snapshot before building forced launch args', async () => {
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
      getSnapshot: vi.fn().mockResolvedValue(createCodexRuntimeMissingSnapshot()),
      refreshSnapshot: vi.fn().mockResolvedValue(createCodexSnapshot()),
    });

    const args = await service.getConfiguredConnectionLaunchArgs(
      {},
      'codex',
      'codex-native',
      'codex'
    );

    expect(args).toEqual(['-c', 'forced_login_method="chatgpt"']);
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

  it('does not block launch when the Codex app-server freshly verifies ChatGPT auth', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const loginStatusChecker = vi.fn().mockResolvedValue({
      status: 'not_logged_in',
      detail: 'Not logged in',
    });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never,
      loginStatusChecker
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
          available: false,
          source: null,
          sourceLabel: null,
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        localActiveChatgptAccountPresent: true,
        runtimeContext: {
          binaryPath: '/opt/codex/bin/codex',
          codexHome: '/Users/tester/.codex-custom',
        },
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    await expect(
      service.getConfiguredConnectionIssue(
        {
          OPENAI_API_KEY: 'ambient-openai-key',
          CODEX_API_KEY: 'ambient-codex-key',
        },
        'codex'
      )
    ).resolves.toBeNull();

    expect(loginStatusChecker).not.toHaveBeenCalled();
  });

  it('verifies degraded Codex cmd shim login status through the shared CLI launcher', async () => {
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
        launchReadinessState: 'warning_degraded_but_launchable',
        appServerState: 'degraded',
        appServerStatusMessage: 'Using cached ChatGPT account after transient app-server failure.',
        managedAccount: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        apiKey: {
          available: false,
          source: null,
          sourceLabel: null,
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        localActiveChatgptAccountPresent: true,
        runtimeContext: {
          binaryPath: '/opt/codex/bin/codex.cmd',
          codexHome: '/Users/tester/.codex-custom',
        },
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        updatedAt: '2026-04-20T00:00:00.000Z',
      }),
    } as never);

    await expect(service.getConfiguredConnectionIssue({}, 'codex')).resolves.toBeNull();

    expect(execCliMock).toHaveBeenCalledWith(
      '/opt/codex/bin/codex.cmd',
      ['-c', 'forced_login_method="chatgpt"', 'login', 'status'],
      expect.objectContaining({
        timeout: 5_000,
        windowsHide: true,
        maxBuffer: 128 * 1024,
        env: expect.objectContaining({
          CODEX_CLI_PATH: '/opt/codex/bin/codex.cmd',
          CODEX_HOME: '/Users/tester/.codex-custom',
          CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
        }),
      })
    );
  });

  it('blocks launch when managed ChatGPT is selected but degraded exact runtime login is logged out', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const loginStatusChecker = vi.fn().mockResolvedValue({
      status: 'not_logged_in',
      detail: 'Not logged in',
    });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never,
      loginStatusChecker
    );

    service.setCodexAccountFeature({
      getSnapshot: vi.fn().mockResolvedValue({
        preferredAuthMode: 'chatgpt',
        effectiveAuthMode: 'chatgpt',
        launchAllowed: true,
        launchIssueMessage: null,
        launchReadinessState: 'warning_degraded_but_launchable',
        appServerState: 'degraded',
        appServerStatusMessage: 'Using cached ChatGPT account after transient app-server failure.',
        managedAccount: {
          type: 'chatgpt',
          email: 'user@example.com',
          planType: 'pro',
        },
        apiKey: {
          available: false,
          source: null,
          sourceLabel: null,
        },
        requiresOpenaiAuth: true,
        localAccountArtifactsPresent: true,
        localActiveChatgptAccountPresent: true,
        runtimeContext: {
          binaryPath: '/opt/codex/bin/codex',
          codexHome: '/Users/tester/.codex-custom',
        },
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
        OPENAI_API_KEY: 'ambient-openai-key',
        CODEX_API_KEY: 'ambient-codex-key',
      },
      'codex'
    );

    expect(issue).toContain('Codex CLI login status is not active');
    expect(issue).toContain('Reconnect ChatGPT');
    expect(loginStatusChecker).toHaveBeenCalledWith({
      binaryPath: '/opt/codex/bin/codex',
      env: expect.objectContaining({
        CODEX_CLI_PATH: '/opt/codex/bin/codex',
        CODEX_HOME: '/Users/tester/.codex-custom',
        CLAUDE_CODE_CODEX_FORCED_LOGIN_METHOD: 'chatgpt',
      }),
    });
    expect(loginStatusChecker.mock.calls[0]?.[0].env.OPENAI_API_KEY).toBeUndefined();
    expect(loginStatusChecker.mock.calls[0]?.[0].env.CODEX_API_KEY).toBeUndefined();
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

  it('prefers the orchestrator Codex model catalog over the legacy direct app-server fallback', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const directCatalog = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-04-28T00:00:00.000Z',
      staleAt: '2026-04-28T00:10:00.000Z',
      defaultModelId: 'gpt-5.4-mini',
      defaultLaunchModel: 'gpt-5.4-mini',
      models: [],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );
    service.setCodexModelCatalogFeature({ getCatalog: directCatalog } as never);

    const enriched = await service.enrichProviderStatus({
      providerId: 'codex',
      displayName: 'Codex',
      supported: true,
      authenticated: true,
      authMethod: 'chatgpt',
      verificationState: 'verified',
      models: ['gpt-5.4'],
      modelCatalog: {
        schemaVersion: 1,
        providerId: 'codex',
        source: 'app-server',
        status: 'ready',
        fetchedAt: '2026-04-28T00:00:00.000Z',
        staleAt: '2026-04-28T00:10:00.000Z',
        defaultModelId: 'gpt-5.4',
        defaultLaunchModel: 'gpt-5.4',
        models: [
          {
            id: 'gpt-5.4',
            launchModel: 'gpt-5.4',
            displayName: 'GPT-5.4',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'medium',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: true,
            upgrade: false,
            source: 'app-server',
          },
          {
            id: 'gpt-5.5',
            launchModel: 'gpt-5.5',
            displayName: 'GPT-5.5',
            hidden: false,
            supportedReasoningEfforts: ['low', 'medium', 'high', 'xhigh'],
            defaultReasoningEffort: 'high',
            inputModalities: ['text', 'image'],
            supportsPersonality: false,
            isDefault: false,
            upgrade: false,
            source: 'app-server',
          },
        ],
        diagnostics: {
          configReadState: 'skipped',
          appServerState: 'healthy',
        },
      },
      runtimeCapabilities: {
        modelCatalog: { dynamic: true, source: 'app-server' },
      },
      canLoginFromUi: false,
      capabilities: {
        teamLaunch: true,
        oneShot: true,
        extensions: {
          plugins: { status: 'unsupported', ownership: 'shared' },
          mcp: { status: 'supported', ownership: 'shared' },
          skills: { status: 'supported', ownership: 'shared' },
          apiKeys: { status: 'supported', ownership: 'shared' },
        },
      },
    });

    expect(directCatalog).not.toHaveBeenCalled();
    expect(enriched.models).toEqual(['gpt-5.4', 'gpt-5.5']);
    expect(enriched.modelCatalog?.defaultLaunchModel).toBe('gpt-5.4');
    expect(enriched.runtimeCapabilities?.modelCatalog).toEqual({
      dynamic: true,
      source: 'app-server',
    });
  });

  it('skips Codex catalog hydration when summary enrichment disables catalog loading', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');
    const directCatalog = vi.fn().mockResolvedValue({
      schemaVersion: 1,
      providerId: 'codex',
      source: 'app-server',
      status: 'ready',
      fetchedAt: '2026-04-28T00:00:00.000Z',
      staleAt: '2026-04-28T00:10:00.000Z',
      defaultModelId: 'gpt-5.4',
      defaultLaunchModel: 'gpt-5.4',
      models: [],
      diagnostics: {
        configReadState: 'ready',
        appServerState: 'healthy',
      },
    });

    const service = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('auto'),
      } as never
    );
    service.setCodexModelCatalogFeature({ getCatalog: directCatalog } as never);

    const enriched = await service.enrichProviderStatus(
      {
        providerId: 'codex',
        displayName: 'Codex',
        supported: true,
        authenticated: true,
        authMethod: 'chatgpt',
        verificationState: 'verified',
        models: ['gpt-5.4'],
        modelCatalog: null,
        runtimeCapabilities: {
          modelCatalog: { dynamic: true, source: 'app-server' },
        },
        canLoginFromUi: false,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: {
            plugins: { status: 'unsupported', ownership: 'shared' },
            mcp: { status: 'supported', ownership: 'shared' },
            skills: { status: 'supported', ownership: 'shared' },
            apiKeys: { status: 'supported', ownership: 'shared' },
          },
        },
      },
      { hydrateModelCatalog: false }
    );

    expect(directCatalog).not.toHaveBeenCalled();
    expect(enriched.models).toEqual(['gpt-5.4']);
    expect(enriched.modelCatalog).toBeNull();
    expect(enriched.runtimeCapabilities?.modelCatalog).toEqual({
      dynamic: true,
      source: 'app-server',
    });
  });

  it('returns the stored Anthropic API key for team helper mode only in api_key auth mode', async () => {
    const lookupPreferred = vi.fn().mockResolvedValue({
      envVarName: 'ANTHROPIC_API_KEY',
      value: 'stored-team-key',
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

    await expect(
      service.getConfiguredAnthropicApiKeyForTeamRuntime({
        ANTHROPIC_API_KEY: 'env-team-key',
      })
    ).resolves.toBe('stored-team-key');
    expect(lookupPreferred).toHaveBeenCalledWith('ANTHROPIC_API_KEY');
  });

  it('does not use token-only or OAuth credentials for Anthropic team helper mode', async () => {
    const { ProviderConnectionService } =
      await import('@main/services/runtime/ProviderConnectionService');

    const oauthService = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue({
          envVarName: 'ANTHROPIC_API_KEY',
          value: 'stored-team-key',
        }),
      } as never,
      {
        getConfig: () => createConfig('oauth'),
      } as never
    );
    const apiKeyService = new ProviderConnectionService(
      {
        lookupPreferred: vi.fn().mockResolvedValue(null),
      } as never,
      {
        getConfig: () => createConfig('api_key'),
      } as never
    );

    await expect(
      oauthService.getConfiguredAnthropicApiKeyForTeamRuntime({
        ANTHROPIC_API_KEY: 'env-team-key',
      })
    ).resolves.toBeNull();
    await expect(
      apiKeyService.getConfiguredAnthropicApiKeyForTeamRuntime({
        ANTHROPIC_AUTH_TOKEN: 'proxy-token-only',
      })
    ).resolves.toBeNull();
  });
});
