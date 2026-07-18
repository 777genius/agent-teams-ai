import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { RuntimeProviderQuickConnect } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderQuickConnect';
import {
  type RuntimeProviderQuickCardViewModel,
  RuntimeProviderQuickConnectView,
} from '../../../../src/features/runtime-provider-management/renderer/ui/RuntimeProviderQuickConnectView';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, values?: { percent?: number }) => {
      const labels: Record<string, string> = {
        'cliStatus.quickConnect.title': 'Optional providers & plans',
        'cliStatus.quickConnect.description': 'Connect any plans you use.',
        'cliStatus.quickConnect.browseAll': 'Browse all providers',
        'cliStatus.quickConnect.installOpenCodeFirst': 'Install OpenCode first',
        'cliStatus.quickConnect.openCodeTitle': 'Preparing OpenCode',
        'cliStatus.quickConnect.openCodeRequired':
          'Install OpenCode to connect and use these providers with Agent Teams.',
        'cliStatus.quickConnect.openCodeChecking':
          'Checking that OpenCode is installed and ready...',
        'cliStatus.quickConnect.openCodeInstalling': 'Installing OpenCode',
        'cliStatus.quickConnect.openCodeInstallingPercent': `Installing OpenCode ${values?.percent ?? 0}%`,
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
      };
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
      button.textContent?.includes('Set up local model')
    );
    const browseButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Browse all providers')
    );
    expect(localButton).toBeDefined();
    expect(browseButton).toBeDefined();
    expect(localButton?.parentElement).toBe(browseButton?.parentElement);
    expect(localButton?.nextElementSibling).toBe(browseButton);

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
      buttons.find((button) => button.textContent?.includes('Set up local model'))?.disabled
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
      [...host.querySelectorAll<HTMLElement>('[data-testid^="provider-quick-card-"]')].map(
        (element) => element.dataset.testid?.replace('provider-quick-card-', '')
      )
    ).toEqual([
      'cursor',
      'github-copilot',
      'supergrok',
      'kiro',
      'kimi-code-membership',
      'zai-coding-plan',
      'minimax-token-plan',
      'xiaomi-mimo-token-plan',
    ]);
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

    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    act(() => retry?.click());
    expect(onRetryDirectory).toHaveBeenCalledTimes(1);
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
