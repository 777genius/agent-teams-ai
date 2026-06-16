import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

vi.mock('@renderer/components/ui/tabs', () => {
  let currentValue = '';
  let currentOnValueChange: ((value: string) => void) | null = null;

  return {
    Tabs: ({
      children,
      value,
      onValueChange,
    }: {
      children: React.ReactNode;
      value: string;
      onValueChange?: (value: string) => void;
    }) => {
      currentValue = value;
      currentOnValueChange = onValueChange ?? null;
      return React.createElement('div', { 'data-tabs-value': value }, children);
    },
    TabsList: ({ children }: { children: React.ReactNode }) =>
      React.createElement('div', null, children),
    TabsTrigger: ({
      children,
      value,
      disabled,
      title,
      'aria-disabled': ariaDisabled,
    }: {
      children: React.ReactNode;
      value: string;
      disabled?: boolean;
      title?: string;
      'aria-disabled'?: boolean;
    }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          disabled,
          title,
          'aria-disabled': ariaDisabled,
          'data-state': currentValue === value ? 'active' : 'inactive',
          onClick: () => {
            if (!disabled) {
              currentOnValueChange?.(value);
            }
          },
        },
        children
      ),
  };
});

const storeState = {
  cliStatus: null as unknown,
  cliStatusLoading: false,
  cliProviderStatusLoading: {} as Record<string, boolean>,
  appConfig: { general: { multimodelEnabled: true } },
  fetchCliProviderStatus: vi.fn().mockResolvedValue(undefined),
};
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(undefined)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: unknown) => unknown) => selector(storeState),
}));

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

const useVirtualizerMock = vi.fn(
  (options: { count: number }) =>
    ({
      getVirtualItems: () =>
        Array.from({ length: Math.min(options.count, 9) }, (_, index) => ({
          index,
          key: index,
          start: index * 92,
          size: 92,
        })),
      getTotalSize: () => options.count * 92,
      measureElement: () => undefined,
    }) as const
);

vi.mock('@tanstack/react-virtual', () => ({
  useVirtualizer: (options: { count: number }) => useVirtualizerMock(options),
}));

import { TeamModelSelector } from '@renderer/components/team/dialogs/TeamModelSelector';

