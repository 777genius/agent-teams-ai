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
import type { RuntimeProviderManagementModelTestResponse } from '../../../../src/features/runtime-provider-management/contracts';

function installRuntimeProviderManagementApi(response: RuntimeProviderManagementModelTestResponse): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: {
      runtimeProviderManagement: {
        testModel: vi.fn(() => Promise.resolve(response)),
      },
    } as unknown as ElectronAPI,
  });
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
    const loadProviderDirectory = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((resolve) => {
            resolveFirst = resolve;
          })
      )
      .mockResolvedValueOnce({
        schemaVersion: 1,
        runtimeId: 'opencode',
        directory: {
          runtimeId: 'opencode',
          totalCount: 1,
          returnedCount: 1,
          query: 'deep',
          filter: 'all',
          limit: 50,
          cursor: null,
          nextCursor: null,
          fetchedAt: '2026-04-25T00:00:00.000Z',
          entries: [
            {
              providerId: 'deepseek',
              displayName: 'DeepSeek',
              state: 'available',
              setupKind: 'available-readonly',
              ownership: [],
              recommended: false,
              modelCount: 62,
              authMethods: [],
              defaultModelId: null,
              sources: ['opencode-provider'],
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
      });
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

    act(() => {
      actions?.openDirectory();
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 10));
    });
    await act(async () => {
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalledTimes(1);
      });
    });

    act(() => {
      actions?.setDirectoryQuery('deep');
    });
    await act(async () => {
      await new Promise((resolve) => window.setTimeout(resolve, 300));
      await vi.waitFor(() => {
        expect(loadProviderDirectory).toHaveBeenCalledTimes(2);
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
