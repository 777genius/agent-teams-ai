import { describe, expect, it, vi } from 'vitest';

import { registerRuntimeProviderManagementIpc } from '../../../../src/features/runtime-provider-management/main';
import {
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT,
  RUNTIME_PROVIDER_MANAGEMENT_CONNECT_API_KEY,
  RUNTIME_PROVIDER_MANAGEMENT_DIRECTORY,
  RUNTIME_PROVIDER_MANAGEMENT_MODELS,
  RUNTIME_PROVIDER_MANAGEMENT_SETUP_FORM,
  RUNTIME_PROVIDER_MANAGEMENT_VIEW,
} from '../../../../src/features/runtime-provider-management/contracts';

import type { RuntimeProviderManagementFeatureFacade } from '../../../../src/features/runtime-provider-management/main';
import type {
  RuntimeProviderManagementDirectoryResponse,
  RuntimeProviderManagementProviderResponse,
  RuntimeProviderManagementSetupFormResponse,
  RuntimeProviderManagementViewResponse,
  RuntimeProviderManagementModelsResponse,
  RuntimeProviderManagementModelTestResponse,
} from '../../../../src/features/runtime-provider-management/contracts';
import type { IpcMain } from 'electron';

describe('registerRuntimeProviderManagementIpc', () => {
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
    const feature: RuntimeProviderManagementFeatureFacade = {
      loadView: vi.fn(() => Promise.resolve(viewResponse)),
      loadProviderDirectory: vi.fn(() => Promise.resolve(directoryResponse)),
      loadSetupForm: vi.fn(() => Promise.resolve(setupFormResponse)),
      connectProvider: vi.fn(() => Promise.resolve(connectedResponse)),
      connectWithApiKey: vi.fn(() => Promise.resolve(connectedResponse)),
      forgetCredential: vi.fn(() => Promise.resolve(forgottenResponse)),
      loadModels: vi.fn(() => Promise.resolve(modelsResponse)),
      testModel: vi.fn(() => Promise.resolve(testResponse)),
      setDefaultModel: vi.fn(() => Promise.resolve(viewResponse)),
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
  });
});
