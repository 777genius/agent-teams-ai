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
    activeFormProviderId: null,
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
    startConnect: vi.fn(),
    cancelConnect: vi.fn(),
    setApiKeyValue: vi.fn(),
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

    expect(actions.selectProvider).toHaveBeenCalledWith('openrouter');

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
    expect(host.textContent).toContain('Recommended only');
    expect(host.textContent).toContain('Recommended');
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
      (host.textContent ?? '').indexOf('opencode/big-pickle')
    );
    expect((host.textContent ?? '').indexOf('opencode/big-pickle')).toBeLessThan(
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
    expect(host.textContent).not.toContain('opencode/big-pickle');
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
      expect(logo?.querySelector('svg,img')).not.toBeNull();
    }
  });

  it('uses branded initials for popular providers without verified compact logo assets', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const actions = createActions();
    const baseProvider = createState().view!.providers[0];
    const providers = [
      { providerId: 'xai', displayName: 'xAI', label: 'xAI' },
      { providerId: 'groq', displayName: 'Groq', label: 'G' },
      { providerId: 'deepseek', displayName: 'DeepSeek', label: 'DS' },
      { providerId: 'deepinfra', displayName: 'Deep Infra', label: 'DI' },
      { providerId: 'fireworks-ai', displayName: 'Fireworks AI', label: 'FW' },
      { providerId: 'togetherai', displayName: 'Together AI', label: 'TA' },
      { providerId: 'amazon-bedrock', displayName: 'Amazon Bedrock', label: 'AWS' },
      { providerId: 'azure', displayName: 'Azure', label: 'AZ' },
      { providerId: 'cohere', displayName: 'Cohere', label: 'CO' },
      { providerId: 'ollama-cloud', displayName: 'Ollama Cloud', label: 'OL' },
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
      expect(logo?.textContent).toBe(provider.label);
    }
  });
});
