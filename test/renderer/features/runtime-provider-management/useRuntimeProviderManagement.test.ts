import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  useRuntimeProviderManagement,
  type RuntimeProviderManagementActions,
  type RuntimeProviderManagementState,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';
import {
  getStoredCreateTeamModel,
  getStoredCreateTeamProvider,
} from '../../../../src/renderer/services/createTeamPreferences';

import type { ElectronAPI } from '../../../../src/shared/types/api';
import type {
  RuntimeProviderConnectionDto,
  RuntimeProviderDirectoryEntryDto,
  RuntimeProviderManagementModelTestResponse,
  RuntimeProviderManagementViewDto,
} from '../../../../src/features/runtime-provider-management/contracts';

function installRuntimeProviderManagementApi(
  response: RuntimeProviderManagementModelTestResponse
): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      runtimeProviderManagement: {
        testModel: vi.fn(() => Promise.resolve(response)),
      },
    } as unknown as ElectronAPI,
  });
}

function createRuntimeView(
  providers: readonly RuntimeProviderConnectionDto[] = []
): RuntimeProviderManagementViewDto {
  return {
    runtimeId: 'opencode',
    title: 'OpenCode',
    runtime: {
      state: 'ready',
      cliPath: '/opt/homebrew/bin/opencode',
      version: '1.0.0',
      managedProfile: 'active',
      localAuth: 'synced',
    },
    providers,
    defaultModel: null,
    fallbackModel: null,
    diagnostics: [],
  };
}

function createOpenAiLocalProvider(): RuntimeProviderConnectionDto {
  return {
    providerId: 'openai',
    displayName: 'OpenAI',
    state: 'connected',
    ownership: ['local'],
    recommended: true,
    modelCount: 12,
    defaultModelId: null,
    authMethods: ['oauth'],
    actions: [],
    detail: 'Connected via local OpenCode credential',
  };
}

function createOpenAiLocalDirectoryEntry(): RuntimeProviderDirectoryEntryDto {
  return {
    ...createOpenAiLocalProvider(),
    setupKind: 'connected',
    sources: ['opencode-provider'],
    sourceLabel: 'OpenCode catalog',
    providerSource: 'models.dev',
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: false,
    },
  };
}

