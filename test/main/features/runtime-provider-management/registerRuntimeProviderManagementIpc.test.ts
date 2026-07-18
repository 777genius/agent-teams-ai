import { describe, expect, it, vi } from 'vitest';

import {
  RUNTIME_LOCAL_PROVIDER_CONFIGURE,
  RUNTIME_LOCAL_PROVIDER_LIST,
  RUNTIME_LOCAL_PROVIDER_PROBE,
  RUNTIME_LOCAL_PROVIDER_SCAN,
  RUNTIME_PROVIDER_COMPANION_CONNECT,
  RUNTIME_PROVIDER_COMPANION_INSTALL,
  RUNTIME_PROVIDER_COMPANION_STATUS,
  RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
} from '../../../../src/features/runtime-provider-management/contracts';
import { registerRuntimeProviderManagementIpc } from '../../../../src/features/runtime-provider-management/main';

import type {
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementModelLimitsResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementViewResponse,
} from '../../../../src/features/runtime-provider-management/contracts';
import type { RuntimeProviderManagementFeatureFacade } from '../../../../src/features/runtime-provider-management/main';
import type { IpcMain } from 'electron';

function createCompanionFeatureStubs(): Pick<
  RuntimeProviderManagementFeatureFacade,
  | 'scanLocalProviders'
  | 'listLocalProviders'
  | 'probeLocalProvider'
  | 'configureLocalProvider'
  | 'getCompanionStatus'
  | 'installAndConnectCompanion'
  | 'connectCompanion'
  | 'onCompanionProgress'
> {
  return {
    listLocalProviders: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    scanLocalProviders: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    probeLocalProvider: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    configureLocalProvider: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    getCompanionStatus: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    installAndConnectCompanion: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    connectCompanion: vi.fn(() => Promise.reject(new Error('Not used by this test'))),
    onCompanionProgress: vi.fn(() => () => {}),
  };
}

