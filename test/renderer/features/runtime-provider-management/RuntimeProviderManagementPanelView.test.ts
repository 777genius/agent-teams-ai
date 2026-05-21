import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProviderManagementPanelView } from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderManagementPanelView';

import type {
  RuntimeProviderManagementActions,
  RuntimeProviderManagementState,
} from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderManagement';

function createState(
  overrides: Partial<RuntimeProviderManagementState> = {}
): RuntimeProviderManagementState {
  return {
    view: {
      runtimeId: 'opencode',
      title: 'OpenCode',
      runtime: {
        state: 'ready',
        cliPath: '/usr/local/bin/opencode',
        version: '1.14.24',
        managedProfile: 'active',
        localAuth: 'synced',
      },
      providers: [
        {
          providerId: 'openrouter',
          displayName: 'OpenRouter',
          state: 'available',
          ownership: [],
          recommended: true,
          modelCount: 4,
          defaultModelId: null,
          authMethods: ['api'],
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
        },
      ],
      defaultModel: null,
      fallbackModel: null,
      diagnostics: [],
    },
    providers: [],
    selectedProviderId: 'openrouter',
    providerQuery: '',
    directoryLoading: false,
    directoryRefreshing: false,
    directoryError: null,
    directoryEntries: [],
    directoryTotalCount: null,
    directoryNextCursor: null,
    directoryLoaded: false,
    directorySelectedProviderId: null,
    directorySupported: true,
    activeFormProviderId: null,
    setupForm: null,
    setupFormLoading: false,
    setupFormError: null,
    setupSubmitError: null,
    setupMetadata: {},
    apiKeyValue: '',
    modelPickerProviderId: null,
    modelPickerMode: null,
    modelQuery: '',
    models: [],
    modelsLoading: false,
    modelsError: null,
    selectedModelId: null,
    testingModelIds: [],
    savingDefaultModelId: null,
    modelResults: {},
    loading: false,
    savingProviderId: null,
    error: null,
    successMessage: null,
    ...overrides,
  };
}