describe('useRuntimeProviderManagement', () => {
  let host: HTMLDivElement;
  let state: RuntimeProviderManagementState | null = null;
  let actions: RuntimeProviderManagementActions | null = null;

  function Harness(): React.ReactElement {
    const hook = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: false,
    });
    state = hook[0];
    actions = hook[1];
    return React.createElement('div');
  }

  function EnabledHarness(props: { projectPath?: string | null }): React.ReactElement {
    const hook = useRuntimeProviderManagement({
      runtimeId: 'opencode',
      enabled: true,
      projectPath: props.projectPath,
    });
    state = hook[0];
    actions = hook[1];
    return React.createElement('div');
  }

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    window.localStorage.clear();
    state = null;
    actions = null;
  });

  afterEach(() => {
    Reflect.deleteProperty(window, 'electronAPI');
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses a clicked model as the app default for new teams without a global success banner', async () => {
    const modelId = 'openrouter/openai/gpt-oss-20b:free';
    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.useModelForNewTeams(modelId);
    });

    expect(state?.selectedModelId).toBe(modelId);
    expect(state?.successMessage).toBeNull();
    expect(getStoredCreateTeamProvider()).toBe('opencode');
    expect(getStoredCreateTeamModel('opencode')).toBe(modelId);
  });

  it('passes projectPath to the runtime provider management API', async () => {
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView(),
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    expect(loadView).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
    });
  });

  it('refreshes view and catalog after forgetting managed auth while local auth remains', async () => {
    const localProvider = createOpenAiLocalProvider();
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView([localProvider]),
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [createOpenAiLocalDirectoryEntry()],
          diagnostics: [],
        },
      })
    );
    const forgetCredential = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: localProvider,
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          forgetCredential,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await vi.waitFor(() => {
      expect(loadView).toHaveBeenCalledTimes(1);
    });

    await act(async () => {
      await actions?.forgetProvider('openai');
    });

    expect(forgetCredential).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openai',
      projectPath: '/tmp/project-a',
    });
    expect(loadView).toHaveBeenCalledTimes(2);
    const refreshDirectoryArgs = {
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
      query: null,
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: true,
    };
    expect(loadProviderDirectory).toHaveBeenCalledWith(refreshDirectoryArgs);
    expect(state?.successMessage).toBe(
      'Managed credential removed. Provider remains connected through local OpenCode credentials.'
    );

    await act(async () => {
      await actions?.refreshDirectory();
    });

    expect(loadView).toHaveBeenCalledTimes(3);
    expect(
      loadProviderDirectory.mock.calls.filter((call) => {
        const input = (call as unknown[])[0] as { refresh?: boolean } | undefined;
        return input?.refresh === true;
      })
    ).toHaveLength(2);
    expect(state?.successMessage).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps connect action busy until the post-connect refresh finishes', async () => {
    const disconnectedProvider: RuntimeProviderConnectionDto = {
      ...createOpenAiLocalProvider(),
      state: 'not-connected',
      ownership: [],
      modelCount: 0,
      actions: [
        {
          id: 'connect',
          label: 'Connect',
          enabled: true,
          disabledReason: null,
          requiresSecret: true,
          ownershipScope: 'managed',
        },
      ],
      detail: null,
    };
    const connectedProvider = createOpenAiLocalProvider();
    const initialViewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([disconnectedProvider]),
    };
    const refreshedViewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([connectedProvider]),
    };
    const directoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: null,
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [createOpenAiLocalDirectoryEntry()],
        diagnostics: [],
      },
    };
    let resolveRefreshView: (() => void) | null = null;
    let resolveRefreshDirectory: (() => void) | null = null;
    const loadView = vi
      .fn()
      .mockResolvedValueOnce(initialViewResponse)
      .mockImplementation(
        () =>
          new Promise<typeof refreshedViewResponse>((resolve) => {
            resolveRefreshView = () => resolve(refreshedViewResponse);
          })
      );
    const loadProviderDirectory = vi
      .fn()
      .mockResolvedValueOnce(directoryResponse)
      .mockImplementation(
        () =>
          new Promise<typeof directoryResponse>((resolve) => {
            resolveRefreshDirectory = () => resolve(directoryResponse);
          })
      );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'api',
          supported: true,
          title: 'Connect OpenAI',
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
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: connectedProvider,
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadSetupForm,
          connectProvider,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      actions?.startConnect('openai');
      actions?.setApiKeyValue('sk-good-value');
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    let submitPromise: Promise<void> | null = null;
    await act(async () => {
      submitPromise = actions?.submitConnect('openai') ?? null;
      await vi.waitFor(() => {
        expect(connectProvider).toHaveBeenCalled();
      });
      await Promise.resolve();
    });

    expect(state?.savingProviderId).toBe('openai');
    expect(state?.activeFormProviderId).toBeNull();

    await act(async () => {
      resolveRefreshView?.();
      resolveRefreshDirectory?.();
      await submitPromise;
    });

    expect(loadView).toHaveBeenCalledTimes(2);
    expect(
      loadProviderDirectory.mock.calls.filter((call) => {
        const input = (call as unknown[])[0] as { refresh?: boolean } | undefined;
        return input?.refresh === true;
      })
    ).toHaveLength(1);
    expect(state?.savingProviderId).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps provider data visible during catalog refresh', async () => {
    const localProvider = { ...createOpenAiLocalProvider(), modelCount: 0 };
    const localDirectoryEntry = { ...createOpenAiLocalDirectoryEntry(), modelCount: 0 };
    const viewResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      view: createRuntimeView([localProvider]),
    };
    const directoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: null,
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [localDirectoryEntry],
        diagnostics: [],
      },
    };
    let resolveRefreshView: (() => void) | null = null;
    let resolveRefreshDirectory: (() => void) | null = null;
    const loadView = vi
      .fn()
      .mockResolvedValueOnce(viewResponse)
      .mockImplementation(
        () =>
          new Promise<typeof viewResponse>((resolve) => {
            resolveRefreshView = () => resolve(viewResponse);
          })
      );
    const loadProviderDirectory = vi
      .fn()
      .mockResolvedValueOnce(directoryResponse)
      .mockImplementation(
        () =>
          new Promise<typeof directoryResponse>((resolve) => {
            resolveRefreshDirectory = () => resolve(directoryResponse);
          })
      );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadModels: vi.fn(() =>
            Promise.resolve({
              schemaVersion: 1,
              runtimeId: 'opencode',
              models: {
                runtimeId: 'opencode',
                providerId: 'openai',
                models: [],
                defaultModelId: null,
                diagnostics: [],
              },
            })
          ),
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(state?.providers).toHaveLength(1);
        expect(state?.directoryEntries).toHaveLength(1);
      });
    });

    let refreshPromise: Promise<void> | null = null;
    await act(async () => {
      refreshPromise = actions?.refreshDirectory() ?? null;
      await Promise.resolve();
    });

    expect(state?.loading).toBe(false);
    expect(state?.directoryRefreshing).toBe(true);
    expect(state?.providers).toHaveLength(1);
    expect(state?.directoryEntries).toHaveLength(1);

    await act(async () => {
      resolveRefreshView?.();
      resolveRefreshDirectory?.();
      await refreshPromise;
    });

    expect(state?.loading).toBe(false);
    expect(state?.directoryRefreshing).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it('lazy-loads provider directory and ignores stale search responses', async () => {
    let resolveFirst: ((value: unknown) => void) | null = null;
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: {
          runtimeId: 'opencode',
          title: 'OpenCode',
          runtime: {
            state: 'ready',
            cliPath: '/opt/homebrew/bin/opencode',
            version: '1.0.0',
            managedProfile: 'active',
            localAuth: 'synced',
          },
          providers: [],
          defaultModel: null,
          fallbackModel: null,
          diagnostics: [],
        },
      })
    );
    const deepseekDirectoryResponse = {
      schemaVersion: 1 as const,
      runtimeId: 'opencode' as const,
      directory: {
        runtimeId: 'opencode' as const,
        totalCount: 1,
        returnedCount: 1,
        query: 'deep',
        filter: 'all' as const,
        limit: 50,
        cursor: null,
        nextCursor: null,
        fetchedAt: '2026-04-25T00:00:00.000Z',
        entries: [
          {
            providerId: 'deepseek',
            displayName: 'DeepSeek',
            state: 'available' as const,
            setupKind: 'available-readonly' as const,
            ownership: [],
            recommended: false,
            modelCount: 62,
            authMethods: [],
            defaultModelId: null,
            sources: ['opencode-provider'] as const,
            sourceLabel: 'OpenCode catalog',
            providerSource: 'models.dev',
            detail: null,
            actions: [],
            metadata: {
              hasKnownModels: true,
              requiresManualConfig: false,
              supportedInlineAuth: false,
            },
          },
        ],
        diagnostics: [],
      },
    };
    const loadProviderDirectory = vi.fn().mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        })
    );
    loadProviderDirectory.mockResolvedValue(deepseekDirectoryResponse);
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });

    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalled();
      });
    });
    const callCountBeforeSearch = loadProviderDirectory.mock.calls.length;

    act(() => {
      actions?.setProviderQuery('deep');
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await vi.waitFor(() => {
        expect(loadProviderDirectory.mock.calls.length).toBeGreaterThan(callCountBeforeSearch);
      });
    });

    await act(async () => {
      resolveFirst?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [
            {
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              state: 'connected',
              setupKind: 'connected',
              ownership: ['managed'],
              recommended: true,
              modelCount: 174,
              authMethods: ['api'],
              defaultModelId: null,
              sources: ['opencode-provider'],
              sourceLabel: 'OpenCode catalog',
              providerSource: 'models.dev',
              detail: null,
              actions: [],
              metadata: {
                hasKnownModels: true,
                requiresManualConfig: false,
                supportedInlineAuth: true,
              },
            },
          ],
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(loadProviderDirectory).toHaveBeenLastCalledWith({
      runtimeId: 'opencode',
      projectPath: '/tmp/project-a',
      query: 'deep',
      filter: 'all',
      limit: 50,
      cursor: null,
      refresh: false,
    });
    expect(state?.directoryEntries.map((entry) => entry.providerId)).toEqual(['deepseek']);
  });

  it('keeps the API key draft when provider connect fails', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
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
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        error: {
          code: 'auth-failed',
          message: 'Invalid API key',
        },
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
          connectProvider,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.startConnect('openrouter');
      actions?.setApiKeyValue('sk-bad-value');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    await act(async () => {
      await actions?.submitConnect('openrouter');
    });

    expect(connectProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openrouter',
      method: 'api',
      apiKey: 'sk-bad-value',
      metadata: {},
      projectPath: null,
    });
    expect(state?.error).toBeNull();
    expect(state?.setupSubmitError).toBe('Invalid API key');
    expect(state?.apiKeyValue).toBe('sk-bad-value');
  });

  it('submits a supported setup form without a secret as a null API key', async () => {
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'oauth',
          supported: true,
          title: 'Connect OpenAI',
          description: null,
          submitLabel: 'Connect',
          disabledReason: null,
          source: 'oauth',
          secret: null,
          prompts: [],
        },
      })
    );
    const connectProvider = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        provider: createOpenAiLocalProvider(),
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadSetupForm,
          connectProvider,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.startConnect('openai');
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadSetupForm).toHaveBeenCalled();
      });
    });

    await act(async () => {
      await actions?.submitConnect('openai');
    });

    expect(connectProvider).toHaveBeenCalledWith({
      runtimeId: 'opencode',
      providerId: 'openai',
      method: 'oauth',
      apiKey: null,
      metadata: {},
      projectPath: null,
    });
    expect(state?.setupSubmitError).toBeNull();

    await act(async () => {
      root.unmount();
    });
  });

  it('clears model loading when switching from model picker to setup form', async () => {
    const localProvider = createOpenAiLocalProvider();
    let resolveModels: ((value: unknown) => void) | null = null;
    const loadView = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        view: createRuntimeView([localProvider]),
      })
    );
    const loadProviderDirectory = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 0,
          returnedCount: 0,
          query: null,
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [],
          diagnostics: [],
        },
      })
    );
    const loadModels = vi.fn(
      () =>
        new Promise((resolve) => {
          resolveModels = resolve;
        })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
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
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          loadView,
          loadProviderDirectory,
          loadModels,
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(EnabledHarness, { projectPath: '/tmp/project-a' }));
      await Promise.resolve();
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadModels).toHaveBeenCalled();
        expect(state?.modelsLoading).toBe(true);
      });
    });

    await act(async () => {
      actions?.startConnect('openrouter');
      await Promise.resolve();
    });

    expect(state?.modelPickerProviderId).toBeNull();
    expect(state?.activeFormProviderId).toBe('openrouter');
    expect(state?.modelsLoading).toBe(false);

    await act(async () => {
      resolveModels?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        models: {
          runtimeId: 'opencode',
          providerId: 'openai',
          models: [
            {
              modelId: 'openai/stale-model',
              providerId: 'openai',
              displayName: 'Stale model',
              sourceLabel: 'OpenCode catalog',
              free: false,
              default: false,
              availability: 'available',
            },
          ],
          defaultModelId: null,
          diagnostics: [],
        },
      });
      await Promise.resolve();
    });

    expect(state?.modelsLoading).toBe(false);
    expect(state?.models).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });

  it('tracks concurrent model probes independently', async () => {
    const firstModelId = 'openrouter/anthropic/claude-3.5-haiku';
    const secondModelId = 'openrouter/openai/gpt-oss-20b:free';
    const resolvers = new Map<string, (value: unknown) => void>();
    const testModel = vi.fn(
      (input: { modelId: string }) =>
        new Promise((resolve) => {
          resolvers.set(input.modelId, resolve);
        })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          testModel,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    let firstProbe: Promise<void> | null = null;
    let secondProbe: Promise<void> | null = null;
    await act(async () => {
      firstProbe = actions?.testModel('openrouter', firstModelId) ?? null;
      secondProbe = actions?.testModel('openrouter', secondModelId) ?? null;
      await Promise.resolve();
    });

    expect(state?.testingModelIds).toEqual([firstModelId, secondModelId]);

    await act(async () => {
      resolvers.get(firstModelId)?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId: firstModelId,
          ok: true,
          availability: 'available',
          message: 'First passed',
          diagnostics: [],
        },
      });
      await firstProbe;
    });

    expect(state?.testingModelIds).toEqual([secondModelId]);

    await act(async () => {
      resolvers.get(secondModelId)?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId: secondModelId,
          ok: true,
          availability: 'available',
          message: 'Second passed',
          diagnostics: [],
        },
      });
      await secondProbe;
    });

    expect(state?.testingModelIds).toEqual([]);
    expect(state?.modelResults[firstModelId]?.message).toBe('First passed');
    expect(state?.modelResults[secondModelId]?.message).toBe('Second passed');

    await act(async () => {
      root.unmount();
    });
  });

  it('drops stale model probe results after leaving the model picker', async () => {
    const modelId = 'openrouter/anthropic/claude-3.5-haiku';
    let resolveProbe: ((value: RuntimeProviderManagementModelTestResponse) => void) | null = null;
    const testModel = vi.fn(
      () =>
        new Promise<RuntimeProviderManagementModelTestResponse>((resolve) => {
          resolveProbe = resolve;
        })
    );
    const loadSetupForm = vi.fn(() =>
      Promise.resolve({
        schemaVersion: 1,
        runtimeId: 'opencode',
        setupForm: {
          runtimeId: 'opencode',
          providerId: 'openai',
          displayName: 'OpenAI',
          method: 'api',
          supported: true,
          title: 'Connect OpenAI',
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
      })
    );
    Object.defineProperty(window, 'electronAPI', {
      configurable: true,
      value: {
        runtimeProviderManagement: {
          testModel,
          loadSetupForm,
        },
      } as unknown as ElectronAPI,
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    act(() => {
      actions?.openModelPicker('openrouter', 'use');
    });

    let probe: Promise<void> | null = null;
    await act(async () => {
      probe = actions?.testModel('openrouter', modelId) ?? null;
      await Promise.resolve();
    });

    expect(state?.testingModelIds).toEqual([modelId]);

    await act(async () => {
      actions?.startConnect('openai');
      await Promise.resolve();
    });

    expect(state?.modelPickerProviderId).toBeNull();
    expect(state?.testingModelIds).toEqual([]);

    await act(async () => {
      resolveProbe?.({
        schemaVersion: 1,
        runtimeId: 'opencode',
        result: {
          providerId: 'openrouter',
          modelId,
          ok: true,
          availability: 'available',
          message: 'Stale probe passed',
          diagnostics: [],
        },
      });
      await probe;
    });

    expect(state?.modelResults[modelId]).toBeUndefined();
    expect(state?.testingModelIds).toEqual([]);

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps failed model probes scoped to the model result instead of a global success banner', async () => {
    const modelId = 'openrouter/anthropic/claude-3.5-haiku';
    const message =
      'This request requires more credits, or fewer max_tokens. You requested up to 8192 tokens, but can only afford 381.';
    installRuntimeProviderManagementApi({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'openrouter',
        modelId,
        ok: false,
        availability: 'unavailable',
        message,
        diagnostics: [],
      },
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.testModel('openrouter', modelId);
    });

    expect(state?.successMessage).toBeNull();
    expect(state?.error).toBeNull();
    expect(state?.modelResults[modelId]?.ok).toBe(false);
    expect(state?.modelResults[modelId]?.message).toBe(message);
  });

  it('keeps successful model probes scoped to the model card instead of a global success banner', async () => {
    const modelId = 'openrouter/openai/gpt-oss-20b:free';
    installRuntimeProviderManagementApi({
      schemaVersion: 1,
      runtimeId: 'opencode',
      result: {
        providerId: 'openrouter',
        modelId,
        ok: true,
        availability: 'available',
        message: 'Model probe passed',
        diagnostics: [],
      },
    });

    const root = createRoot(host);
    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      await actions?.testModel('openrouter', modelId);
    });

    expect(state?.successMessage).toBeNull();
    expect(state?.error).toBeNull();
    expect(state?.modelResults[modelId]?.ok).toBe(true);
    expect(state?.modelResults[modelId]?.message).toBe('Model probe passed');
  });
});
