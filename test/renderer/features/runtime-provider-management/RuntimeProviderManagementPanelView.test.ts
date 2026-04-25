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
    directoryOpen: false,
    directoryLoading: false,
    directoryRefreshing: false,
    directoryError: null,
    directoryEntries: [],
    directoryTotalCount: null,
    directoryNextCursor: null,
    directoryQuery: '',
    directoryFilter: 'all',
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
    testingModelId: null,
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
    openDirectory: vi.fn(),
    closeDirectory: vi.fn(),
    setDirectoryQuery: vi.fn(),
    setDirectoryFilter: vi.fn(),
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
    expect(host.textContent).toContain('Loading OpenCode providers');
    expect(host.querySelector('[data-testid="runtime-provider-loading-skeleton"]')).not.toBeNull();
    expect(host.querySelectorAll('.skeleton-shimmer').length).toBeGreaterThanOrEqual(10);
    expect(host.textContent).toContain('Checking...');
    const refreshButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Checking...')
    );
    expect(refreshButton?.disabled).toBe(true);
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
            directoryOpen: true,
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
          modelId: 'openrouter/qwen/qwen3-coder-flash',
          displayName: 'qwen/qwen3-coder-flash',
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
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('openrouter/openai/gpt-oss-20b:free');
    expect(host.textContent).toContain('Used for new teams');
    expect(host.textContent).toContain('Model probe passed');
    expect(host.textContent).toContain('Not recommended');
    expect(host.textContent).toContain('Unavailable in OpenCode');
    expect(host.textContent).toContain('Recommended only');
    expect(host.textContent).toContain('Recommended');
    expect(host.textContent).toContain('Recommended with limits');
    expect(host.textContent).not.toContain('Set OpenCode default');
    expect(
      Array.from(host.querySelectorAll('button')).some(
        (button) => button.textContent?.trim() === 'Use for new teams'
      )
    ).toBe(false);
    expect(
      host.querySelector('[data-testid="runtime-provider-logo-openrouter"] svg')
    ).not.toBeNull();
    const connectedBadge = Array.from(host.querySelectorAll('span')).find(
      (span) => span.textContent === 'Connected'
    ) as HTMLElement | undefined;
    expect(connectedBadge?.style.color).toBeTruthy();
    expect(
      (
        host.querySelector(
          '[data-testid="runtime-provider-model-search"]'
        ) as HTMLElement | null
      )?.style.paddingLeft
    ).toBe('42px');
    expect(
      (host.querySelector('[data-testid="runtime-provider-model-list"]') as HTMLElement | null)
        ?.style.maxHeight
    ).toBe('300px');
    expect(host.textContent).not.toContain('OpenRouterfree');
    const firstTestButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Test'
    );
    expect(firstTestButton?.className).toContain('border');
    const modelResult = host.querySelector(
      '[data-testid="runtime-provider-model-result-openrouter/openai/gpt-oss-20b:free"]'
    ) as HTMLElement | null;
    expect(modelResult?.style.color).toBe('#86efac');
    expect((host.textContent ?? '').indexOf('qwen/qwen3-coder-flash')).toBeLessThan(
      (host.textContent ?? '').indexOf('openai/gpt-oss-120b:free')
    );
    expect((host.textContent ?? '').indexOf('openai/gpt-oss-120b:free')).toBeLessThan(
      (host.textContent ?? '').indexOf('opencode/big-pickle')
    );
    expect((host.textContent ?? '').indexOf('opencode/big-pickle')).toBeLessThan(
      (host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')
    );
    expect((host.textContent ?? '').indexOf('qwen/qwen3-coder-plus')).toBeLessThan(
      (host.textContent ?? '').indexOf('openrouter/openai/gpt-oss-20b:free')
    );

    await act(async () => {
      const checkbox = Array.from(host.querySelectorAll('button')).find(
        (button) => button.getAttribute('role') === 'checkbox'
      );
      checkbox?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('qwen/qwen3-coder-flash');
    expect(host.textContent).toContain('openai/gpt-oss-120b:free');
    expect(host.textContent).not.toContain('opencode/big-pickle');
    expect(host.textContent).not.toContain('qwen/qwen3-coder-plus');
    expect(host.textContent).not.toContain('openrouter/openai/gpt-oss-20b:free');

    await act(async () => {
      const checkbox = Array.from(host.querySelectorAll('button')).find(
        (button) => button.getAttribute('role') === 'checkbox'
      );
      checkbox?.click();
      await Promise.resolve();
    });

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
      notRecommendedTestButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(actions.testModel).toHaveBeenCalledWith(
      'openrouter',
      'openrouter/openai/gpt-oss-20b:free'
    );
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
      ) as HTMLElement | null;
      expect(logo).not.toBeNull();
      expect(logo?.className).toContain('runtime-provider-brand-icon');
      expect(logo?.querySelector('svg,img')).not.toBeNull();
      expect(logo?.getAttribute('style')).toContain(
        '--runtime-provider-brand-fallback-background'
      );
      expect(logo?.getAttribute('style')).toContain('--runtime-provider-brand-fallback-border');
      if (logo?.querySelector('svg')) {
        expect(logo.getAttribute('style')).toContain(
          '--runtime-provider-brand-fallback-color'
        );
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