describe('TeamModelSelector disabled Codex models', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    Reflect.deleteProperty(window, 'electronAPI');
    storeState.cliStatus = null;
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};
    storeState.fetchCliProviderStatus.mockClear();
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
    codexAccountHookState.refresh.mockClear();
    codexAccountHookState.startChatgptLogin.mockClear();
    codexAccountHookState.cancelChatgptLogin.mockClear();
    codexAccountHookState.logout.mockClear();
    useVirtualizerMock.mockClear();
  });

  it('shows only Default while Codex runtime models are still loading', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    Object.defineProperty(window, 'electronAPI', { value: {}, configurable: true });
    storeState.cliStatusLoading = true;
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Default');
    expect(host.querySelector('[data-testid="provider-activity-status-codex"]')).not.toBeNull();
    expect(host.textContent).not.toContain('5.1 Codex Mini');
    expect(host.textContent).not.toContain('5.3 Codex Spark');
    const defaultButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.trim().startsWith('Default')
    );
    expect(defaultButton?.getAttribute('title')).toBe(
      'Uses the runtime default for the selected provider.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('normalizes a stale disabled selection back to default', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.1-codex-mini',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('normalizes a stale 5.3 Codex Spark selection back to default', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.3-codex-spark',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides recommendation badges for Anthropic and Codex model tiles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const anthropicButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Opus 4.6')
    );
    expect(anthropicButton).toBeDefined();
    expect(anthropicButton?.textContent).not.toContain('Recommended');

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const codexButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2')
    );
    expect(codexButton).toBeDefined();
    expect(codexButton?.textContent).not.toContain('Recommended');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a temporary New ribbon for Opus 4.8 during the launch window', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 4, 31));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: 'opus',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const opus48Button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.trim().startsWith('Opus 4.8')
    );
    expect(opus48Button?.textContent).toContain('New');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    dateNowSpy.mockRestore();
  });

  it('hides the Opus 4.8 New ribbon after the launch window expires', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const dateNowSpy = vi.spyOn(Date, 'now').mockReturnValue(Date.UTC(2026, 5, 12));
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: 'opus',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const opus48Button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.trim().startsWith('Opus 4.8')
    );
    expect(opus48Button?.textContent).not.toContain('New');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    dateNowSpy.mockRestore();
  });

  it('uses the runtime-reported Codex list and clears stale unsupported selections', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.3-codex'],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.2-codex',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('');
    expect(host.textContent).toContain('5.4');
    expect(host.textContent).toContain('5.3 Codex');
    const disabledCodexButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2 Codex')
    );
    expect(disabledCodexButton).not.toBeNull();
    expect(disabledCodexButton?.getAttribute('aria-disabled')).toBe('true');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders Anthropic-compatible catalog models instead of Claude fallback aliases', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onValueChange = vi.fn();
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'anthropic',
          models: [],
          authMethod: 'auth_token',
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          connection: {
            supportsOAuth: true,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'oauth', 'api_key'],
            configuredAuthMode: 'auto',
            apiKeyConfigured: false,
            apiKeySource: null,
            apiKeySourceLabel: null,
            compatibleEndpoint: {
              enabled: true,
              baseUrl: 'http://localhost:1234',
              tokenConfigured: true,
              tokenSource: 'stored',
              tokenSourceLabel: 'Stored in app',
            },
          },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-compatible-api',
            status: 'ready',
            fetchedAt: '2026-05-21T00:00:00.000Z',
            staleAt: '2026-05-21T00:10:00.000Z',
            defaultModelId: 'openai/gpt-oss-20b',
            defaultLaunchModel: 'openai/gpt-oss-20b',
            models: [
              {
                id: 'openai/gpt-oss-20b',
                launchModel: 'openai/gpt-oss-20b',
                displayName: 'GPT OSS 20B',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-compatible-api',
                badgeLabel: 'Local',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('GPT OSS 20B');
    expect(host.textContent).not.toContain('Opus 4.7');
    expect(
      host.querySelector('[data-testid="team-model-selector-anthropic-compatible-custom-model"]')
    ).toBeNull();
    const defaultModelButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Default')
    );
    expect(defaultModelButton?.getAttribute('title')).toContain(
      'Anthropic-compatible endpoint default model'
    );
    expect(defaultModelButton?.getAttribute('title')).toContain('openai/gpt-oss-20b');
    const localModelButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('GPT OSS 20B')
    );
    expect(localModelButton).toBeDefined();

    await act(async () => {
      localModelButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('openai/gpt-oss-20b');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders Anthropic-compatible custom model input for degraded catalogs', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const onValueChange = vi.fn();
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'anthropic',
          models: [],
          authMethod: 'auth_token',
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          connection: {
            supportsOAuth: true,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'oauth', 'api_key'],
            configuredAuthMode: 'auto',
            apiKeyConfigured: false,
            apiKeySource: null,
            apiKeySourceLabel: null,
            compatibleEndpoint: {
              enabled: true,
              baseUrl: 'http://localhost:1234',
              tokenConfigured: true,
              tokenSource: 'stored',
              tokenSourceLabel: 'Stored in app',
            },
          },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-compatible-api',
            status: 'degraded',
            fetchedAt: '2026-05-21T00:00:00.000Z',
            staleAt: '2026-05-21T00:10:00.000Z',
            defaultModelId: null,
            defaultLaunchModel: null,
            models: [],
            diagnostics: {
              configReadState: 'failed',
              appServerState: 'degraded',
              message: 'Local catalog unavailable',
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: 'openai/gpt-oss-20b',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const customInput = host.querySelector<HTMLInputElement>(
      '[data-testid="team-model-selector-anthropic-compatible-custom-model"]'
    );
    expect(customInput).toBeTruthy();
    expect(customInput?.value).toBe('openai/gpt-oss-20b');
    expect(host.textContent).toContain('Local catalog unavailable');

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setValue?.call(customInput, 'qwen/qwen3-coder');
      customInput?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('qwen/qwen3-coder');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('labels, sorts, and filters OpenCode models with real Agent Teams E2E recommendations', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'api_key',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          models: [
            'openrouter/openai/gpt-oss-20b:free',
            'openrouter/qwen/qwen3-coder-plus',
            'opencode/big-pickle',
            'opencode/minimax-m2.5-free',
            'openrouter/openai/gpt-oss-120b:free',
            'openrouter/mistralai/codestral-2508',
            'openrouter/anthropic/claude-sonnet-4.6',
          ],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('anthropic/claude-sonnet-4.6');
    expect(host.textContent).toContain('Tested');
    expect(host.textContent).toContain('mistralai/codestral-2508');
    expect(host.textContent).toContain('Tested');
    expect(host.textContent).toContain('minimax-m2.5-free');
    expect(host.textContent).toContain('Tested with limits');
    expect(host.textContent).toContain('openai/gpt-oss-120b:free');
    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('qwen/qwen3-coder-plus');
    expect(host.textContent).toContain('Not verified in OpenCode');
    expect(host.textContent).toContain('openai/gpt-oss-20b:free');
    expect(host.textContent).toContain('Not recommended');
    const groupLabels = Array.from(
      host.querySelectorAll('[data-testid="team-model-selector-opencode-group"] h4')
    ).map((heading) => heading.textContent ?? '');
    expect(groupLabels).toContain('OpenCode');
    expect(groupLabels).toContain('OpenRouter');
    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).toContain('OpenRouter');

    const buttonTexts = Array.from(host.querySelectorAll('button')).map(
      (button) => button.textContent ?? ''
    );
    const sonnetIndex = buttonTexts.findIndex((text) =>
      text.includes('anthropic/claude-sonnet-4.6')
    );
    const testedIndex = buttonTexts.findIndex((text) => text.includes('mistralai/codestral-2508'));
    const recommendedIndex = buttonTexts.findIndex((text) => text.includes('big-pickle'));
    const limitedIndex = buttonTexts.findIndex((text) => text.includes('minimax-m2.5-free'));
    const notRecommendedIndex = buttonTexts.findIndex((text) =>
      text.includes('openai/gpt-oss-20b:free')
    );
    const unavailableIndex = buttonTexts.findIndex((text) =>
      text.includes('qwen/qwen3-coder-plus')
    );
    expect(sonnetIndex).toBeGreaterThanOrEqual(0);
    expect(recommendedIndex).toBeGreaterThanOrEqual(0);
    expect(limitedIndex).toBeGreaterThanOrEqual(0);
    expect(testedIndex).toBeGreaterThanOrEqual(0);
    expect(limitedIndex).toBeGreaterThan(recommendedIndex);
    expect(testedIndex).toBeGreaterThan(recommendedIndex);
    expect(unavailableIndex).toBeGreaterThan(limitedIndex);
    expect(notRecommendedIndex).toBeGreaterThan(unavailableIndex);

    expect(host.textContent).toContain('Recommended only');
    expect(host.textContent).toContain('Free only');

    const freeOnlyToggle = host.querySelector<HTMLElement>('#opencode-team-model-free-only');
    expect(freeOnlyToggle).not.toBeNull();

    await act(async () => {
      freeOnlyToggle?.click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('openai/gpt-oss-120b:free');
    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('openai/gpt-oss-20b:free');
    expect(host.textContent).not.toContain('qwen/qwen3-coder-plus');
    expect(host.textContent).not.toContain('anthropic/claude-sonnet-4.6');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows an OpenCode catalog loading skeleton instead of the transient big-pickle placeholder', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          models: ['opencode/big-pickle'],
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
          },
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(
      host.querySelector('[data-testid="team-model-selector-opencode-loading-skeleton"]')
    ).not.toBeNull();
    expect(host.textContent).toContain('Default');
    expect(host.textContent).toContain('Loading OpenCode models...');
    expect(host.textContent).not.toContain('big-pickle');
    expect(host.textContent).not.toContain('Recommended only');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('virtualizes large OpenCode model lists instead of rendering every model tile', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const models = Array.from(
      { length: 160 },
      (_, index) => `openrouter/test/model-${String(index).padStart(3, '0')}`
    );
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          models,
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const virtualizerOptions = useVirtualizerMock.mock.calls.at(-1)?.[0] as
      | { count: number }
      | undefined;
    expect(virtualizerOptions?.count).toBeGreaterThan(80);
    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).toContain('test/model-000');
    expect(host.textContent).not.toContain('test/model-159');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows short-lived OpenCode preflight failures as unavailable model tiles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openai/gpt-5.4', 'opencode/big-pickle'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
          modelUnavailableReasonByValue: {
            'openai/gpt-5.4': 'OpenCode provider authentication failed',
          },
        })
      );
      await Promise.resolve();
    });

    const unavailableButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('GPT-5.4')
    );
    expect(unavailableButton).not.toBeNull();
    expect(unavailableButton?.getAttribute('aria-disabled')).toBe('true');
    expect(unavailableButton?.textContent).toContain('Unavailable');
    expect(unavailableButton?.getAttribute('title')).toContain(
      'OpenCode provider authentication failed'
    );

    await act(async () => {
      unavailableButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows short-lived OpenCode preflight notes as selectable advisory tiles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openai/gpt-5.4', 'opencode/big-pickle'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
          modelAdvisoryReasonByValue: {
            'opencode/big-pickle': 'big-pickle - ping not confirmed',
          },
        })
      );
      await Promise.resolve();
    });

    const issueButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('big-pickle')
    );
    expect(issueButton).not.toBeNull();
    expect(issueButton?.getAttribute('aria-disabled')).toBe('false');
    expect(issueButton?.textContent).toContain('Ping not confirmed');
    expect(issueButton?.className).toContain('border-amber-300/35');
    expect(issueButton?.className).not.toContain('border-red-500');
    expect(issueButton?.getAttribute('title')).toContain('ping not confirmed');

    await act(async () => {
      issueButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('opencode/big-pickle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('dynamically disables OpenCode openai routes when OpenAI auth is invalid', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      flavor: 'agent_teams_orchestrator',
      providers: [
        {
          providerId: 'opencode',
          authMethod: 'opencode_managed',
          backend: {
            kind: 'opencode-cli',
            label: 'OpenCode CLI',
            endpointLabel: 'opencode',
          },
          authenticated: true,
          supported: true,
          capabilities: {
            teamLaunch: true,
          },
          statusMessage: 'OpenAI token invalid',
          detailMessage: 'OpenAI token refresh failed: 401',
          models: ['openai/gpt-5.4', 'opencode/big-pickle'],
          availableBackends: [
            {
              id: 'openai',
              label: 'OpenAI',
              description: 'OpenAI route',
              selectable: false,
              recommended: false,
              available: false,
              state: 'authentication-required',
              statusMessage: 'Authentication required',
              detailMessage: 'Token refresh failed: 401',
            },
          ],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const openAiButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('GPT-5.4')
    );
    const bigPickleButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('big-pickle')
    );

    expect(openAiButton).not.toBeNull();
    expect(openAiButton?.getAttribute('aria-disabled')).toBe('true');
    expect(openAiButton?.textContent).toContain('Unavailable');
    expect(bigPickleButton).not.toBeNull();
    expect(bigPickleButton?.getAttribute('aria-disabled')).toBe('false');

    await act(async () => {
      openAiButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('constrains long runtime model lists so the selector scrolls', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: [
            'gpt-5.4',
            'gpt-5.4-mini',
            'gpt-5.3-codex',
            'gpt-5.3-codex-spark',
            'gpt-5.2',
            'gpt-5.1-codex',
            'gpt-5.1-codex-mini',
            'gpt-5',
            'gpt-4.1',
          ],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const modelGrid = host.querySelector<HTMLElement>(
      '[data-testid="team-model-selector-model-grid"]'
    );

    expect(modelGrid).toBeTruthy();
    expect(modelGrid?.style.maxHeight).toBe('400px');
    expect(modelGrid?.className).toContain('overflow-y-auto');
    const searchInput = host.querySelector<HTMLInputElement>(
      '[data-testid="team-model-selector-model-search"]'
    );
    expect(searchInput).toBeTruthy();

    await act(async () => {
      const setValue = Object.getOwnPropertyDescriptor(
        window.HTMLInputElement.prototype,
        'value'
      )?.set;
      setValue?.call(searchInput, '5.3');
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('5.3 Codex');
    expect(host.textContent).not.toContain('5.4 Mini');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the runtime-reported Codex model list visible during a background refresh', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.3-codex'],
        },
      ],
    };
    storeState.cliStatusLoading = true;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('5.4');
    expect(host.textContent).toContain('5.3 Codex');
    expect(host.textContent).not.toContain('Explicit models load from the current runtime');
    expect(host.querySelector('[data-testid="team-model-selector-model-search"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows 5.2 Codex as a disabled tile when the runtime still reports it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.2-codex'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const disabledButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2 Codex')
    );

    expect(disabledButton).not.toBeNull();
    expect(disabledButton?.getAttribute('aria-disabled')).toBe('true');
    expect(disabledButton?.textContent).toContain('Disabled');
    expect(disabledButton?.getAttribute('title')).toContain(
      'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.'
    );

    await act(async () => {
      disabledButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps known disabled Codex tiles visible when the runtime omits them', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.5', 'gpt-5.4', 'gpt-5.4-mini', 'gpt-5.3-codex', 'gpt-5.2'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const disabledButtons = ['5.3 Codex Spark', '5.2 Codex', '5.1 Codex Mini'].map((label) => {
      const button = Array.from(host.querySelectorAll('button')).find((candidate) =>
        candidate.textContent?.includes(label)
      );
      expect(button, `${label} should stay visible as a disabled option`).not.toBeNull();
      expect(button?.getAttribute('aria-disabled')).toBe('true');
      expect(button?.textContent).toContain('Disabled');
      expect(button?.getAttribute('title')).toContain('Temporarily disabled for team agents');
      return button;
    });

    const activeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2')
    );
    expect(activeButton?.textContent).not.toContain('Recommended');
    expect(activeButton?.getAttribute('aria-disabled')).toBe('false');

    await act(async () => {
      disabledButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps 5.1 Codex Max selectable on the native Codex path', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          authMethod: 'api_key',
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
          },
          models: ['gpt-5.4', 'gpt-5.1-codex-max'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.1 Codex Max')
    );

    expect(button).not.toBeNull();
    expect(button?.getAttribute('aria-disabled')).toBe('false');
    expect(button?.textContent).not.toContain('Disabled');

    await act(async () => {
      button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('gpt-5.1-codex-max');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('disables 5.1 Codex Max when the live Codex snapshot says ChatGPT account mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          authMethod: null,
          backend: null,
          models: ['gpt-5.4', 'gpt-5.1-codex-max'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };
    codexAccountHookState.snapshot = {
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
      localAccountArtifactsPresent: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('5.4');
    const disabledButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.1 Codex Max')
    );
    expect(disabledButton).not.toBeNull();
    expect(disabledButton?.getAttribute('aria-disabled')).toBe('true');
    expect(disabledButton?.textContent).toContain('Disabled');
    expect(disabledButton?.getAttribute('title')).toContain(
      'Temporarily disabled for team agents - this model is not currently available on the Codex native runtime.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps runtime model buttons selectable without starting automatic model probes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.4-mini'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

    const gpt54Button = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.4')
    );
    expect(gpt54Button?.getAttribute('aria-disabled')).toBe('false');

    await act(async () => {
      gpt54Button?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('gpt-5.4');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('highlights the specific model tile when preflight found a model issue', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'codex',
          models: ['gpt-5.4', 'gpt-5.2-codex'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'codex',
          onProviderChange: () => undefined,
          value: 'gpt-5.2-codex',
          onValueChange: () => undefined,
          modelIssueReasonByValue: {
            'gpt-5.2-codex': 'Not available on this Codex native runtime',
          },
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Issue');
    const issueButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('5.2 Codex')
    );
    expect(issueButton?.className).toContain('border-red-500/40');
    expect(issueButton?.getAttribute('title')).toBe('Not available on this Codex native runtime');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the curated Anthropic picker surface while showing runtime-backed labels', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'anthropic',
          models: ['opus', 'claude-opus-4-6', 'sonnet', 'haiku'],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'anthropic',
            source: 'anthropic-models-api',
            status: 'ready',
            fetchedAt: '2026-04-21T00:00:00.000Z',
            staleAt: '2026-04-21T00:10:00.000Z',
            defaultModelId: 'opus[1m]',
            defaultLaunchModel: 'opus[1m]',
            models: [
              {
                id: 'opus',
                launchModel: 'opus',
                displayName: 'Opus 4.8',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'anthropic-models-api',
                badgeLabel: 'Opus 4.8',
              },
              {
                id: 'opus[1m]',
                launchModel: 'opus[1m]',
                displayName: 'Opus 4.8 (1M)',
                hidden: true,
                supportedReasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'anthropic-models-api',
              },
              {
                id: 'claude-opus-4-6',
                launchModel: 'claude-opus-4-6',
                displayName: 'Opus 4.6',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'anthropic-models-api',
                badgeLabel: 'Opus 4.6',
              },
              {
                id: 'sonnet',
                launchModel: 'sonnet',
                displayName: 'Sonnet 4.7',
                hidden: false,
                supportedReasoningEfforts: ['low', 'medium', 'high'],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'anthropic-models-api',
                badgeLabel: 'Sonnet 4.7',
              },
              {
                id: 'haiku',
                launchModel: 'haiku',
                displayName: 'Haiku 4.6',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text', 'image'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'anthropic-models-api',
                badgeLabel: 'Haiku 4.6',
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
              message: null,
              code: null,
            },
          },
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'anthropic-models-api',
            },
            reasoningEffort: {
              supported: true,
              values: ['low', 'medium', 'high'],
              configPassthrough: false,
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const modelButtons = Array.from(host.querySelectorAll('button')).map(
      (button) => button.textContent?.trim() ?? ''
    );
    const hasModelButtonStartingWith = (label: string): boolean =>
      modelButtons.some((text) => text.startsWith(label));

    expect(hasModelButtonStartingWith('Default')).toBe(true);
    expect(hasModelButtonStartingWith('Opus 4.8')).toBe(true);
    expect(hasModelButtonStartingWith('Opus 4.6')).toBe(true);
    expect(hasModelButtonStartingWith('Sonnet 4.7')).toBe(true);
    expect(hasModelButtonStartingWith('Haiku 4.6')).toBe(true);
    expect(hasModelButtonStartingWith('Opus 4.8 (1M)')).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens readiness-gated OpenCode as diagnostics without selecting it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
          disableGeminiOption: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).not.toContain('Gemini in development');

    const buttons = Array.from(host.querySelectorAll('button'));
    const openCodeButton = buttons.find((button) => button.textContent?.includes('OpenCode'));
    expect(openCodeButton).not.toBeNull();
    expect(openCodeButton?.hasAttribute('disabled')).toBe(false);
    expect(openCodeButton?.getAttribute('aria-disabled')).toBe('true');
    expect(openCodeButton?.getAttribute('title')).toContain(
      'OpenCode runtime status is still loading.'
    );

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();
    const activeOpenCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(activeOpenCodeButton?.getAttribute('data-state')).toBe('active');
    expect(host.textContent).toContain('OpenCode is not ready for team launch');
    expect(host.textContent).toContain('OpenCode status: checking runtime');
    expect(host.textContent).toContain(
      'The app is still checking the OpenCode runtime. Wait for provider status to finish, then try again.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('points missing OpenCode runtime users to the home page install button', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: false,
          authenticated: false,
          statusMessage: 'OpenCode runtime missing',
          detailMessage: 'No JSON object found in CLI output',
          capabilities: { teamLaunch: false },
          models: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain('OpenCode is not ready for team launch');
    expect(host.textContent).toContain(
      'OpenCode is not installed, not found, or the detected runtime is not supported. Install or update OpenCode, then refresh provider status. You can also use the Install button on the home page.'
    );
    expect(host.textContent).toContain('Reason: No JSON object found in CLI output');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses backend OpenCode readiness detail as the disabled reason', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          statusMessage: 'OpenCode team launch is gated',
          detailMessage: 'OpenCode runtime store needs recovery',
          capabilities: { teamLaunch: false },
          models: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(openCodeButton?.hasAttribute('disabled')).toBe(false);
    expect(openCodeButton?.getAttribute('aria-disabled')).toBe('true');
    expect(openCodeButton?.getAttribute('title')).toContain(
      'OpenCode runtime store needs recovery'
    );
    expect(openCodeButton?.textContent).toContain('Setup');

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode is not ready for team launch');
    expect(host.textContent).toContain(
      'OpenCode status: runtime detected · provider connected · team launch blocked'
    );
    expect(host.textContent).toContain(
      'OpenCode is installed and authenticated, but Agent Teams launch readiness is blocked.'
    );
    expect(host.textContent).toContain('Reason: OpenCode runtime store needs recovery');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps inspected OpenCode explicit until the user selects it after readiness recovers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          statusMessage: 'OpenCode team launch is gated',
          detailMessage: 'OpenCode runtime store needs recovery',
          capabilities: { teamLaunch: false },
          models: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();
    const render = (): void => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
        })
      );
    };

    await act(async () => {
      render();
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain('OpenCode is not ready for team launch');

    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openrouter/minimax/minimax-m2.5-free'],
        },
      ],
    };

    await act(async () => {
      render();
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();
    expect(host.textContent).toContain('OpenCode is ready');
    expect(host.textContent).toContain('Use OpenCode');

    const useOpenCodeButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Use OpenCode'
    );
    await act(async () => {
      useOpenCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('opencode');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('allows selecting unauthenticated OpenCode when free models are available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: false,
          statusMessage: 'Provider not connected',
          detailMessage: null,
          capabilities: { teamLaunch: false },
          models: ['opencode/big-pickle'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    const ControlledSelector = (): React.JSX.Element => {
      const [provider, setProvider] = React.useState<'anthropic' | 'opencode'>('anthropic');
      return React.createElement(TeamModelSelector, {
        providerId: provider,
        onProviderChange: (nextProvider) => {
          onProviderChange(nextProvider);
          if (nextProvider === 'anthropic' || nextProvider === 'opencode') {
            setProvider(nextProvider);
          }
        },
        value: '',
        onValueChange: () => undefined,
      });
    };

    await act(async () => {
      root.render(React.createElement(ControlledSelector));
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(openCodeButton?.hasAttribute('disabled')).toBe(false);
    expect(openCodeButton?.getAttribute('aria-disabled')).toBeNull();
    expect(openCodeButton?.textContent).not.toContain('Auth');

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('opencode');
    expect(host.textContent).toContain('OpenCode free models are available');
    expect(host.textContent).toContain('provider connection optional');
    expect(host.textContent).toContain(
      'You can use free OpenCode models such as Big Pickle without connecting a provider.'
    );
    expect(host.textContent).not.toContain('OpenCode is not ready for team launch');
    expect(host.textContent).not.toContain('team launch available');
    expect(host.textContent).toContain('big-pickle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps unauthenticated OpenCode selectable but does not promise free models when none are listed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: false,
          statusMessage: 'Provider not connected',
          detailMessage: null,
          capabilities: { teamLaunch: false },
          models: ['openai/gpt-5.4-mini'],
          modelVerificationState: 'idle',
          modelAvailability: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(openCodeButton?.hasAttribute('disabled')).toBe(false);
    expect(host.textContent).toContain('OpenCode provider is not connected');
    expect(host.textContent).toContain('no free OpenCode model is listed yet');
    expect(host.textContent).toContain('provider-backed models need setup');
    expect(host.textContent).not.toContain('team launch available');
    expect(host.textContent).not.toContain('OpenCode free models are available');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not normalize the selected model while viewing OpenCode readiness diagnostics', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange: () => undefined,
          value: 'claude-opus-4-7[1m]',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('OpenCode is not ready for team launch');
    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('can leave OpenCode diagnostics for another provider tab', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          statusMessage: 'OpenCode team launch is gated',
          detailMessage: 'OpenCode runtime store needs recovery',
          capabilities: { teamLaunch: false },
          models: [],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    const ControlledSelector = (): React.JSX.Element => {
      const [provider, setProvider] = React.useState<'anthropic' | 'codex'>('anthropic');
      return React.createElement(TeamModelSelector, {
        providerId: provider,
        onProviderChange: (nextProvider) => {
          onProviderChange(nextProvider);
          if (nextProvider === 'anthropic' || nextProvider === 'codex') {
            setProvider(nextProvider);
          }
        },
        value: '',
        onValueChange: () => undefined,
      });
    };

    await act(async () => {
      root.render(React.createElement(ControlledSelector));
      await Promise.resolve();
    });

    const getTab = (label: string): HTMLButtonElement | undefined =>
      Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes(label)
      );

    await act(async () => {
      getTab('OpenCode')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getTab('OpenCode')?.getAttribute('data-state')).toBe('active');
    expect(host.textContent).toContain('OpenCode is not ready for team launch');

    await act(async () => {
      getTab('Codex')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('codex');
    expect(getTab('Codex')?.getAttribute('data-state')).toBe('active');
    expect(host.textContent).not.toContain('OpenCode is not ready for team launch');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('returns from OpenCode diagnostics to the selected provider without reselecting it', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: 'claude-opus-4-7[1m]',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    const getTab = (label: string): HTMLButtonElement | undefined =>
      Array.from(host.querySelectorAll('button')).find((button) =>
        button.textContent?.includes(label)
      );

    await act(async () => {
      getTab('OpenCode')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getTab('OpenCode')?.getAttribute('data-state')).toBe('active');

    await act(async () => {
      getTab('Anthropic')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getTab('Anthropic')?.getAttribute('data-state')).toBe('active');
    expect(onProviderChange).not.toHaveBeenCalled();
    expect(onValueChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('commits the Anthropic fallback when a frozen Gemini selection is corrected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'gemini',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
          disableGeminiOption: true,
        })
      );
      await Promise.resolve();
    });

    const anthropicTab = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Anthropic')
    );
    expect(anthropicTab?.getAttribute('data-state')).toBe('active');

    await act(async () => {
      anthropicTab?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('anthropic');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders active provider notices inside the provider tab panel', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['opencode/minimax-m2.5-free'],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
          providerNoticeById: {
            opencode: React.createElement('p', null, 'OpenCode cannot lead mixed-provider teams'),
          },
        })
      );
      await Promise.resolve();
    });

    const notice = host.querySelector('[data-testid="team-model-selector-provider-notice"]');
    const modelGrid = host.querySelector('[data-testid="team-model-selector-model-grid"]');
    expect(notice?.textContent).toContain('OpenCode cannot lead mixed-provider teams');
    expect(modelGrid).not.toBeNull();
    if (!notice || !modelGrid) {
      throw new Error('Expected provider notice and model grid to render.');
    }
    expect(
      Boolean(notice.compareDocumentPosition(modelGrid) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses role-specific provider disabled copy before OpenCode readiness gating', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openrouter/minimax/minimax-m2.5-free'],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
          providerDisabledReasonById: {
            opencode:
              'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic or Codex for one-shot schedules.',
          },
          providerDisabledBadgeLabelById: {
            opencode: 'team only',
          },
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(openCodeButton?.hasAttribute('disabled')).toBe(true);
    expect(openCodeButton?.getAttribute('title')).toBe(
      'OpenCode team launch is available for normal teams, but scheduled one-shot prompts still run through claude -p. Choose Anthropic or Codex for one-shot schedules.'
    );
    expect(openCodeButton?.textContent).toContain('team only');

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps ready OpenCode selectable when no role-specific disable is provided', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openrouter/minimax/minimax-m2.5-free'],
        },
      ],
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const openCodeButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('OpenCode')
    );
    expect(openCodeButton?.hasAttribute('disabled')).toBe(false);

    await act(async () => {
      openCodeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('opencode');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches providers through tabs instead of a dropdown', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onProviderChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'anthropic',
          onProviderChange,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const buttons = Array.from(host.querySelectorAll('button'));
    const codexTab = buttons.find((button) => button.textContent?.trim() === 'Codex');
    const providerTabIndex = (label: string): number =>
      buttons.findIndex((button) => button.textContent?.includes(label));
    expect(codexTab).not.toBeNull();
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Codex');
    expect(providerTabIndex('OpenCode')).toBeLessThan(providerTabIndex('Gemini'));

    await act(async () => {
      codexTab?.click();
      await Promise.resolve();
    });

    expect(onProviderChange).toHaveBeenCalledWith('codex');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders OpenCode source groups and keeps raw model ids on selection', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openai/gpt-5.4', 'openrouter/moonshotai/kimi-k2'],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onValueChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).toContain('OpenAI');
    expect(host.textContent).toContain('moonshotai/kimi-k2');
    expect(host.textContent).toContain('OpenRouter');

    const openRouterButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('moonshotai/kimi-k2')
    );

    expect(openRouterButton).toBeTruthy();
    expect(openRouterButton?.textContent).not.toContain('OpenRouter');

    await act(async () => {
      openRouterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onValueChange).toHaveBeenCalledWith('openrouter/moonshotai/kimi-k2');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders OpenCode free badges and tiny model pricing from runtime catalog metadata', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['opencode/big-pickle', 'opencode/minimax-m2.7'],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-13T00:00:00.000Z',
            staleAt: '2026-05-13T00:10:00.000Z',
            defaultModelId: null,
            defaultLaunchModel: null,
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  cost: { input: 0, output: 0, cache_read: 0, cache_write: 0 },
                  context: 200000,
                  limits: null,
                  free: true,
                },
              },
              {
                id: 'opencode/minimax-m2.7',
                launchModel: 'opencode/minimax-m2.7',
                displayName: 'minimax-m2.7',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  cost: { input: 0.3, output: 1.2, cache_read: 0.06, cache_write: 0.375 },
                  context: 200000,
                  limits: null,
                  free: false,
                },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
              message: null,
              code: null,
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('in Free · out Free / 1M');
    expect(host.textContent).toContain('in $0.30 · out $1.20 / 1M');
    expect(host.textContent).toContain('Free');

    const pricingRows = Array.from(
      host.querySelectorAll<HTMLElement>('[data-testid="team-model-selector-model-pricing"]')
    );
    expect(pricingRows).toHaveLength(2);
    expect(pricingRows[0]?.className).toContain('text-[9px]');
    expect(pricingRows[1]?.getAttribute('title')).toContain('Cache write: $0.375 per 1M tokens');

    const freeBadges = host.querySelectorAll(
      '[data-testid="team-model-selector-model-free-badge"]'
    );
    expect(freeBadges).toHaveLength(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders OpenCode model options from a ready catalog when runtime models are empty', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: [],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-13T00:00:00.000Z',
            staleAt: '2026-05-13T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
              },
              {
                id: 'openai/gpt-5.4',
                launchModel: 'openai/gpt-5.4',
                displayName: 'openai/gpt-5.4',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
              message: null,
              code: null,
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).not.toContain('Loading models');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps OpenCode runtime models visible when catalog metadata is partial', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openai/gpt-5.4', 'openrouter/moonshotai/kimi-k2', 'opencode/big-pickle'],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-13T00:00:00.000Z',
            staleAt: '2026-05-13T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: 'Free',
                metadata: {
                  free: true,
                  opencode: {
                    providerId: 'opencode',
                    modelId: 'big-pickle',
                    sourceLabel: 'opencode',
                    accessKind: 'builtin_free',
                    routeKind: 'builtin_free',
                    proofState: 'not_required',
                    requiresExecutionProof: false,
                    reason: null,
                  },
                },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
              message: null,
              code: null,
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).toContain('moonshotai/kimi-k2');
    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).toContain('OpenAI');
    expect(host.textContent).toContain('OpenRouter');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('groups OpenCode catalog routes by source provider and keeps route badges', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: [
            'llama.cpp/qwen-test:0.5b',
            'opencode/big-pickle',
            'openrouter/moonshotai/kimi-k2',
            'deepseek/deepseek-chat',
          ],
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-13T00:00:00.000Z',
            staleAt: '2026-05-13T00:10:00.000Z',
            defaultModelId: 'llama.cpp/qwen-test:0.5b',
            defaultLaunchModel: 'llama.cpp/qwen-test:0.5b',
            models: [
              {
                id: 'llama.cpp/qwen-test:0.5b',
                launchModel: 'llama.cpp/qwen-test:0.5b',
                displayName: 'qwen-test:0.5b',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  free: false,
                  opencode: {
                    providerId: 'llama.cpp',
                    modelId: 'qwen-test:0.5b',
                    sourceLabel: 'llama.cpp',
                    accessKind: 'configured_authless',
                    routeKind: 'configured_local',
                    proofState: 'needs_probe',
                    requiresExecutionProof: true,
                    reason: 'Execution proof required',
                  },
                },
              },
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  free: true,
                  opencode: {
                    providerId: 'opencode',
                    modelId: 'big-pickle',
                    sourceLabel: 'opencode',
                    accessKind: 'builtin_free',
                    routeKind: 'builtin_free',
                    proofState: 'not_required',
                    requiresExecutionProof: false,
                    reason: null,
                  },
                },
              },
              {
                id: 'openrouter/moonshotai/kimi-k2',
                launchModel: 'openrouter/moonshotai/kimi-k2',
                displayName: 'moonshotai/kimi-k2',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  free: false,
                  opencode: {
                    providerId: 'openrouter',
                    modelId: 'moonshotai/kimi-k2',
                    sourceLabel: 'OpenRouter',
                    accessKind: 'credentialed',
                    routeKind: 'connected_provider',
                    proofState: 'not_required',
                    requiresExecutionProof: false,
                    reason: null,
                  },
                },
              },
              {
                id: 'deepseek/deepseek-chat',
                launchModel: 'deepseek/deepseek-chat',
                displayName: 'deepseek-chat',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: false,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                metadata: {
                  free: false,
                  opencode: {
                    providerId: 'deepseek',
                    modelId: 'deepseek-chat',
                    sourceLabel: 'DeepSeek',
                    accessKind: 'not_authenticated',
                    routeKind: 'catalog_provider',
                    proofState: 'not_required',
                    requiresExecutionProof: false,
                    reason: 'Provider is not connected',
                  },
                },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
              message: null,
              code: null,
            },
          },
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const sourceGroupLabels = Array.from(
      host.querySelectorAll('[data-testid="team-model-selector-opencode-group"] h4')
    ).map((heading) => heading.textContent ?? '');
    expect(sourceGroupLabels).toEqual(
      expect.arrayContaining(['llama.cpp', 'OpenCode', 'OpenRouter', 'DeepSeek'])
    );
    expect(sourceGroupLabels).not.toContain('OpenCode config');
    expect(sourceGroupLabels).not.toContain('Connected providers');
    expect(host.textContent).toContain('Local');
    expect(host.textContent).toContain('Needs test');
    expect(host.textContent).toContain('Connected');

    const filterButton = host.querySelector<HTMLElement>(
      '[data-testid="team-model-selector-opencode-provider-filter"]'
    );
    expect(filterButton?.getAttribute('aria-label')).toBe('Filter OpenCode sources');
    expect(filterButton?.textContent).toContain('All OpenCode sources');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('filters OpenCode model groups by selected source providers', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = {
      providers: [
        {
          providerId: 'opencode',
          supported: true,
          authenticated: true,
          detailMessage: null,
          statusMessage: null,
          capabilities: {
            teamLaunch: true,
          },
          models: ['openai/gpt-5.4', 'openrouter/moonshotai/kimi-k2', 'opencode/big-pickle'],
        },
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(TeamModelSelector, {
          providerId: 'opencode',
          onProviderChange: () => undefined,
          value: '',
          onValueChange: () => undefined,
        })
      );
      await Promise.resolve();
    });

    const filterButton = host.querySelector(
      '[data-testid="team-model-selector-opencode-provider-filter"]'
    );
    expect(filterButton).toBeTruthy();

    await act(async () => {
      filterButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const openRouterCheckbox = document.body.querySelector<HTMLElement>(
      '[aria-label="Filter OpenRouter"]'
    );
    expect(openRouterCheckbox).toBeTruthy();

    await act(async () => {
      openRouterCheckbox?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('moonshotai/kimi-k2');
    expect(host.textContent).toContain('OpenRouter');
    expect(host.textContent).not.toContain('GPT-5.4');
    expect(host.textContent).not.toContain('OpenAI');
    expect(host.textContent).not.toContain('big-pickle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