function createActions(): RuntimeProviderManagementActions {
  return {
    refresh: vi.fn(() => Promise.resolve()),
    selectProvider: vi.fn(),
    setProviderQuery: vi.fn(),
    loadMoreDirectory: vi.fn(() => Promise.resolve()),
    refreshDirectory: vi.fn(() => Promise.resolve()),
    selectDirectoryProvider: vi.fn(),
    searchAllProviders: vi.fn(),
    startConnect: vi.fn(),
    cancelConnect: vi.fn(),
    setApiKeyValue: vi.fn(),
    setSetupMetadataValue: vi.fn(),
    submitConnect: vi.fn(() => Promise.resolve()),
    forgetProvider: vi.fn(() => Promise.resolve()),
    openModelPicker: vi.fn(),
    closeModelPicker: vi.fn(),
    setModelQuery: vi.fn(),
    selectModel: vi.fn(),
    useModelForNewTeams: vi.fn(),
    testModel: vi.fn(() => Promise.resolve()),
    setDefaultModel: vi.fn(() => Promise.resolve()),
  };
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('HTMLInputElement value setter not found');
  }

  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('RuntimeProviderManagementPanelView', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders an explicit loading state while the managed OpenCode view is loading', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: null,
            providers: [],
            loading: true,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking runtime');
    expect(host.textContent).toContain('Loading managed OpenCode runtime');
    expect(host.textContent).toContain('Loading OpenCode model routes');
    expect(
      host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
    ).not.toBeNull();
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThanOrEqual(8);
    expect(host.textContent).toContain('Checking...');
    const refreshButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Checking...')
    );
    expect(refreshButton?.disabled).toBe(true);

    expect(host.textContent).not.toContain('No launchable OpenCode model routes were reported yet');
  });

  it('keeps project context out of the runtime summary and labels it as validation context', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [
                {
                  providerId: 'llama.cpp',
                  modelId: 'llama.cpp/qwen-test:0.5b',
                  displayName: 'qwen-test:0.5b',
                  sourceLabel: 'llama.cpp',
                  free: false,
                  default: false,
                  availability: 'available',
                  accessKind: 'verified',
                  routeKind: 'configured_local',
                  proofState: 'verified',
                  requiresExecutionProof: false,
                  accessReason: null,
                },
              ],
            },
          }),
          actions: createActions(),
          disabled: false,
          projectPath: '/Users/belief/dev/projects/321',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode defaults');
    expect(host.textContent).toContain('Validation context');
    expect(host.textContent).toContain('Tests use 321. Default applies unless');
    expect(host.textContent).not.toContain('Project context: 321');
    expect(host.textContent).not.toContain('Current context: 321');
    expect(host.textContent).not.toContain('Managing selected project profile');
    expect(host.textContent).not.toContain('/Users/belief/dev/projects/321');
  });

  it('renders configured OpenCode model routes with local proof actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'untested' as const,
      accessKind: 'configured_authless' as const,
      routeKind: 'configured_local' as const,
      proofState: 'needs_probe' as const,
      requiresExecutionProof: true,
      accessReason: 'Execution proof required',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [configuredModel],
            },
            selectedModelId: 'llama.cpp/qwen-test:0.5b',
          }),
          actions,
          disabled: false,
          projectPath: '/tmp/project',
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="configured-opencode-model-row-llama.cpp/qwen-test:0.5b"]'
    );
    expect(host.textContent).toContain('Launchable OpenCode models');
    expect(row?.textContent).toContain('local');
    expect(row?.textContent).toContain('configured');
    expect(row?.textContent).toContain('needs test');

    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Test'))?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Use in team picker'))?.click();
      await Promise.resolve();
    });
    await act(async () => {
      buttons.find((button) => button.textContent?.includes('Set all-projects default'))?.click();
      await Promise.resolve();
    });

    expect(actions.testModel).toHaveBeenCalledWith('llama.cpp', 'llama.cpp/qwen-test:0.5b');
    expect(actions.useModelForNewTeams).toHaveBeenCalledWith('llama.cpp/qwen-test:0.5b');
    expect(actions.setDefaultModel).toHaveBeenCalledWith(
      'llama.cpp',
      'llama.cpp/qwen-test:0.5b',
      'all_projects'
    );
  });

  it('can set an all-projects OpenCode default from the model scope controls', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'available' as const,
      accessKind: 'verified' as const,
      routeKind: 'configured_local' as const,
      proofState: 'verified' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [configuredModel],
            },
          }),
          actions,
          disabled: false,
          projectPath: '/tmp/project-a',
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      Array.from(host.querySelectorAll('button'))
        .find((button) => button.textContent?.includes('Set all-projects default'))
        ?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Default for every project that does not have its own OpenCode override'
    );
    expect(host.textContent).toContain('Validation context');
    expect(actions.setDefaultModel).toHaveBeenCalledWith(
      'llama.cpp',
      'llama.cpp/qwen-test:0.5b',
      'all_projects'
    );
  });

  it('filters launchable OpenCode model routes by route text', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const localModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'available' as const,
      accessKind: 'verified' as const,
      routeKind: 'configured_local' as const,
      proofState: 'verified' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };
    const freeModel = {
      providerId: 'opencode',
      modelId: 'opencode/big-pickle',
      displayName: 'big-pickle',
      sourceLabel: 'OpenCode',
      free: true,
      default: false,
      availability: 'available' as const,
      accessKind: 'builtin_free' as const,
      routeKind: 'builtin_free' as const,
      proofState: 'not_required' as const,
      requiresExecutionProof: false,
      accessReason: null,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [localModel, freeModel],
            },
          }),
          actions: createActions(),
          disabled: false,
          projectPath: '/tmp/project-a',
        })
      );
      await Promise.resolve();
    });

    const searchInput = host.querySelector<HTMLInputElement>(
      'input[placeholder="Search model routes"]'
    );
    expect(searchInput).not.toBeNull();
    expect(host.textContent).toContain('qwen-test:0.5b');
    expect(host.textContent).toContain('big-pickle');

    await act(async () => {
      setInputValue(searchInput!, 'pickle');
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('qwen-test:0.5b');
    expect(host.textContent).toContain('big-pickle');

    await act(async () => {
      setInputValue(searchInput!, 'missing-route');
      await Promise.resolve();
    });

    expect(host.textContent).toContain('No OpenCode model routes match');
    expect(host.textContent).toContain('missing-route');
  });

  it('opens launchable routes first when they exist and keeps providers in a separate tab', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const baseState = createState();
    const configuredModel = {
      providerId: 'llama.cpp',
      modelId: 'llama.cpp/qwen-test:0.5b',
      displayName: 'qwen-test:0.5b',
      sourceLabel: 'llama.cpp',
      free: false,
      default: false,
      availability: 'untested' as const,
      accessKind: 'configured_authless' as const,
      routeKind: 'configured_local' as const,
      proofState: 'needs_probe' as const,
      requiresExecutionProof: true,
      accessReason: 'Execution proof required',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...baseState.view!,
              configuredModels: [configuredModel],
            },
            providers: baseState.view?.providers ?? [],
          }),
          actions: createActions(),
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Launchable OpenCode models');
    expect(host.textContent).toContain('llama.cpp/qwen-test:0.5b');
    expect(host.textContent).toContain('Providers');
    expect(host.querySelector('[data-testid="runtime-provider-row-openrouter"]')).toBeNull();
  });

  it('shows unknown OpenCode defaults without enabling launch actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const unknownDefaultModel = {
      providerId: 'openrouter',
      modelId: 'openrouter/moonshotai/kimi-k2',
      displayName: 'moonshotai/kimi-k2',
      sourceLabel: 'OpenRouter',
      free: false,
      default: true,
      availability: 'untested' as const,
      accessKind: 'unknown_model' as const,
      routeKind: 'catalog_provider' as const,
      proofState: 'not_required' as const,
      requiresExecutionProof: false,
      accessReason: 'Model was not found in the live catalog',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              configuredModels: [unknownDefaultModel],
            },
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="configured-opencode-model-row-openrouter/moonshotai/kimi-k2"]'
    );
    expect(row?.textContent).toContain('unknown');
    expect(row?.textContent).toContain('default');

    const buttons = Array.from(row?.querySelectorAll('button') ?? []);
    expect(buttons.map((button) => button.disabled)).toEqual([true, true, true]);
    await act(async () => {
      buttons.forEach((button) => button.click());
      await Promise.resolve();
    });
    expect(actions.testModel).not.toHaveBeenCalled();
    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
    expect(actions.setDefaultModel).not.toHaveBeenCalled();
  });

  it('renders duplicate runtime diagnostics without React key warnings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseState = createState();
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...baseState.view!,
              diagnostics: [
                'Unable to connect. Is the computer able to access the url?',
                'Unable to connect. Is the computer able to access the url?',
              ],
            },
            providers: baseState.view?.providers ?? [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const duplicateDiagnostics = host.textContent?.match(
      /Unable to connect\. Is the computer able to access the url\?/g
    );
    const duplicateKeyWarnings = consoleError.mock.calls.filter((call) =>
      call.some(
        (argument) =>
          typeof argument === 'string' &&
          argument.includes('Encountered two children with the same key')
      )
    );
    consoleError.mockRestore();

    expect(duplicateDiagnostics).toHaveLength(2);
    expect(duplicateKeyWarnings).toHaveLength(0);
  });

  it('renders provider actions and opens API-key form state without exposing a raw secret', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: { ...state, providers: state.view?.providers ?? [] },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).toContain('4 models');
    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="runtime-provider-row-openrouter"]')?.className
    ).toContain('hover:bg-sky-400');

    await act(async () => {
      host
        .querySelector('[data-testid="runtime-provider-row-openrouter"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');
    expect(actions.selectProvider).not.toHaveBeenCalled();

    vi.mocked(actions.startConnect).mockClear();

    await act(async () => {
      const connect = Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes('Connect')
      );
      connect?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            apiKeyValue: 'sk-secret-value',
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
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('input[type="password"]')).not.toBeNull();
    expect(host.textContent).not.toContain('sk-secret-value');
  });

  it('allows supported setup forms that do not require a secret to submit', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            activeFormProviderId: 'openrouter',
            setupForm: {
              runtimeId: 'opencode',
              providerId: 'openrouter',
              displayName: 'OpenRouter',
              method: 'oauth',
              supported: true,
              title: 'Connect OpenRouter',
              description: null,
              submitLabel: 'Connect',
              disabledReason: null,
              source: 'oauth',
              secret: null,
              prompts: [],
            },
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const submitButton = Array.from(host.querySelectorAll('button'))
      .filter((button) => button.textContent?.trim() === 'Connect')
      .at(-1);
    expect(submitButton?.disabled).toBe(false);
  });

  it('renders multiple compact provider actions without hiding forget behind connect', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const provider = {
      ...createState().view!.providers[0],
      actions: [
        {
          id: 'connect' as const,
          label: 'Connect',
          enabled: true,
          disabledReason: null,
          requiresSecret: true,
          ownershipScope: 'managed' as const,
        },
        {
          id: 'forget' as const,
          label: 'Forget',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'managed' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [provider],
            },
            providers: [provider],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const buttons = Array.from(host.querySelectorAll('button'));
    expect(buttons.some((button) => button.textContent?.includes('Connect'))).toBe(true);
    expect(buttons.some((button) => button.textContent?.includes('Forget'))).toBe(true);

    await act(async () => {
      buttons
        .find((button) => button.textContent?.includes('Forget'))
        ?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).not.toHaveBeenCalled();

    await act(async () => {
      buttons
        .find((button) => button.textContent?.includes('Forget'))
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.forgetProvider).toHaveBeenCalledWith('openrouter');
    expect(actions.startConnect).not.toHaveBeenCalled();
  });

  it('supports keyboard activation for compact provider rows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: { ...state, providers: state.view?.providers ?? [] },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector('[data-testid="runtime-provider-row-openrouter"]');
    expect(row?.getAttribute('role')).toBe('button');
    expect(row?.getAttribute('tabindex')).toBe('0');

    await act(async () => {
      row?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('openrouter');
  });

  it('filters providers from the local provider search', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const openRouterProvider = createState().view!.providers[0];
    const openAiProvider = {
      ...openRouterProvider,
      providerId: 'openai',
      displayName: 'OpenAI',
      recommended: false,
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [openRouterProvider, openAiProvider],
            },
            providers: [openRouterProvider, openAiProvider],
            providerQuery: 'router',
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).not.toContain('OpenAI');

    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();
  });

  it('does not open a model list for a render-only filtered fallback provider', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const openRouterProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      modelCount: 174,
      actions: [],
    };
    const openAiProvider = {
      ...openRouterProvider,
      providerId: 'openai',
      displayName: 'OpenAI',
      recommended: false,
      defaultModelId: 'openai/gpt-5.4-mini-fast',
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [openRouterProvider, openAiProvider],
            },
            providers: [openRouterProvider, openAiProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            providerQuery: 'openai',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/openai/gpt-oss-20b:free',
                displayName: 'openai/gpt-oss-20b:free',
                sourceLabel: 'OpenRouter',
                free: true,
                default: false,
                availability: 'untested',
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenAI');
    expect(host.textContent).not.toContain('OpenRouter');
    expect(
      host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')
    ).toBeNull();
  });

  it('opens the OpenCode provider directory and renders directory rows', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 115,
            directoryEntries: [
              {
                providerId: 'deepseek',
                displayName: 'DeepSeek',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 62,
                defaultModelId: null,
                authMethods: [],
                actions: [
                  {
                    id: 'configure',
                    label: 'Configure manually',
                    enabled: false,
                    disabledReason: 'OpenCode did not advertise API-key auth',
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'Models are visible, but no connected credential was reported',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: false,
                },
              },
              {
                providerId: 'cloudflare-workers-ai',
                displayName: 'Cloudflare Workers AI',
                state: 'not-connected',
                setupKind: 'connect-api-key',
                ownership: [],
                recommended: false,
                modelCount: 8,
                defaultModelId: null,
                authMethods: ['api'],
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
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'App-managed API-key setup is available for this provider',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: true,
                  configuredAuthless: false,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('115 OpenCode providers');
    expect(host.textContent).toContain('DeepSeek');
    expect(host.textContent).toContain('Cloudflare Workers AI');
    expect(host.textContent).toContain('62 models');
    expect(host.textContent).toContain('OpenCode catalog');
    expect(host.querySelector('[data-testid="runtime-provider-search"]')).not.toBeNull();

    await act(async () => {
      host
        .querySelector('[data-testid="runtime-provider-directory-row-deepseek"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
    expect(actions.startConnect).not.toHaveBeenCalled();

    await act(async () => {
      host
        .querySelector('[data-testid="runtime-provider-directory-row-cloudflare-workers-ai"]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.startConnect).toHaveBeenCalledWith('cloudflare-workers-ai');
    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
  });

  it('shows an explicit zero-provider catalog count', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 0,
            directoryEntries: [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('0 OpenCode providers');
    expect(host.textContent).not.toContain('OpenCode provider catalog.');
  });

  it('uses singular provider catalog copy for one provider', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('1 OpenCode provider.');
    expect(host.textContent).not.toContain('1 OpenCode providers');
  });

  it('renders every advertised directory action instead of hiding configure behind connect', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'manual-connectable',
                displayName: 'Manual Connectable',
                state: 'not-connected',
                setupKind: 'connect-api-key',
                ownership: [],
                recommended: false,
                modelCount: 1,
                defaultModelId: null,
                authMethods: ['api'],
                actions: [
                  {
                    id: 'connect',
                    label: 'Connect',
                    enabled: true,
                    disabledReason: null,
                    requiresSecret: true,
                    ownershipScope: 'managed',
                  },
                  {
                    id: 'configure',
                    label: 'Configure manually',
                    enabled: false,
                    disabledReason: 'Manual fallback is also available',
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: null,
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: true,
                  supportedInlineAuth: true,
                  configuredAuthless: false,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector(
      '[data-testid="runtime-provider-directory-row-manual-connectable"]'
    );
    const actionLabels = Array.from(row?.querySelectorAll('button') ?? []).map((button) =>
      button.textContent?.trim()
    );

    expect(actionLabels).toContain('Connect');
    expect(actionLabels).toContain('Configure manually');
  });

  it('opens model list for configured authless local directory providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'llama.cpp',
                displayName: 'llama.cpp',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 1,
                defaultModelId: null,
                authMethods: [],
                actions: [
                  {
                    id: 'test',
                    label: 'Test',
                    enabled: true,
                    disabledReason: null,
                    requiresSecret: false,
                    ownershipScope: 'runtime',
                  },
                ],
                sources: ['config-provider'],
                sourceLabel: 'configured',
                providerSource: null,
                detail: 'Configured local OpenCode model route is available',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: true,
                },
              },
            ],
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-directory-row-llama.cpp"]'
    );
    expect(row?.textContent).toContain('Configured local');

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.selectDirectoryProvider).toHaveBeenCalledWith('llama.cpp');
  });

  it('uses the unified provider search when compact search has no matches', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const state = createState();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: {
            ...state,
            providers: state.view?.providers ?? [],
            providerQuery: 'deep',
            directoryLoaded: true,
            directoryTotalCount: 1,
            directoryEntries: [
              {
                providerId: 'deepseek',
                displayName: 'DeepSeek',
                state: 'available',
                setupKind: 'available-readonly',
                ownership: [],
                recommended: false,
                modelCount: 62,
                defaultModelId: null,
                authMethods: [],
                actions: [],
                sources: ['opencode-provider'],
                sourceLabel: 'OpenCode catalog',
                providerSource: 'models.dev',
                detail: 'Models are visible, but no connected credential was reported',
                metadata: {
                  hasKnownModels: true,
                  requiresManualConfig: false,
                  supportedInlineAuth: false,
                  configuredAuthless: false,
                },
              },
            ],
          },
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('DeepSeek');
    expect(host.textContent).not.toContain('Search all OpenCode providers');
  });

  it('renders connected provider model picker actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      state: 'connected' as const,
      ownership: ['managed'] as const,
      recommended: true,
      modelCount: 174,
      defaultModelId: null,
      authMethods: ['api'] as const,
      actions: [
        {
          id: 'use' as const,
          label: 'Use',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
        {
          id: 'set-default' as const,
          label: 'Set default',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
      detail: null,
    };
    const state = createState({
      view: {
        ...createState().view!,
        providers: [connectedProvider],
      },
      providers: [connectedProvider],
      modelPickerProviderId: 'openrouter',
      modelPickerMode: 'use',
      models: [
        {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-20b:free',
          displayName: 'openai/gpt-oss-20b:free',
          sourceLabel: 'OpenRouter',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'opencode/big-pickle',
          displayName: 'opencode/big-pickle',
          sourceLabel: 'OpenCode',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/qwen/qwen3-coder-plus',
          displayName: 'qwen/qwen3-coder-plus',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-120b:free',
          displayName: 'openai/gpt-oss-120b:free',
          sourceLabel: 'OpenRouter',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'opencode/minimax-m2.5-free',
          displayName: 'minimax-m2.5-free',
          sourceLabel: 'OpenCode',
          free: true,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/mistralai/codestral-2508',
          displayName: 'mistralai/codestral-2508',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
        {
          providerId: 'openrouter',
          modelId: 'openrouter/anthropic/claude-sonnet-4.6',
          displayName: 'anthropic/claude-sonnet-4.6',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
      ],
      selectedModelId: 'openrouter/openai/gpt-oss-20b:free',
      modelResults: {
        'openrouter/openai/gpt-oss-20b:free': {
          providerId: 'openrouter',
          modelId: 'openrouter/openai/gpt-oss-20b:free',
          ok: true,
          availability: 'available',
          message: 'Model probe passed',
          diagnostics: [],
        },
      },
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state,
          actions,
          disabled: false,
          projectPath: '/tmp/project',
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('openrouter/openai/gpt-oss-20b:free');
    expect(host.textContent).toContain('Used in team picker');
    expect(host.textContent).toContain('Model probe passed');
    expect(host.textContent).toContain('Recommended');
    expect(host.textContent).toContain('Not recommended');
    expect(host.textContent).toContain('Not verified in OpenCode');
    expect(host.textContent).toContain('Tested');
    expect(host.textContent).toContain('Tested with limits');
    expect(host.textContent).toContain('Recommended only');
    expect(host.textContent).not.toContain('Set OpenCode default');
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Use in team picker'
      )
    ).toBe(false);
    expect(
      host.querySelector('[data-testid="runtime-provider-logo-openrouter"] svg')
    ).not.toBeNull();
    const connectedBadge = Array.from(host.querySelectorAll('span')).find(
      (span) => span.textContent === 'Connected'
    );
    expect(connectedBadge).toBeInstanceOf(HTMLSpanElement);
    expect(connectedBadge?.style.color).toBeTruthy();
    const modelSearch = host.querySelector<HTMLInputElement>(
      '[data-testid="runtime-provider-model-search"]'
    );
    const modelList = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-list"]'
    );
    expect(modelSearch?.style.paddingLeft).toBe('42px');
    expect(modelList?.style.maxHeight).toBe('300px');
    expect(host.textContent).not.toContain('OpenRouterfree');
    const firstTestButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test'
    );
    expect(firstTestButton?.className).toContain('border');
    const modelResult = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-result-openrouter/openai/gpt-oss-20b:free"]'
    );
    expect(modelResult).toBeInstanceOf(HTMLElement);
    expect(modelResult?.style.color).toBe('#86efac');
    expect((host.textContent ?? '').indexOf('mistralai/codestral-2508')).toBeLessThan(
      (host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')
    );
    expect((host.textContent ?? '').indexOf('opencode/big-pickle')).toBeLessThan(
      (host.textContent ?? '').indexOf('minimax-m2.5-free')
    );
    expect((host.textContent ?? '').indexOf('mistralai/codestral-2508')).toBeLessThan(
      (host.textContent ?? '').indexOf('minimax-m2.5-free')
    );
    expect((host.textContent ?? '').indexOf('minimax-m2.5-free')).toBeLessThan(
      (host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')
    );
    expect((host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')).toBeLessThan(
      (host.textContent ?? '').indexOf('openrouter/openai/gpt-oss-20b:free')
    );
    await act(async () => {
      host
        .querySelector(
          '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).toHaveBeenCalledWith('openrouter/openai/gpt-oss-20b:free');
    expect(actions.selectProvider).not.toHaveBeenCalled();

    vi.mocked(actions.useModelForNewTeams).mockClear();
    await act(async () => {
      const notRecommendedRow = host.querySelector(
        '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
      );
      const notRecommendedTestButton = Array.from(
        notRecommendedRow?.querySelectorAll('button') ?? []
      ).find((button) => button.textContent?.trim() === 'Test');
      notRecommendedTestButton?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true })
      );
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();

    await act(async () => {
      const notRecommendedRow = host.querySelector(
        '[data-testid="runtime-provider-model-row-openrouter/openai/gpt-oss-20b:free"]'
      );
      const notRecommendedTestButton = Array.from(
        notRecommendedRow?.querySelectorAll('button') ?? []
      ).find((button) => button.textContent?.trim() === 'Test');
      notRecommendedTestButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.testModel).toHaveBeenCalledWith(
      'openrouter',
      'openrouter/openai/gpt-oss-20b:free'
    );
    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
  });

  it('keeps the model search input enabled while model results are loading', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 174,
      actions: [
        {
          id: 'use' as const,
          label: 'Use',
          enabled: true,
          disabledReason: null,
          requiresSecret: false,
          ownershipScope: 'runtime' as const,
        },
      ],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            modelQuery: 'claude',
            modelsLoading: true,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-testid="runtime-provider-model-search"]'
    );

    expect(searchInput).not.toBeNull();
    expect(searchInput?.disabled).toBe(false);
    expect(searchInput?.value).toBe('claude');
    expect(host.querySelector('[data-testid="runtime-provider-model-loading-skeleton"]')).not.toBe(
      null
    );
  });

  it('does not expose disabled model rows as active buttons', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const connectedProvider = {
      ...createState().view!.providers[0],
      state: 'connected' as const,
      ownership: ['managed'] as const,
      modelCount: 1,
      actions: [],
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers: [connectedProvider],
            },
            providers: [connectedProvider],
            selectedProviderId: 'openrouter',
            modelPickerProviderId: 'openrouter',
            modelPickerMode: 'use',
            models: [
              {
                providerId: 'openrouter',
                modelId: 'openrouter/google/gemini-3-flash-preview',
                displayName: 'google/gemini-3-flash-preview',
                sourceLabel: 'OpenRouter',
                free: false,
                default: false,
                availability: 'untested',
              },
            ],
          }),
          actions,
          disabled: true,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>(
      '[data-testid="runtime-provider-model-row-openrouter/google/gemini-3-flash-preview"]'
    );

    expect(row?.getAttribute('role')).toBeNull();
    expect(row?.getAttribute('aria-disabled')).toBe('true');
    expect(row?.tabIndex).toBe(-1);

    await act(async () => {
      row?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).not.toHaveBeenCalled();
  });

  it('keeps directory provider models visible when a model row is selected', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const provider = {
      providerId: 'openrouter',
      displayName: 'OpenRouter',
      state: 'connected' as const,
      ownership: ['managed'] as const,
      recommended: true,
      modelCount: 174,
      defaultModelId: null,
      authMethods: ['api'] as const,
      actions: [],
      sources: ['opencode-provider'] as const,
      sourceLabel: 'OpenCode catalog',
      providerSource: 'models.dev',
      detail: 'Connected via app-managed OpenCode credential',
      setupKind: 'connected' as const,
      metadata: {
        hasKnownModels: true,
        requiresManualConfig: false,
        supportedInlineAuth: true,
        configuredAuthless: false,
      },
    };
    const state = createState({
      providers: [],
      directoryLoaded: true,
      directoryEntries: [provider],
      directoryTotalCount: 1,
      selectedProviderId: 'openrouter',
      modelPickerProviderId: 'openrouter',
      modelPickerMode: 'use',
      models: [
        {
          providerId: 'openrouter',
          modelId: 'openrouter/google/gemini-3-flash-preview',
          displayName: 'google/gemini-3-flash-preview',
          sourceLabel: 'OpenRouter',
          free: false,
          default: false,
          availability: 'untested',
        },
      ],
    });

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state,
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      host
        .querySelector(
          '[data-testid="runtime-provider-model-row-openrouter/google/gemini-3-flash-preview"]'
        )
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.useModelForNewTeams).toHaveBeenCalledWith(
      'openrouter/google/gemini-3-flash-preview'
    );
    expect(actions.selectDirectoryProvider).not.toHaveBeenCalled();
    expect(host.textContent).toContain('google/gemini-3-flash-preview');
    expect(host.textContent).not.toContain('No models found.');
  });

  it('renders verified brand icons for common OpenCode providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseProvider = createState().view!.providers[0];
    const providers = [
      { providerId: 'openrouter', displayName: 'OpenRouter' },
      { providerId: 'opencode', displayName: 'OpenCode Zen' },
      { providerId: 'openai', displayName: 'OpenAI' },
      { providerId: 'anthropic', displayName: 'Anthropic' },
      { providerId: 'google', displayName: 'Google' },
      { providerId: 'google-vertex', displayName: 'Vertex' },
      { providerId: 'vercel', displayName: 'Vercel AI Gateway' },
      { providerId: 'mistral', displayName: 'Mistral' },
      { providerId: 'github-models', displayName: 'GitHub Models' },
      { providerId: 'perplexity-agent', displayName: 'Perplexity Agent' },
      { providerId: 'nvidia', displayName: 'Nvidia' },
      { providerId: 'minimax', displayName: 'MiniMax' },
      { providerId: 'cloudflare-ai-gateway', displayName: 'Cloudflare AI Gateway' },
      { providerId: 'cloudflare-workers-ai', displayName: 'Cloudflare Workers AI' },
      { providerId: 'gitlab-duo', displayName: 'GitLab Duo' },
      { providerId: 'poe', displayName: 'Poe' },
    ].map((provider) => ({
      ...baseProvider,
      ...provider,
      state: 'not-connected' as const,
      recommended: false,
    }));

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers,
            },
            providers,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    for (const provider of providers) {
      const logo = host.querySelector(
        `[data-testid="runtime-provider-logo-${provider.providerId}"]`
      );
      expect(logo).not.toBeNull();
      expect(logo?.className).toContain('runtime-provider-brand-icon');
      expect(logo?.querySelector('svg,img')).not.toBeNull();
      expect(logo?.getAttribute('style')).toContain('--runtime-provider-brand-fallback-background');
      expect(logo?.getAttribute('style')).toContain('--runtime-provider-brand-fallback-border');
      if (logo?.querySelector('svg')) {
        expect(logo.getAttribute('style')).toContain('--runtime-provider-brand-fallback-color');
      }
    }
  });

  it('uses Models.dev logos only for verified providers and initials for unknown providers', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseProvider = createState().view!.providers[0];
    const providers = [
      { providerId: 'xai', displayName: 'xAI', logo: 'xai' },
      { providerId: 'groq', displayName: 'Groq', logo: 'groq' },
      { providerId: 'deepseek', displayName: 'DeepSeek', logo: 'deepseek' },
      { providerId: 'cohere', displayName: 'Cohere', logo: 'cohere' },
      {
        providerId: 'cloudferro-sherlock',
        displayName: 'CloudFerro Sherlock',
        logo: 'cloudferro-sherlock',
      },
      { providerId: 'clarifai', displayName: 'Clarifai', label: 'CL' },
      { providerId: 'unknown-provider', displayName: 'Unknown Provider', label: 'UN' },
    ].map((provider) => ({
      ...baseProvider,
      ...provider,
      state: 'not-connected' as const,
      recommended: false,
    }));

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderManagementPanelView, {
          state: createState({
            view: {
              ...createState().view!,
              providers,
            },
            providers,
          }),
          actions,
          disabled: false,
        })
      );
      await Promise.resolve();
    });

    for (const provider of providers) {
      const logo = host.querySelector(
        `[data-testid="runtime-provider-logo-${provider.providerId}"]`
      );
      if ('logo' in provider) {
        const image = logo?.querySelector('img') as HTMLImageElement | null;
        expect(image?.src).toContain(`https://models.dev/logos/${provider.logo}.svg`);
        expect(logo?.className).toContain('runtime-provider-brand-icon');
      } else {
        expect(logo?.textContent).toBe(provider.label);
      }
    }
  });
});
