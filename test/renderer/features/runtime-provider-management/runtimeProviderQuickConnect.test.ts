import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  isOpenCodeProviderOAuthBridgeOutdated,
  resolveOpenCodeQuickConnectGate,
  resolveOpenCodeQuickPlanState,
} from '../../../../src/features/runtime-provider-management/core/domain/runtimeProviderQuickConnect';
import { RuntimeProviderQuickConnect } from '../../../../src/features/runtime-provider-management/renderer/RuntimeProviderQuickConnect';

import type {
  RuntimeProviderCompanionStatusDto,
  RuntimeProviderDirectoryEntryDto,
} from '../../../../src/features/runtime-provider-management/contracts';
import type { RuntimeProviderCompanionState } from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderCompanion';
import type { RuntimeProviderQuickConnectDirectoryState } from '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect';
import type { CliProviderStatus, OpenCodeRuntimeStatus } from '../../../../src/shared/types';

const mocks = vi.hoisted(() => ({
  directory: null as RuntimeProviderQuickConnectDirectoryState | null,
  companions: new Map<string, RuntimeProviderCompanionState>(),
  quickConnectOptions: null as { enabled: boolean } | null,
  companionOptions: new Map<string, boolean>(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderQuickConnect',
  () => ({
    useRuntimeProviderQuickConnect: (options: { enabled: boolean }) => {
      mocks.quickConnectOptions = options;
      return mocks.directory;
    },
  })
);

vi.mock(
  '../../../../src/features/runtime-provider-management/renderer/hooks/useRuntimeProviderCompanion',
  () => ({
    useRuntimeProviderCompanion: (companionId: string, enabled: boolean) => {
      mocks.companionOptions.set(companionId, enabled);
      return mocks.companions.get(companionId);
    },
  })
);

function entry(
  providerId: string,
  overrides: Partial<RuntimeProviderDirectoryEntryDto> = {}
): RuntimeProviderDirectoryEntryDto {
  return {
    providerId,
    displayName: providerId,
    state: 'connected',
    connectedAuthHint: 'oauth',
    setupKind: 'connected',
    ownership: ['managed'],
    recommended: true,
    modelCount: 1,
    authMethods: ['oauth'],
    defaultModelId: `${providerId}/auto`,
    sources: ['inventory'],
    sourceLabel: 'OpenCode',
    providerSource: 'custom',
    detail: null,
    actions: [],
    metadata: {
      hasKnownModels: true,
      requiresManualConfig: false,
      supportedInlineAuth: true,
      configuredAuthless: false,
    },
    ...overrides,
  };
}

function companion(
  companionId: 'kiro-cli' | 'cursor-agent',
  runConnect = vi.fn(async () => undefined)
): RuntimeProviderCompanionState {
  const status: RuntimeProviderCompanionStatusDto = {
    companionId,
    displayName: companionId === 'kiro-cli' ? 'Kiro CLI' : 'Cursor Agent CLI',
    phase: 'connected',
    installed: true,
    authenticated: true,
    binaryPath: '/tmp/companion',
    version: '1.0.0',
    percent: 100,
    message: 'Connected',
    detail: null,
    error: null,
    manualCommand: '',
    manualUrl: '',
    updatedAt: new Date(0).toISOString(),
  };
  return {
    status,
    loading: false,
    runInstallAndConnect: vi.fn(async () => undefined),
    runConnect,
    refresh: vi.fn(async () => undefined),
  };
}

const openCodeProvider = {
  providerId: 'opencode',
  displayName: 'OpenCode',
  supported: true,
  authenticated: true,
  authMethod: 'managed',
  verificationState: 'verified',
  models: [],
  canLoginFromUi: false,
  capabilities: { teamLaunch: true, oneShot: true, extensions: {} },
} as unknown as CliProviderStatus;

describe('RuntimeProviderQuickConnect', () => {
  let host: HTMLDivElement;
  let root: ReturnType<typeof createRoot>;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
    mocks.quickConnectOptions = null;
    mocks.companionOptions.clear();
    mocks.companions = new Map([
      ['kiro-cli', companion('kiro-cli')],
      ['cursor-agent', companion('cursor-agent')],
    ]);
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    host.remove();
    vi.unstubAllGlobals();
  });

  const renderQuickConnect = async (): Promise<void> => {
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: false,
          providers: [openCodeProvider],
          openCodeRuntimeStatus: {
            installed: true,
            source: 'app-managed',
            state: 'ready',
            version: '1.17.18',
          },
          openCodeRuntimeStatusLoading: false,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });
  };

  it('keeps last-known connected cards actionable during a refresh error', async () => {
    mocks.directory = {
      entries: [
        entry('xai'),
        entry('kiro', { metadata: { ...entry('kiro').metadata, configuredAuthless: true } }),
        entry('cursor-acp', {
          metadata: { ...entry('cursor-acp').metadata, configuredAuthless: true },
        }),
        entry('xiaomi-token-plan-sgp'),
      ],
      loaded: true,
      loading: false,
      error: 'Refresh failed',
      refresh: vi.fn(),
    };

    await renderQuickConnect();

    expect(host.querySelector('[data-testid="provider-quick-action-supergrok"]')).not.toBeNull();
    expect(
      host.querySelector('[data-testid="provider-quick-action-xiaomi-mimo-token-plan"]')
    ).not.toBeNull();
    expect(
      host.querySelector('[data-testid="provider-quick-card-supergrok"]')?.textContent
    ).toContain('cliStatus.quickConnect.superGrokConnected');
  });

  it('preserves the last confirmed connected count while OpenCode updates', async () => {
    const onConnectedCountChange = vi.fn();
    mocks.directory = {
      entries: [
        entry('xai'),
        entry('github-copilot'),
        entry('kiro', { metadata: { ...entry('kiro').metadata, configuredAuthless: true } }),
        entry('cursor-acp', {
          metadata: { ...entry('cursor-acp').metadata, configuredAuthless: true },
        }),
        entry('kimi-for-coding'),
        entry('zai-coding-plan'),
        entry('minimax-coding-plan'),
        entry('xiaomi-token-plan-sgp'),
      ],
      loaded: true,
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    const renderWithStatus = async (state: OpenCodeRuntimeStatus['state']): Promise<void> => {
      await act(async () => {
        root.render(
          React.createElement(RuntimeProviderQuickConnect, {
            enabled: true,
            cliStatusLoading: false,
            providers: [openCodeProvider],
            openCodeRuntimeStatus: {
              installed: true,
              source: 'app-managed',
              state,
              version: '1.17.18',
            },
            openCodeRuntimeStatusLoading: state !== 'ready',
            onInstallOpenCode: vi.fn(),
            onRefreshOpenCode: vi.fn(),
            onOpenCodeProviderAction: vi.fn(),
            onBrowseProviders: vi.fn(),
            onConnectedCountChange,
          })
        );
        await Promise.resolve();
      });
    };

    await renderWithStatus('ready');
    expect(onConnectedCountChange).toHaveBeenLastCalledWith(8);
    await renderWithStatus('installing');
    expect(onConnectedCountChange).toHaveBeenLastCalledWith(8);
  });

  it('re-verifies a signed-in companion when its OpenCode bridge is not ready', async () => {
    const runConnect = vi.fn(async () => undefined);
    mocks.companions.set('cursor-agent', companion('cursor-agent', runConnect));
    mocks.directory = {
      entries: [
        entry('kiro', { metadata: { ...entry('kiro').metadata, configuredAuthless: true } }),
      ],
      loaded: true,
      loading: false,
      error: null,
      refresh: vi.fn(),
    };

    await renderQuickConnect();
    const card = host.querySelector('[data-testid="provider-quick-card-cursor"]');
    expect(card?.textContent).toContain('cliStatus.quickConnect.statusUnavailable');
    const action = host.querySelector<HTMLButtonElement>(
      '[data-testid="provider-quick-action-cursor"]'
    );
    await act(async () => action?.click());
    expect(runConnect).toHaveBeenCalledTimes(1);
  });

  it('reuses the companion dialog to sign in again after Cursor is connected', async () => {
    const runConnect = vi.fn(async () => undefined);
    mocks.companions.set('cursor-agent', companion('cursor-agent', runConnect));
    mocks.directory = {
      entries: [
        entry('kiro', { metadata: { ...entry('kiro').metadata, configuredAuthless: true } }),
        entry('cursor-acp', {
          metadata: { ...entry('cursor-acp').metadata, configuredAuthless: true },
        }),
      ],
      loaded: true,
      loading: false,
      error: null,
      refresh: vi.fn(),
    };

    await renderQuickConnect();
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>('[data-testid="provider-quick-action-cursor"]')
        ?.click();
    });
    const signIn = [...document.body.querySelectorAll('button')].find((button) =>
      button.textContent?.includes('cliStatus.quickConnect.signIn')
    );
    await act(async () => signIn?.click());

    expect(runConnect).toHaveBeenCalledTimes(1);
  });

  it('routes the current MiMo endpoint through the reusable reconnect flow', async () => {
    const onOpenCodeProviderAction = vi.fn();
    mocks.directory = {
      entries: [entry('xiaomi-token-plan-sgp')],
      loaded: true,
      loading: false,
      error: null,
      refresh: vi.fn(),
    };
    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: false,
          providers: [openCodeProvider],
          openCodeRuntimeStatus: {
            installed: true,
            source: 'app-managed',
            state: 'ready',
            version: '1.17.18',
          },
          openCodeRuntimeStatusLoading: false,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction,
          onBrowseProviders: vi.fn(),
        })
      );
    });
    await act(async () => {
      host
        .querySelector<HTMLButtonElement>(
          '[data-testid="provider-quick-action-xiaomi-mimo-token-plan"]'
        )
        ?.click();
    });
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="xiaomi-mimo-base-url"]'
    );
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'https://token-plan-sgp.xiaomimimo.com/v1');
      input?.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () => {
      document.body
        .querySelector<HTMLButtonElement>('[data-testid="xiaomi-mimo-continue"]')
        ?.click();
    });

    expect(onOpenCodeProviderAction).toHaveBeenCalledWith('xiaomi-token-plan-sgp', 'reconnect');
  });

  it('warms the provider directory while OpenCode readiness is still checking', async () => {
    mocks.directory = {
      entries: [],
      loaded: false,
      loading: true,
      error: null,
      refresh: vi.fn(),
    };

    await act(async () => {
      root.render(
        React.createElement(RuntimeProviderQuickConnect, {
          enabled: true,
          cliStatusLoading: true,
          providers: [],
          openCodeRuntimeStatus: null,
          openCodeRuntimeStatusLoading: true,
          onInstallOpenCode: vi.fn(),
          onRefreshOpenCode: vi.fn(),
          onOpenCodeProviderAction: vi.fn(),
          onBrowseProviders: vi.fn(),
        })
      );
    });

    expect(mocks.quickConnectOptions).toMatchObject({ enabled: true });
    expect(mocks.companionOptions).toEqual(
      new Map([
        ['kiro-cli', true],
        ['cursor-agent', true],
      ])
    );
  });
});

