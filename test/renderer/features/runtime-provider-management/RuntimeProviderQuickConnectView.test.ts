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
        'cliStatus.quickConnect.title': 'Plans & providers',
        'cliStatus.quickConnect.description': 'Mix plans in one Agent Team.',
        'cliStatus.quickConnect.browseAll': 'Browse all providers',
        'cliStatus.quickConnect.installOpenCodeFirst': 'Install OpenCode first',
        'cliStatus.quickConnect.openCodeTitle': 'OpenCode is the provider bridge',
        'cliStatus.quickConnect.openCodeRequired': 'OpenCode is required for these plans.',
        'cliStatus.quickConnect.openCodeChecking': 'Checking OpenCode',
        'cliStatus.quickConnect.openCodeInstalling': 'Installing OpenCode',
        'cliStatus.quickConnect.openCodeInstallingPercent': `Installing OpenCode ${values?.percent ?? 0}%`,
        'cliStatus.quickConnect.openCodeError': 'OpenCode could not start',
        'cliStatus.quickConnect.retryOpenCode': 'Repair OpenCode',
        'cliStatus.quickConnect.installOpenCode': 'Install OpenCode',
        'cliStatus.quickConnect.providerStatusError': 'Could not load provider status',
        'cliStatus.quickConnect.openAiTitle': 'OpenAI Plus / Pro',
        'cliStatus.actions.retry': 'Retry',
        'cliStatus.actions.manage': 'Manage',
        'cliStatus.quickConnect.connectPlan': 'Connect plan',
        'cliStatus.quickConnect.checkAndConnect': 'Check & connect',
        'cliStatus.quickConnect.cliNotInstalled': 'CLI not installed',
        'cliStatus.quickConnect.installAndConnect': 'Install & connect',
        'cliStatus.quickConnect.signIn': 'Sign in',
        'cliStatus.quickConnect.signInRequired': 'Sign in required',
        'cliStatus.quickConnect.readyToConnect': 'Ready to connect',
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
          onRetryDirectory: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const buttons = [...host.querySelectorAll('button')];
    const installButtons = buttons.filter(
      (button) => button.textContent?.trim() === 'Install OpenCode'
    );
    expect(installButtons).toHaveLength(1);
    expect(
      buttons.find((button) => button.textContent?.includes('Browse all providers'))?.disabled
    ).toBe(false);
    expect(host.querySelectorAll('[data-testid^="provider-quick-card-"]')).toHaveLength(5);
    expect(host.querySelector('[data-testid="provider-quick-card-claude"]')).toBeNull();
    expect(host.querySelector('[data-testid="provider-quick-card-codex"]')).toBeNull();
    expect(host.textContent).not.toContain('Connect all my plans');
    expect(host.textContent).not.toContain('OpenAI Plus / Pro');

    act(() => installButtons[0]?.click());
    expect(onInstallOpenCode).toHaveBeenCalledTimes(1);
  });

  it('opens a plan-specific setup popup even when OpenCode is not installed yet', async () => {
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
          onOpenCodeProviderAction,
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const superGrok = host.querySelector('[data-testid="provider-quick-card-supergrok"]');
    const setupButton = superGrok?.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-supergrok"]'
    );
    expect(setupButton).not.toBeNull();
    act(() => setupButton?.click());
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('xai', 'connect');

    const kimi = host.querySelector('[data-testid="provider-quick-card-kimi-code-membership"]');
    const kimiSetupButton = kimi?.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-kimi-code-membership"]'
    );
    expect(kimi?.textContent).toContain('Kimi Code Membership');
    expect(kimi?.textContent).not.toContain('Use a Kimi Code membership key');
    expect(kimi?.querySelector('button[aria-label="About Kimi Code Membership"]')).not.toBeNull();
    expect(kimiSetupButton).not.toBeNull();
    act(() => kimiSetupButton?.click());
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('kimi-for-coding', 'connect');

    const kiroSetupButton = host.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-kiro"]'
    );
    const cursorSetupButton = host.querySelector<HTMLElement>(
      '[data-testid="provider-quick-action-cursor"]'
    );
    act(() => kiroSetupButton?.click());
    act(() => cursorSetupButton?.click());
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('kiro', 'connect');
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('cursor-acp', 'connect');

    expect(
      [...host.querySelectorAll<HTMLElement>('[data-testid^="provider-quick-card-"]')].map(
        (element) => element.dataset.testid?.replace('provider-quick-card-', '')
      )
    ).toEqual([
      'github-copilot',
      'cursor',
      'supergrok',
      'kiro',
      'kimi-code-membership',
      'zai-coding-plan',
      'minimax-token-plan',
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
          onRetryDirectory,
          onBrowseProviders: vi.fn(),
        })
      );
    });

    const superGrok = host.querySelector('[data-testid="provider-quick-card-supergrok"]');
    expect(superGrok?.textContent).toContain('SuperGrok OAuth connected');
    act(() =>
      superGrok?.querySelector<HTMLElement>('[data-testid="provider-quick-action-supergrok"]')?.click()
    );
    expect(onManage).toHaveBeenCalledTimes(1);

    const retry = [...host.querySelectorAll('button')].find(
      (button) => button.textContent?.trim() === 'Retry'
    );
    act(() => retry?.click());
    expect(onRetryDirectory).toHaveBeenCalledTimes(1);
  });

  it('keeps OpenCode plugin plans actionable when the native provider snapshot is empty', async () => {
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
    act(() =>
      kiro?.querySelector<HTMLElement>('[data-testid="provider-quick-action-kiro"]')?.click()
    );
    act(() =>
      cursor?.querySelector<HTMLElement>('[data-testid="provider-quick-action-cursor"]')?.click()
    );
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('kiro', 'connect');
    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('cursor-acp', 'connect');
  });
});
