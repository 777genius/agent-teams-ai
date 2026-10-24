import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as companion from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderCompanion';
import * as quickConnectDirectory from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect';
import { RuntimeProviderQuickConnect } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderQuickConnect';
import {
  type RuntimeProviderQuickCardViewModel,
  RuntimeProviderQuickConnectView,
} from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderQuickConnectView';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => {
      const labels: Record<string, string> = {
        'cliStatus.quickConnect.title': 'Optional providers & plans',
        'cliStatus.quickConnect.description': 'Connect any plans you use.',
        'cliStatus.quickConnect.browseAll': 'Browse all providers',
        'cliStatus.quickConnect.setupModelEndpoint': 'Local model or endpoint',
        'cliStatus.quickConnect.installOpenCodeFirst': 'Install OpenCode first',
        'cliStatus.quickConnect.openCodeTitle': 'Preparing OpenCode',
        'cliStatus.quickConnect.openCodeRequired':
          'Install OpenCode to connect and use these providers with Agent Teams.',
        'cliStatus.quickConnect.openCodeChecking':
          'Checking that OpenCode is installed and ready...',
        'cliStatus.quickConnect.openCodeInstalling': 'Installing OpenCode',
        'cliStatus.quickConnect.openCodeInstallingPercent': `Installing OpenCode ${String(values?.percent ?? 0)}%`,
        'cliStatus.quickConnect.openCodeError': 'OpenCode could not start',
        'cliStatus.quickConnect.openCodeErrorTitle': 'OpenCode needs attention',
        'cliStatus.quickConnect.connected': 'Connected',
        'cliStatus.quickConnect.retryOpenCode': 'Repair OpenCode',
        'cliStatus.quickConnect.refreshOpenCode': 'Refresh status',
        'cliStatus.quickConnect.installOpenCode': 'Install OpenCode',
        'cliStatus.quickConnect.providerStatusError': 'Could not load provider status',
        'cliStatus.quickConnect.openAiTitle': 'OpenAI Plus / Pro',
        'cliStatus.actions.connect': 'Connect',
        'cliStatus.actions.retry': 'Retry',
        'cliStatus.actions.manage': 'Manage',
        'cliStatus.quickConnect.checkAndConnect': 'Check & connect',
        'cliStatus.quickConnect.cliNotInstalled': 'CLI not installed',
        'cliStatus.quickConnect.installAndConnect': 'Install & connect',
        'cliStatus.quickConnect.signIn': 'Sign in',
        'cliStatus.quickConnect.signInRequired': 'Sign in required',
        'cliStatus.quickConnect.readyToConnect': 'Available to connect',
        'cliStatus.quickConnect.regionNotSelected': 'Region not selected',
        'cliStatus.quickConnect.kiroConnected': 'Kiro account connected',
        'cliStatus.quickConnect.kiroDescription': 'Use Kiro.',
        'cliStatus.quickConnect.cursorConnected': 'Cursor account connected',
        'cliStatus.quickConnect.cursorDescription': 'Use Cursor.',
        'cliStatus.quickConnect.kimiDescription':
          'Use a Kimi Code membership key through OpenCode.',
        'cliStatus.quickConnect.openCodeOverrideIgnoredTitle':
          'OpenCode binary override is not used',
      };
      if (key === 'cliStatus.quickConnect.openCodeOverrideIgnoredPath') {
        const override = values as { envName?: string; binaryPath?: string; version?: string };
        return `${override.envName} = ${override.binaryPath} (version ${override.version})`;
      }
      return labels[key] ?? key;
    },
  }),
}));

function card(
  id: string,
  overrides: Partial<RuntimeProviderQuickCardViewModel> = {}
): RuntimeProviderQuickCardViewModel {
  return {
    id,
    providerId: id,
    displayName: id,
    description: `${id} description`,
    state: 'unavailable',
    stateLabel: 'Requires OpenCode',
    actionLabel: null,
    onAction: null,
    ...overrides,
  };
}