function runtimeStatus(overrides: Partial<OpenCodeRuntimeStatus> = {}): OpenCodeRuntimeStatus {
  return {
    installed: true,
    version: '1.15.7',
    source: 'app-managed',
    state: 'ready',
    ...overrides,
  };
}

describe('runtimeProviderQuickConnect domain policy', () => {
  it('compares OpenCode versions without treating newer minor versions as outdated', () => {
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.15.6' }))).toBe(true);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.15.7' }))).toBe(false);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '1.16.0' }))).toBe(false);
    expect(isOpenCodeProviderOAuthBridgeOutdated(runtimeStatus({ version: '2.0.0' }))).toBe(false);
  });

  it('keeps runtime checking, installing, failed, missing, and ready states distinct', () => {
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: null,
        runtimeStatusLoading: true,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('checking');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ state: 'installing' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('installing');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ state: 'failed', error: 'broken' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('error');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: runtimeStatus({ installed: false, state: 'idle' }),
        runtimeStatusLoading: false,
        provider: null,
        cliStatusLoading: false,
      })
    ).toBe('missing');
    expect(
      resolveOpenCodeQuickConnectGate({
        runtimeStatus: null,
        runtimeStatusLoading: false,
        provider: openCodeProvider,
        cliStatusLoading: false,
      })
    ).toBe('ready');
  });

  it('only reports SuperGrok connected when the saved credential is OAuth', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { connectedAuthHint: 'oauth' }),
        requiresOAuthCredential: true,
      })
    ).toBe('connected');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { connectedAuthHint: 'api' }),
        requiresOAuthCredential: true,
      })
    ).toBe('different-credential');
  });

  it('accepts explicit plugin credential evidence for a configured Cursor route', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('cursor-acp', {
          connectedAuthHint: 'api',
          metadata: {
            hasKnownModels: true,
            requiresManualConfig: false,
            supportedInlineAuth: false,
            configuredAuthless: true,
          },
        }),
      })
    ).toBe('connected');
  });

  it('requires an OpenCode update for SuperGrok unless OAuth is already connected', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { connectedAuthHint: 'api' }),
        requiresOAuthCredential: true,
        oauthBridgeOutdated: true,
      })
    ).toBe('update-required');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { connectedAuthHint: 'oauth' }),
        requiresOAuthCredential: true,
        oauthBridgeOutdated: true,
      })
    ).toBe('connected');
  });

  it('maps connectable, manual, and absent providers without inventing connectivity', () => {
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { state: 'available', setupKind: 'connect-api-key' }),
      })
    ).toBe('connectable');
    expect(
      resolveOpenCodeQuickPlanState({
        entry: entry('xai', { state: 'available', setupKind: 'configure-manually' }),
      })
    ).toBe('manual');
    expect(resolveOpenCodeQuickPlanState({ entry: null })).toBe('unavailable');
  });
});