describe('registerRuntimeProviderManagementIpc', () => {
  it('validates and routes local provider list, scan, probe, and configuration requests', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const scanResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      probes: [],
    };
    const listResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      projectPath: '/tmp/sandbox',
      configPath: '/tmp/sandbox/opencode.json',
      providers: [],
    };
    const probeResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      probe: {
        preset: {
          id: 'ollama' as const,
          providerId: 'ollama',
          displayName: 'Ollama',
          defaultBaseUrl: 'http://127.0.0.1:11434/v1',
          description: 'Local Ollama',
          scannable: true,
        },
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        state: 'available' as const,
        models: [{ id: 'qwen3:8b', displayName: 'qwen3:8b' }],
        latencyMs: 12,
        message: 'Connected.',
      },
    };
    const configureResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      configuration: {
        providerId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434/v1',
        modelIds: ['qwen3:8b'],
        defaultModelId: 'qwen3:8b',
        modelRoute: 'ollama/qwen3:8b',
        configPath: '/tmp/sandbox/opencode.json',
        scope: 'project' as const,
        setAsDefault: true,
      },
    };
    const feature = {
      ...createCompanionFeatureStubs(),
      listLocalProviders: vi.fn(async () => listResponse),
      scanLocalProviders: vi.fn(async () => scanResponse),
      probeLocalProvider: vi.fn(async () => probeResponse),
      configureLocalProvider: vi.fn(async () => configureResponse),
    } as unknown as RuntimeProviderManagementFeatureFacade;

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_LIST)?.(
        {},
        { runtimeId: 'opencode', scope: 'project', projectPath: '/tmp/sandbox' }
      )
    ).resolves.toEqual(listResponse);
    expect(feature.listLocalProviders).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: '/tmp/sandbox',
    });
    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_SCAN)?.({}, { runtimeId: 'opencode' })
    ).resolves.toEqual(scanResponse);
    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_PROBE)?.(
        {},
        {
          runtimeId: 'opencode',
          presetId: 'ollama',
          baseUrl: 'http://127.0.0.1:11434/v1',
        }
      )
    ).resolves.toEqual(probeResponse);
    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_CONFIGURE)?.(
        {},
        {
          runtimeId: 'opencode',
          scope: 'project',
          projectPath: '/tmp/sandbox',
          presetId: 'ollama',
          defaultModelId: 'qwen3:8b',
          setAsDefault: true,
        }
      )
    ).resolves.toEqual(configureResponse);
    expect(feature.configureLocalProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      scope: 'project',
      projectPath: '/tmp/sandbox',
      presetId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });
    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_LIST)?.({}, { runtimeId: 'opencode', scope: 'global' })
    ).resolves.toEqual(listResponse);
    await expect(
      handlers.get(RUNTIME_LOCAL_PROVIDER_CONFIGURE)?.(
        {},
        {
          runtimeId: 'opencode',
          scope: 'global',
          presetId: 'ollama',
          defaultModelId: 'qwen3:8b',
          setAsDefault: true,
        }
      )
    ).resolves.toEqual(configureResponse);
    expect(feature.configureLocalProvider).toHaveBeenLastCalledWith({
      runtimeId: 'opencode',
      scope: 'global',
      presetId: 'ollama',
      defaultModelId: 'qwen3:8b',
      setAsDefault: true,
    });

    const invalid = await handlers.get(RUNTIME_LOCAL_PROVIDER_CONFIGURE)?.(
      {},
      {
        runtimeId: 'opencode',
        scope: 'project',
        projectPath: '/tmp/sandbox',
        presetId: 'unknown',
        defaultModelId: 'qwen3:8b',
        setAsDefault: true,
      }
    );
    expect(invalid).toMatchObject({ error: { code: 'invalid-input' } });
    expect(feature.configureLocalProvider).toHaveBeenCalledTimes(2);
  });

  it('accepts every registered companion id and rejects unknown transport input', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const status = {
      companionId: 'cursor-agent' as const,
      displayName: 'Cursor Agent',
      phase: 'connected' as const,
      installed: true,
      authenticated: true,
      binaryPath: '/test/cursor-agent',
      version: 'cursor-agent 2026.07.09',
      percent: 100,
      message: 'Connected',
      detail: null,
      error: null,
      manualCommand: 'curl https://cursor.com/install -fsS | bash',
      manualUrl: 'https://cursor.com/docs/cli/installation',
      updatedAt: '2026-07-12T00:00:00.000Z',
    };
    const feature = {
      ...createCompanionFeatureStubs(),
      getCompanionStatus: vi.fn(async () => status),
      installAndConnectCompanion: vi.fn(async () => status),
      connectCompanion: vi.fn(async () => status),
    } as unknown as RuntimeProviderManagementFeatureFacade;

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    await handlers.get(RUNTIME_PROVIDER_COMPANION_STATUS)?.(
      {},
      {
        companionId: 'cursor-agent',
        projectPath: '/tmp/cursor-test',
      }
    );
    await handlers.get(RUNTIME_PROVIDER_COMPANION_INSTALL)?.(
      {},
      {
        companionId: 'kiro-cli',
        projectPath: null,
      }
    );
    await handlers.get(RUNTIME_PROVIDER_COMPANION_CONNECT)?.(
      {},
      {
        companionId: 'cursor-agent',
      }
    );
    expect(feature.getCompanionStatus).toHaveBeenCalledWith({
      companionId: 'cursor-agent',
      projectPath: '/tmp/cursor-test',
    });
    expect(feature.installAndConnectCompanion).toHaveBeenCalledWith({
      companionId: 'kiro-cli',
      projectPath: null,
    });
    await expect(
      handlers.get(RUNTIME_PROVIDER_COMPANION_STATUS)?.({}, { companionId: 'unknown-cli' })
    ).rejects.toThrow('Unsupported runtime provider companion');
    await expect(
      handlers.get(RUNTIME_PROVIDER_COMPANION_STATUS)?.(
        {},
        {
          companionId: 'cursor-agent',
          projectPath: 42,
        }
      )
    ).rejects.toThrow('Unsupported runtime provider companion');
  });

  it('passes API keys through input only and returns provider DTOs without the raw secret', async () => {
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const viewResponse: RuntimeProviderManagementViewResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      view: {
        runtimeId: 'opencode',
        title: 'OpenCode',
        runtime: {
          state: 'ready',
          cliPath: null,
          version: null,
          managedProfile: 'active',
          localAuth: 'synced',
        },
        providers: [],
        defaultModel: null,
        fallbackModel: null,
        diagnostics: [],
      },
    };
    const connectedResponse: RuntimeProviderManagementProviderResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      provider: {
        providerId: 'openrouter',
        displayName: 'OpenRouter',
        state: 'connected',
        ownership: ['managed'],
        recommended: true,
        modelCount: 4,
        defaultModelId: null,
        authMethods: ['api'],
        actions: [],
        detail: null,
      },
    };
    const directoryResponse: RuntimeProviderManagementDirectoryResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      directory: {
        runtimeId: 'opencode',
        totalCount: 0,
        returnedCount: 0,
        query: null,
        filter: 'all',
        limit: 100,
        cursor: null,
        nextCursor: null,
        entries: [],
        diagnostics: [],
        fetchedAt: '2026-04-25T00:00:00.000Z',
      },
    };
    const forgottenResponse: RuntimeProviderManagementProviderResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      provider: {
        providerId: 'openrouter',
        displayName: 'OpenRouter',
        state: 'available',
        ownership: [],
        recommended: true,
        modelCount: 4,
        defaultModelId: null,
        authMethods: ['api'],
        actions: [],
        detail: null,
      },
    };
    const modelsResponse: RuntimeProviderManagementModelsResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      models: {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        models: [],
        defaultModelId: null,
        diagnostics: [],
      },
    };
    const testResponse: RuntimeProviderManagementModelTestResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'openrouter',
        modelId: 'openrouter/openai/gpt-oss-20b:free',
        ok: true,
        availability: 'available',
        message: 'Model probe passed',
        diagnostics: [],
      },
    };
    const setupFormResponse: RuntimeProviderManagementSetupFormResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      setupForm: {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        displayName: 'OpenRouter',
        method: 'api',
        supported: true,
        title: 'Connect OpenRouter',
        description: null,
        submitLabel: 'Connect',
        disabledReason: null,
        source: 'curated',
        secret: {
          key: 'key',
          label: 'API key',
          placeholder: 'Paste API key',
          required: true,
        },
        prompts: [],
      },
    };
    const modelLimitsResponse: RuntimeProviderManagementModelLimitsResponse = {
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'local',
        modelId: 'local/qwen',
        contextTokens: 128_000,
        outputTokens: 32_000,
        saved: true,
        verified: true,
        message: 'Context limits saved and model probe passed',
        diagnostics: [],
      },
    };
    const feature: RuntimeProviderManagementFeatureFacade = {
      ...createCompanionFeatureStubs(),
      loadView: vi.fn(() => Promise.resolve(viewResponse)),
      loadProviderDirectory: vi.fn(() => Promise.resolve(directoryResponse)),
      loadSetupForm: vi.fn(() => Promise.resolve(setupFormResponse)),
      connectProvider: vi.fn(() => Promise.resolve(connectedResponse)),
      submitOAuthCode: vi.fn(() => Promise.resolve({ ok: true })),
      cancelOAuth: vi.fn(() => Promise.resolve({ ok: true })),
      onOAuthProgress: vi.fn(() => () => {}),
      connectWithApiKey: vi.fn(() => Promise.resolve(connectedResponse)),
      forgetCredential: vi.fn(() => Promise.resolve(forgottenResponse)),
      loadModels: vi.fn(() => Promise.resolve(modelsResponse)),
      testModel: vi.fn(() => Promise.resolve(testResponse)),
      setDefaultModel: vi.fn(() => Promise.resolve(viewResponse)),
      configureModelLimits: vi.fn(() => Promise.resolve(modelLimitsResponse)),
    };

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_VIEW)?.({}, { runtimeId: 'opencode' });
    await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY)?.(
      {},
      {
        runtimeId: 'opencode',
        query: 'deep',
        filter: 'connectable',
        limit: 10,
      }
    );
    expect(feature.loadProviderDirectory).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      query: 'deep',
      filter: 'connectable',
      limit: 10,
    });

    await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM)?.(
      {},
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
      }
    );
    expect(feature.loadSetupForm).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
    });

    const genericConnectResponse = await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_CONNECT)?.(
      {},
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        method: 'api',
        apiKey: 'sk-secret-value',
        metadata: {},
      }
    );

    expect(feature.connectProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-secret-value',
      metadata: {},
    });
    expect(JSON.stringify(genericConnectResponse)).not.toContain('sk-secret-value');

    const response = await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY)?.(
      {},
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        apiKey: 'sk-secret-value',
      }
    );

    expect(feature.connectWithApiKey).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      apiKey: 'sk-secret-value',
    });
    expect(JSON.stringify(response)).not.toContain('sk-secret-value');

    await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_MODELS)?.(
      {},
      { runtimeId: 'opencode', providerId: 'openrouter', query: 'free', limit: 10 }
    );
    expect(feature.loadModels).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      query: 'free',
      limit: 10,
    });

    const limitsResponse = await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_CONFIGURE_MODEL_LIMITS)?.(
      {},
      {
        runtimeId: 'opencode',
        providerId: 'local',
        modelId: 'local/qwen',
        contextTokens: 128_000,
        outputTokens: 32_000,
        projectPath: '/tmp/local-project',
      }
    );
    expect(feature.configureModelLimits).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'local',
      modelId: 'local/qwen',
      contextTokens: 128_000,
      outputTokens: 32_000,
      projectPath: '/tmp/local-project',
    });
    expect(limitsResponse).toEqual(modelLimitsResponse);
  });

  it('sanitizes unexpected IPC error messages before returning them to the renderer', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const feature: RuntimeProviderManagementFeatureFacade = {
      ...createCompanionFeatureStubs(),
      loadView: vi.fn(() =>
        Promise.reject(
          new Error(
            '\u001B]8;;https://logs.example/secret\u0007\u001B[31mProvider failed with api_key: sk-secret-value-123456 and Authorization: Bearer live-token-123456789 and key=AIzaSyD-test-secret-value-123456789 and OPENAI_API_KEY=plain_provider_secret_123456 and PROVIDER_TOKEN=provider_token_value_123456\u001B[0m\u001B]8;;\u0007'
          )
        )
      ),
      loadProviderDirectory: vi.fn(),
      loadSetupForm: vi.fn(),
      connectProvider: vi.fn(),
      submitOAuthCode: vi.fn(() => Promise.resolve({ ok: true })),
      cancelOAuth: vi.fn(() => Promise.resolve({ ok: true })),
      onOAuthProgress: vi.fn(() => () => {}),
      connectWithApiKey: vi.fn(),
      forgetCredential: vi.fn(),
      loadModels: vi.fn(),
      testModel: vi.fn(),
      setDefaultModel: vi.fn(),
      configureModelLimits: vi.fn(),
    };

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    const response = (await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_VIEW)?.(
      {},
      { runtimeId: 'opencode' }
    )) as RuntimeProviderManagementViewResponse;

    expect(response.error?.message).toContain('api_key: ...redacted');
    expect(response.error?.message).toContain('Authorization: Bearer ...redacted');
    expect(response.error?.message).toContain('key=...redacted');
    expect(response.error?.message).toContain('OPENAI_API_KEY=...redacted');
    expect(response.error?.message).toContain('PROVIDER_TOKEN=...redacted');
    expect(response.error?.message).not.toContain('sk-secret-value-123456');
    expect(response.error?.message).not.toContain('live-token-123456789');
    expect(response.error?.message).not.toContain('AIzaSyD-test-secret-value-123456789');
    expect(response.error?.message).not.toContain('plain_provider_secret_123456');
    expect(response.error?.message).not.toContain('provider_token_value_123456');
    expect(response.error?.message).not.toContain('logs.example/secret');
    expect(response.error?.message).not.toContain('[31m');
    expect(response.error?.message).not.toContain(']8;;');
    expect(response.error?.diagnostics?.summary).toContain('api_key: ...redacted');
    expect(response.error?.diagnostics?.errorCode).toBe('runtime-unhealthy');
    expect(response.error?.diagnostics?.stderrPreview).toContain(
      'Authorization: Bearer ...redacted'
    );
    expect(JSON.stringify(response.error?.diagnostics)).not.toContain('sk-secret-value-123456');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain('api_key: ...redacted');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain('key=...redacted');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('sk-secret-value-123456');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('live-token-123456789');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain(
      'AIzaSyD-test-secret-value-123456789'
    );
    consoleErrorSpy.mockRestore();
  });

  it('bounds unexpected IPC diagnostics before returning them to the renderer', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const feature: RuntimeProviderManagementFeatureFacade = {
      ...createCompanionFeatureStubs(),
      loadView: vi.fn(() => Promise.reject(new Error(`x${'y'.repeat(3_000)}`))),
      loadProviderDirectory: vi.fn(),
      loadSetupForm: vi.fn(),
      connectProvider: vi.fn(),
      submitOAuthCode: vi.fn(() => Promise.resolve({ ok: true })),
      cancelOAuth: vi.fn(() => Promise.resolve({ ok: true })),
      onOAuthProgress: vi.fn(() => () => {}),
      connectWithApiKey: vi.fn(),
      forgetCredential: vi.fn(),
      loadModels: vi.fn(),
      testModel: vi.fn(),
      setDefaultModel: vi.fn(),
      configureModelLimits: vi.fn(),
    };

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    const response = (await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_VIEW)?.(
      {},
      { runtimeId: 'opencode' }
    )) as RuntimeProviderManagementViewResponse;

    expect(response.error?.message.endsWith('...')).toBe(true);
    expect(response.error?.message.length).toBeLessThanOrEqual(1_603);
    expect(response.error?.diagnostics?.stderrPreview).toBe(response.error?.message);
    consoleErrorSpy.mockRestore();
  });

  it('does not log raw secrets when connect handlers throw non-Error values', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const handlers = new Map<string, (...args: unknown[]) => Promise<unknown>>();
    const ipcMain = {
      handle: vi.fn((channel: string, handler: (...args: unknown[]) => Promise<unknown>) => {
        handlers.set(channel, handler);
      }),
      removeHandler: vi.fn(),
    } as unknown as IpcMain;
    const feature: RuntimeProviderManagementFeatureFacade = {
      ...createCompanionFeatureStubs(),
      loadView: vi.fn(),
      loadProviderDirectory: vi.fn(),
      loadSetupForm: vi.fn(),
      connectProvider: vi.fn(() =>
        Promise.reject(
          'Provider failed with api_key: sk-secret-value-123456 and token=provider-token-123456789'
        )
      ),
      submitOAuthCode: vi.fn(() => Promise.resolve({ ok: true })),
      cancelOAuth: vi.fn(() => Promise.resolve({ ok: true })),
      onOAuthProgress: vi.fn(() => () => {}),
      connectWithApiKey: vi.fn(),
      forgetCredential: vi.fn(),
      loadModels: vi.fn(),
      testModel: vi.fn(),
      setDefaultModel: vi.fn(),
      configureModelLimits: vi.fn(),
    };

    registerRuntimeProviderManagementIpc(ipcMain, feature);

    const response = (await handlers.get(RUNTIME_PROVIDER_MANAGEMENT_CONNECT)?.(
      {},
      {
        runtimeId: 'opencode',
        providerId: 'openrouter',
        method: 'api',
        apiKey: 'sk-input-secret-value',
        metadata: {},
      }
    )) as RuntimeProviderManagementProviderResponse;

    expect(response.error?.message).toContain('api_key: ...redacted');
    expect(response.error?.message).toContain('token=...redacted');
    expect(response.error?.diagnostics?.errorCode).toBe('auth-failed');
    expect(response.error?.diagnostics?.stderrPreview).toContain('token=...redacted');
    expect(JSON.stringify(response)).not.toContain('sk-input-secret-value');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain('api_key: ...redacted');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).toContain('token=...redacted');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('sk-secret-value-123456');
    expect(JSON.stringify(consoleErrorSpy.mock.calls)).not.toContain('provider-token-123456789');
    consoleErrorSpy.mockRestore();
  });
});