describe('RuntimeProviderQuickConnectView', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it('keeps every provider action available when the directory fails to load', async () => {
    vi.spyOn(companion, 'useRuntimeProviderCompanion').mockReturnValue({
      status: null,
      loading: false,
      runInstallAndConnect: vi.fn(),
      runConnect: vi.fn(),
      runAction: vi.fn(),
      refresh: vi.fn(),
    });
    vi.spyOn(quickConnectDirectory, 'useRuntimeProviderQuickConnect').mockReturnValue({
      entries: [],
      loading: false,
      loaded: false,
      authoritativeLoaded: false,
      authoritativePending: false,
      error: 'Could not load OpenCode provider status',
      refresh: vi.fn(),
    });
    const onOpenCodeProviderAction = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: false,
          providers: [],
          openCodeRuntimeStatus: {
            installed: true,
            source: 'app-managed',
            state: 'ready',
            version: '1.18.32',
          },
          openCodeRuntimeStatusLoading: false,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction,
          onBrowseProviders: vi.fn(),
        })
      );
    });
    const cards = host.querySelectorAll('[data-testid^="provider-quick-card-"]');
    expect(cards).toHaveLength(10);
    for (const providerCard of cards) {
      const action = providerCard.querySelector<HTMLButtonElement>(
        '[data-testid^="provider-quick-action-"]'
      );
      const open = providerCard.querySelector<HTMLButtonElement>(
        '[data-testid^="provider-quick-open-"]'
      );
      expect(action).not.toBeNull();
      expect(open).not.toBeNull();
      expect(action?.disabled).toBe(false);
    }
    const superGrok = host.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-open-supergrok"]'
    );
    act(() => superGrok?.click());
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('xai', 'settings-connect');
    onOpenCodeProviderAction.mockClear();
    const xiaomi = host.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-open-xiaomi-mimo-token-plan"]'
    );
    await act(async () => xiaomi?.click());
    expect(onOpenCodeProviderAction).not.toHaveBeenCalled();
    expect(document.querySelector('[data-testid="xiaomi-mimo-base-url"]')).not.toBeNull();
  });

  it('places local model setup beside the provider catalog action', async () => {
    const onSetupLocalModel = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [],
          gate: 'ready',
          runtimeStatus: null,
          directoryError: null,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel,
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const localButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Local model or endpoint')
    );
    const browseButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Browse all providers')
    );
    expect(localButton).toBeDefined();
    expect(browseButton).toBeDefined();
    expect(localButton?.parentElement).toBe(browseButton?.parentElement);
    expect(localButton?.nextElementSibling).toBe(browseButton);
    expect(localButton?.classList.contains('gap-1.5')).toBe(true);
    expect(localButton?.querySelector('svg')?.classList.contains('mr-1.5')).toBe(false);

    await act(async () => localButton?.click());
    expect(onSetupLocalModel).toHaveBeenCalledTimes(1);
  });

  it('shows one clear OpenCode prerequisite action instead of repeating install per plan', async () => {
    const onInstallOpenCode = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [
            card('supergrok'),
            card('zai-coding-plan'),
            card('minimax-token-plan'),
            card('github-copilot'),
            card('kimi-code-membership'),
          ],
          gate: 'missing',
          runtimeStatus: null,
          directoryError: null,
          onInstallOpenCode,
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const buttons = [...host.querySelectorAll('button')];
    const installButtons = buttons.filter(
      (button) => button.textContent?.trim() === 'Install OpenCode'
    );
    expect(installButtons).toHaveLength(1);
    expect(host.textContent).toContain('Preparing OpenCode');
    expect(host.textContent).toContain(
      'Install OpenCode to connect and use these providers with Agent Teams.'
    );
    expect(
      buttons.find((button) => button.textContent?.includes('Browse all providers'))?.disabled
    ).toBe(true);
    expect(
      buttons.find((button) => button.textContent?.includes('Local model or endpoint'))?.disabled
    ).toBe(true);
    expect(host.querySelectorAll('[data-testid^="provider-quick-card-"]')).toHaveLength(5);
    expect(host.querySelector('[data-testid="provider-quick-card-claude"]')).toBeNull();
    expect(host.querySelector('[data-testid="provider-quick-card-codex"]')).toBeNull();
    expect(host.textContent).not.toContain('Connect all my plans');
    expect(host.textContent).not.toContain('OpenAI Plus / Pro');

    const firstProviderRow = host.querySelector<HTMLElement>(
      '[data-testid="provider-quick-card-supergrok"]'
    );
    expect(firstProviderRow?.classList.contains('border-b')).toBe(true);
    expect(firstProviderRow?.classList.contains('rounded-lg')).toBe(false);
    expect(firstProviderRow?.dataset.disabled).toBe('true');
    expect(firstProviderRow?.classList.contains('opacity-50')).toBe(false);
    expect(firstProviderRow?.firstElementChild?.classList.contains('opacity-50')).toBe(true);
    expect(
      firstProviderRow
        ?.querySelector('[data-testid="runtime-provider-logo-supergrok"]')
        ?.classList.contains('size-7')
    ).toBe(true);
    expect(firstProviderRow?.parentElement?.classList.contains('gap-x-6')).toBe(false);

    act(() => installButtons[0]?.click());
    expect(onInstallOpenCode).toHaveBeenCalledTimes(1);
  });

  it('keeps the prerequisite notice hidden while OpenCode availability is checked', async () => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [card('supergrok', { state: 'checking', stateLabel: 'Checking OpenCode' })],
          gate: 'checking',
          runtimeStatus: null,
          directoryError: null,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    expect(host.querySelector('[data-testid="provider-quick-opencode-prerequisite"]')).toBeNull();
    expect(host.textContent).not.toContain('Preparing OpenCode');
    expect(host.textContent).not.toContain('Checking that OpenCode is installed and ready...');
    expect(
      [...host.querySelectorAll('button')].some(
        (button) => button.textContent?.trim() === 'Install OpenCode'
      )
    ).toBe(false);
  });

  it('keeps the prerequisite notice hidden while OpenCode is installed', async () => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [card('supergrok', { state: 'checking', stateLabel: 'Installing OpenCode' })],
          gate: 'installing',
          runtimeStatus: {
            installed: false,
            source: 'missing',
            state: 'downloading',
            progress: {
              phase: 'downloading',
              percent: 42,
              detail: 'Downloading OpenCode 42%',
            },
          },
          directoryError: null,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    expect(host.querySelector('[data-testid="provider-quick-opencode-prerequisite"]')).toBeNull();
    expect(host.textContent).not.toContain('Installing OpenCode 42%');
  });

  it('announces runtime failure and exposes separate repair and refresh actions', async () => {
    const onInstallOpenCode = vi.fn();
    const onRefreshOpenCode = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [card('supergrok')],
          gate: 'error',
          runtimeStatus: {
            installed: false,
            source: 'missing',
            state: 'failed',
            error: 'Network unavailable',
          },
          directoryError: null,
          onInstallOpenCode,
          onRefreshOpenCode,
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    expect(host.querySelector('[role="alert"]')?.textContent).toContain('Network unavailable');
    expect(host.querySelector('[role="alert"]')?.textContent).toContain('OpenCode needs attention');
    const repair = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Repair OpenCode'
    );
    expect(repair).not.toBeUndefined();
    act(() => repair?.click());
    expect(onInstallOpenCode).toHaveBeenCalledTimes(1);

    const refresh = host.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-opencode-refresh"]'
    );
    expect(refresh?.textContent?.trim()).toBe('Refresh status');
    act(() => refresh?.click());
    expect(onRefreshOpenCode).toHaveBeenCalledTimes(1);
  });

  it('offers no managed install when a failing binary override decides what launches', async () => {
    const onInstallOpenCode = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [card('supergrok')],
          gate: 'error',
          runtimeStatus: {
            installed: false,
            binaryPath: '/TEST/override/opencode',
            source: 'override',
            state: 'failed',
            error: 'Could not verify the explicitly selected OpenCode binary',
          },
          directoryError: null,
          onInstallOpenCode,
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    expect(host.textContent).toContain('Could not verify the explicitly selected OpenCode binary');
    expect(
      [...host.querySelectorAll('button')].some((button) =>
        ['Repair OpenCode', 'Install OpenCode'].includes(button.textContent?.trim() ?? '')
      )
    ).toBe(false);
    expect(host.querySelector('[data-testid="provider-quick-opencode-refresh"]')).not.toBeNull();
  });

  it('names an ignored binary override next to the fallback runtime', async () => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [card('supergrok')],
          gate: 'ready',
          runtimeStatus: {
            installed: true,
            binaryPath: '/TEST/managed/opencode',
            version: '1.19.4',
            source: 'app-managed',
            state: 'ready',
            ignoredOverride: {
              binaryPath: '/TEST/override/opencode',
              envName: 'CLAUDE_MULTIMODEL_OPENCODE_BIN_PATH',
              version: '2.1.4',
              reason: 'OpenCode 2.1.4 has an unsupported native generation.',
            },
          },
          directoryError: null,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const notice = host.querySelector('[data-testid="provider-quick-opencode-ignored-override"]');
    expect(notice?.getAttribute('role')).toBe('alert');
    expect(notice?.textContent).toContain('/TEST/override/opencode');
    expect(notice?.textContent).toContain('2.1.4');
    expect(notice?.textContent).toContain('unsupported native generation');
  });

  it('keeps provider setup disabled until OpenCode is installed', async () => {
    const onOpenCodeProviderAction = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: false,
          providers: [],
          openCodeRuntimeStatus: null,
          openCodeRuntimeStatusLoading: false,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction,
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const superGrok = host.querySelector('[data-testid="provider-quick-card-supergrok"]');
    const setupButton = superGrok?.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-supergrok"]'
    );
    expect(setupButton).toBeNull();

    const kimi = host.querySelector('[data-testid="provider-quick-card-kimi-code-membership"]');
    const kimiSetupButton = kimi?.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-kimi-code-membership"]'
    );
    expect(kimi?.textContent).toContain('Kimi Code Membership');
    expect(kimi?.textContent).not.toContain('Use a Kimi Code membership key');
    expect(
      kimi?.querySelector(
        'button[aria-label="Kimi Code Membership: Use a Kimi Code membership key through OpenCode."]'
      )
    ).not.toBeNull();
    expect(kimiSetupButton).toBeNull();

    const kiroSetupButton = host.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-kiro"]'
    );
    const cursorSetupButton = host.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-cursor"]'
    );
    expect(kiroSetupButton).toBeNull();
    expect(cursorSetupButton).toBeNull();
    expect(onOpenCodeProviderAction).not.toHaveBeenCalled();

    expect(
      [...host.querySelectorAll<HTMLElement>('[data-testid^="provider-quick-card-"]')]
        .map((element) => element.dataset.testid?.replace('provider-quick-card-', ''))
        .sort()
    ).toEqual(
      [
        'cursor',
        'github-copilot',
        'supergrok',
        'kiro',
        'kimi-code-membership',
        'zai-coding-plan',
        'minimax-token-plan',
        'xiaomi-mimo-token-plan',
        'openrouter',
        'vercel',
      ].sort()
    );
  });

  it('keeps connected plan management and catalog retry as separate controls', async () => {
    const onManage = vi.fn();
    const onRetryDirectory = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [
            card('supergrok', {
              displayName: 'SuperGrok',
              state: 'connected',
              stateLabel: 'SuperGrok OAuth connected',
              actionLabel: 'Manage',
              onAction: onManage,
              progress: { percent: 100, detail: 'Setup complete' },
            }),
          ],
          gate: 'ready',
          runtimeStatus: {
            installed: true,
            source: 'app-managed',
            state: 'ready',
            version: '1.17.18',
          },
          directoryError: 'catalog timeout',
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory,
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const superGrok = host.querySelector('[data-testid="provider-quick-card-supergrok"]');
    expect(superGrok?.textContent).toContain('SuperGrok OAuth connected');
    expect(host.querySelector('.sr-only[role="status"]')?.textContent).toBe('OpenCode: Connected');
    const manageButton = superGrok?.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-supergrok"]'
    );
    expect(manageButton?.classList.contains('row-span-2')).toBe(true);
    expect(manageButton?.classList.contains('self-center')).toBe(true);
    expect(superGrok?.querySelector('[role="progressbar"]')).toBeNull();
    act(() => manageButton?.click());
    expect(onManage).toHaveBeenCalledTimes(1);

    const cardButton = superGrok?.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-open-supergrok"]'
    );
    expect(cardButton?.getAttribute('aria-label')).toBe('SuperGrok: Manage');
    expect(cardButton?.tabIndex).toBe(-1);
    act(() => cardButton?.click());
    expect(onManage).toHaveBeenCalledTimes(2);

    const infoButton = superGrok?.querySelector<HTMLButtonElement>(
      'button[aria-label="SuperGrok: supergrok description"]'
    );
    act(() => infoButton?.click());
    expect(onManage).toHaveBeenCalledTimes(2);

    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    act(() => retry?.click());
    expect(onRetryDirectory).toHaveBeenCalledTimes(1);
  });

  it('shows an available-to-connect label when a gateway catalog entry is unavailable', async () => {
    const onConnect = vi.fn();
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnectView, {
          cards: [
            card('openrouter', {
              displayName: 'OpenRouter',
              state: 'connectable',
              stateLabel: 'Available to connect',
              actionLabel: 'Check & connect',
              onAction: onConnect,
            }),
          ],
          gate: 'ready',
          runtimeStatus: null,
          directoryError: null,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onRetryDirectory: vi.fn(),
          onSetupLocalModel: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const connect = host.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-action-openrouter"]'
    );
    expect(
      connect?.closest('[data-testid="provider-quick-card-openrouter"]')?.textContent
    ).toContain('Available to connect');
    expect(
      connect
        ?.closest('[data-testid="provider-quick-card-openrouter"]')
        ?.querySelector('[title="Available to connect"]')?.className
    ).toContain('text-sky-300');
    expect(connect?.textContent).toContain('Check & connect');
    expect(connect?.disabled).toBe(false);
    act(() => connect?.click());
    expect(onConnect).toHaveBeenCalledTimes(1);
  });

  it('keeps OpenCode plugin plans visible but disabled when the runtime is missing', async () => {
    const onOpenCodeProviderAction = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: false,
          providers: [],
          openCodeRuntimeStatus: null,
          openCodeRuntimeStatusLoading: false,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction,
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const kiro = host.querySelector('[data-testid="provider-quick-card-kiro"]');
    const cursor = host.querySelector('[data-testid="provider-quick-card-cursor"]');
    expect(kiro?.textContent).toContain('OpenCode');
    expect(cursor?.textContent).toContain('OpenCode');
    expect(host.textContent).not.toContain('Status unavailable');
    expect((kiro as HTMLElement | null)?.dataset.disabled).toBe('true');
    expect((cursor as HTMLElement | null)?.dataset.disabled).toBe('true');
    expect(kiro?.querySelector('[data-testid="provider-quick-action-kiro"]')).toBeNull();
    expect(cursor?.querySelector('[data-testid="provider-quick-action-cursor"]')).toBeNull();
    expect(onOpenCodeProviderAction).not.toHaveBeenCalled();
  });
});
