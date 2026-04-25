import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';
import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

interface StoreState {
  appConfig: {
    providerConnections: {
      anthropic: {
        authMode: 'auto' | 'oauth' | 'api_key';
      };
      codex: {
        preferredAuthMode: 'auto' | 'chatgpt' | 'api_key';
      };
    };
  };
  apiKeys: {
    id: string;
    envVarName: string;
    scope: 'user' | 'project';
    name: string;
    maskedValue?: string;
    createdAt?: number;
  }[];
  apiKeysLoading: boolean;
  apiKeysError: string | null;
  apiKeySaving: boolean;
  apiKeyStorageStatus: { available: boolean; backend: string; detail?: string | null } | null;
  fetchApiKeys: ReturnType<typeof vi.fn>;
  fetchApiKeyStorageStatus: ReturnType<typeof vi.fn>;
  saveApiKey: ReturnType<typeof vi.fn>;
  deleteApiKey: ReturnType<typeof vi.fn>;
  updateConfig: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(undefined)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: StoreState) => unknown) => selector(storeState);
  Object.assign(useStore, {
    setState: vi.fn(),
  });
  return { useStore };
});

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

vi.mock('@features/runtime-provider-management/renderer', () => ({
  RuntimeProviderManagementPanel: ({
    runtimeId,
    open,
    disabled,
    projectPath,
  }: {
    runtimeId: string;
    open: boolean;
    disabled?: boolean;
    projectPath?: string | null;
  }) =>
    React.createElement(
      'section',
      {
        'data-testid': 'runtime-provider-management-panel',
        'data-runtime-id': runtimeId,
        'data-open': String(open),
        'data-disabled': String(Boolean(disabled)),
        'data-project-path': projectPath ?? '',
      },
      `Runtime provider management: ${runtimeId}`
    ),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
    type = 'button',
  }: React.PropsWithChildren<{
    onClick?: () => void;
    disabled?: boolean;
    type?: 'button' | 'submit' | 'reset';
  }>) =>
    React.createElement(
      'button',
      {
        type,
        disabled,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/dialog', () => ({
  Dialog: ({ open, children }: React.PropsWithChildren<{ open: boolean }>) =>
    open ? React.createElement('div', { 'data-testid': 'dialog' }, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', { 'data-testid': 'dialog-content' }, children),
  DialogHeader: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('p', null, children),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: React.forwardRef<HTMLInputElement, React.InputHTMLAttributes<HTMLInputElement>>(
    (props, ref) => React.createElement('input', { ...props, ref })
  ),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: React.PropsWithChildren) => React.createElement('label', null, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement('button', { type: 'button' }, children),
  SelectValue: () => React.createElement('span', null, 'select-value'),
  SelectContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren<{ value: string }>) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@renderer/components/ui/tabs', () => ({
  Tabs: ({
    children,
    value,
    onValueChange,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) =>
    React.createElement(
      'div',
      { 'data-value': value, 'data-on-change': Boolean(onValueChange) },
      children
    ),
  TabsList: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  TabsTrigger: ({
    children,
    value,
    onClick,
  }: React.PropsWithChildren<{ value: string; onClick?: () => void }>) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-value': value,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/runtime/ProviderRuntimeBackendSelector', () => ({
  ProviderRuntimeBackendSelector: ({
    provider,
    onSelect,
  }: {
    provider: { providerId: string };
    onSelect: (providerId: string, backendId: string) => void;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick: () => onSelect(provider.providerId, 'api'),
      },
      'Select runtime backend'
    ),
  getProviderRuntimeBackendSummary: () => null,
  getVisibleProviderRuntimeBackendOptions: (provider: CliProviderStatus) =>
    provider.availableBackends ?? [],
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: ({ providerId }: { providerId: string }) =>
    React.createElement('span', {
      'data-testid': `provider-logo-${providerId}`,
      'data-provider-id': providerId,
    }),
}));

import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

function createCodexProvider(
  overrides?: Omit<Partial<NonNullable<CliProviderStatus['connection']>>, 'codex'> & {
    authenticated?: boolean;
    authMethod?: string | null;
    selectedBackendId?: string | null;
    resolvedBackendId?: string | null;
    availableBackends?: CliProviderStatus['availableBackends'];
    canLoginFromUi?: boolean;
    codex?: Partial<NonNullable<NonNullable<CliProviderStatus['connection']>['codex']>>;
  }
): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: overrides?.authenticated ?? true,
    authMethod: overrides?.authMethod ?? 'api_key',
    verificationState: 'verified',
    statusMessage: 'Codex native ready',
    models: ['gpt-5-codex'],
    canLoginFromUi: overrides?.canLoginFromUi ?? false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: overrides?.selectedBackendId ?? 'codex-native',
    resolvedBackendId: overrides?.resolvedBackendId ?? 'codex-native',
    availableBackends: overrides?.availableBackends ?? [
      {
        id: 'codex-native',
        label: 'Codex native',
        description: 'Use the local codex exec JSON seam.',
        selectable: true,
        recommended: true,
        available: true,
        state: 'ready',
        audience: 'general',
        statusMessage: 'Codex native ready',
      },
    ],
    externalRuntimeDiagnostics: [],
    backend: {
      kind: 'codex-native',
      label: 'Codex native',
    },
    connection: {
      supportsOAuth: false,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
      configuredAuthMode: overrides?.configuredAuthMode ?? 'auto',
      apiKeyConfigured: overrides?.apiKeyConfigured ?? false,
      apiKeySource: overrides?.apiKeySource ?? null,
      apiKeySourceLabel: overrides?.apiKeySourceLabel ?? null,
      codex: {
        preferredAuthMode: 'auto',
        effectiveAuthMode: overrides?.apiKeyConfigured ? 'api_key' : null,
        appServerState: 'healthy',
        appServerStatusMessage: null,
        managedAccount: null,
        requiresOpenaiAuth: null,
        login: {
          status: 'idle',
          error: null,
          startedAt: null,
        },
        rateLimits: null,
        launchAllowed:
          Boolean(overrides?.authenticated ?? true) || Boolean(overrides?.apiKeyConfigured),
        launchIssueMessage: null,
        launchReadinessState:
          Boolean(overrides?.authenticated ?? true) || Boolean(overrides?.apiKeyConfigured)
            ? 'ready_api_key'
            : 'missing_auth',
        ...overrides?.codex,
      },
    },
  };
}

function createAnthropicProvider(
  overrides?: Partial<CliProviderStatus['connection']> & {
    authenticated?: boolean;
    authMethod?: string | null;
  }
): CliProviderStatus {
  return {
    providerId: 'anthropic',
    displayName: 'Anthropic',
    supported: true,
    authenticated: overrides?.authenticated ?? true,
    authMethod: overrides?.authMethod ?? 'oauth_token',
    verificationState: 'verified',
    statusMessage: 'Connected',
    models: ['claude-sonnet-4-6'],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [],
    backend: null,
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: ['auto', 'oauth', 'api_key'],
      configuredAuthMode: overrides?.configuredAuthMode ?? 'auto',
      apiKeyConfigured: overrides?.apiKeyConfigured ?? false,
      apiKeySource: overrides?.apiKeySource ?? null,
      apiKeySourceLabel: overrides?.apiKeySourceLabel ?? null,
    },
  };
}

function createGeminiProvider(): CliProviderStatus {
  return {
    providerId: 'gemini',
    displayName: 'Gemini',
    supported: true,
    authenticated: true,
    authMethod: 'api_key',
    verificationState: 'verified',
    statusMessage: 'Connected',
    models: ['gemini-2.5-pro'],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: 'auto',
    resolvedBackendId: 'api',
    availableBackends: [
      {
        id: 'auto',
        label: 'Auto',
        description: 'Automatically choose the best backend.',
        selectable: true,
        recommended: true,
        available: true,
      },
      {
        id: 'api',
        label: 'Gemini API',
        description: 'Use GEMINI_API_KEY and Google AI Studio billing.',
        selectable: true,
        recommended: false,
        available: true,
      },
    ],
    externalRuntimeDiagnostics: [],
    backend: {
      kind: 'api',
      label: 'Gemini API',
    },
    connection: {
      supportsOAuth: false,
      supportsApiKey: true,
      configurableAuthModes: [],
      configuredAuthMode: null,
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel: 'Stored in app',
    },
  };
}

function createOpenCodeProvider(): CliProviderStatus {
  return {
    providerId: 'opencode',
    displayName: 'OpenCode',
    supported: true,
    authenticated: true,
    authMethod: 'opencode_managed',
    verificationState: 'verified',
    statusMessage: 'Managed runtime verified',
    detailMessage: 'version 1.4.0 - live resolved-fin - managed teammate agent',
    models: ['openai/gpt-5.4-mini'],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: false,
      oneShot: false,
      extensions: createDefaultCliExtensionCapabilities(),
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
    externalRuntimeDiagnostics: [
      {
        id: 'opencode-live-host',
        label: 'OpenCode live host',
        detected: true,
        statusMessage: 'Healthy',
        detailMessage: 'resolved resolved-fin',
      },
      {
        id: 'opencode-managed-runtime',
        label: 'OpenCode managed runtime',
        detected: true,
        statusMessage: 'Managed runtime verified',
        detailMessage: 'managed teammate agent',
      },
      {
        id: 'opencode-behavior',
        label: 'OpenCode behavior',
        detected: true,
        statusMessage: 'Behavior fingerprint stable',
        detailMessage: 'behavior abc123',
      },
      {
        id: 'opencode-extra',
        label: 'Should be hidden',
        detected: false,
        statusMessage: 'Hidden',
        detailMessage: 'Only first three diagnostics are shown',
      },
    ],
    backend: {
      kind: 'opencode-cli',
      label: 'OpenCode CLI',
      authMethodDetail: 'managed teammate agent',
    },
    connection: null,
  };
}

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button with text "${text}" not found`);
  }
  return button;
}

function setInputValue(input: HTMLInputElement, value: string): void {
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
  if (!setter) {
    throw new Error('HTMLInputElement value setter not found');
  }

  setter.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true }));
}

describe('ProviderRuntimeSettingsDialog', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
    codexAccountHookState.refresh.mockReset().mockResolvedValue(undefined);
    codexAccountHookState.startChatgptLogin.mockReset().mockResolvedValue(true);
    codexAccountHookState.cancelChatgptLogin.mockReset().mockResolvedValue(true);
    codexAccountHookState.logout.mockReset().mockResolvedValue(true);
    storeState.appConfig = {
      providerConnections: {
        anthropic: {
          authMode: 'auto',
        },
        codex: {
          preferredAuthMode: 'auto',
        },
      },
    };
    storeState.apiKeys = [];
    storeState.apiKeysLoading = false;
    storeState.apiKeysError = null;
    storeState.apiKeySaving = false;
    storeState.apiKeyStorageStatus = { available: true, backend: 'keytar', detail: null };
    storeState.fetchApiKeys = vi.fn(() => Promise.resolve(undefined));
    storeState.fetchApiKeyStorageStatus = vi.fn(() => Promise.resolve(undefined));
    storeState.saveApiKey = vi.fn(() => Promise.resolve(undefined));
    storeState.deleteApiKey = vi.fn(() => Promise.resolve(undefined));
    storeState.updateConfig = vi.fn((section: string, data: Record<string, unknown>) => {
      if (section === 'providerConnections') {
        const nextProviderConnections = data as Partial<
          StoreState['appConfig']['providerConnections']
        >;
        storeState.appConfig = {
          ...storeState.appConfig,
          providerConnections: {
            anthropic: {
              ...storeState.appConfig.providerConnections.anthropic,
              ...(nextProviderConnections.anthropic ?? {}),
            },
            codex: {
              ...storeState.appConfig.providerConnections.codex,
              ...(nextProviderConnections.codex ?? {}),
            },
          },
        };
      }

      return Promise.resolve(undefined);
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders provider logos inside the provider tabs', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createAnthropicProvider(), createCodexProvider()],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="provider-logo-anthropic"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="provider-logo-codex"]')).not.toBeNull();
  });

  it('renders anthropic connection cards and can switch to API key mode', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              configuredAuthMode: 'auto',
              apiKeyConfigured: true,
              apiKeySource: 'stored',
              apiKeySourceLabel: 'Stored in app',
            }),
          ],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Connection method');
    expect(host.textContent).toContain('Anthropic subscription');
    expect(host.textContent).toContain('API key');

    await act(async () => {
      findButtonByText(host, 'API key').click();
      await Promise.resolve();
    });

    expect(storeState.updateConfig).toHaveBeenCalledWith('providerConnections', {
      anthropic: {
        authMode: 'api_key',
      },
    });
    expect(onRefreshProvider).toHaveBeenCalledWith('anthropic');
  });

  it('accepts and saves a typed Anthropic API key from provider settings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              authenticated: false,
              authMethod: null,
              apiKeyConfigured: false,
              apiKeySource: null,
              apiKeySourceLabel: null,
            }),
          ],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Set API key').click();
      await Promise.resolve();
    });

    const input = host.querySelector('#anthropic-api-key') as HTMLInputElement | null;
    expect(input).not.toBeNull();

    await act(async () => {
      setInputValue(input!, 'sk-ant-test-key');
      await Promise.resolve();
    });

    expect(input!.value).toBe('sk-ant-test-key');

    await act(async () => {
      findButtonByText(host, 'Save key').click();
      await Promise.resolve();
    });

    expect(storeState.saveApiKey).toHaveBeenCalledWith(
      expect.objectContaining({
        envVarName: 'ANTHROPIC_API_KEY',
        name: 'Anthropic API Key',
        scope: 'user',
        value: 'sk-ant-test-key',
      })
    );
    expect(onRefreshProvider).toHaveBeenCalledWith('anthropic');
  });

  it('shows native-only Codex connection copy and API-key management without login actions', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              apiKeyConfigured: true,
              apiKeySource: 'stored',
              apiKeySourceLabel: 'Stored in app',
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
          onRequestLogin: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Choose whether Codex should prefer your ChatGPT subscription or an API key when the native runtime launches.'
    );
    expect(host.textContent).toContain('Connection method');
    expect(host.textContent).toContain('ChatGPT account');
    expect(host.textContent).toContain('Use an OpenAI API key as a secondary Codex auth path.');
    expect(host.textContent).toContain('Set API key');
    expect(host.textContent).toContain('Connect ChatGPT');
  });

  it('explains the missing Codex ChatGPT login without mixing it up with the detected API key', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    storeState.appConfig.providerConnections.codex.preferredAuthMode = 'chatgpt';

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      requiresOpenaiAuth: true,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: null,
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: null,
                requiresOpenaiAuth: true,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: false,
                launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
                launchReadinessState: 'missing_auth',
              },
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex CLI currently has no active ChatGPT account. Connect ChatGPT to use your subscription. Switch to API key mode to use the detected API key.'
    );
    expect(host.textContent).toContain(
      'Codex CLI currently reports no active ChatGPT account. Usage limits appear here only after Codex CLI sees one. The detected API key is only used after you switch Codex to API key mode.'
    );
    expect(host.textContent).toContain('Detected from OPENAI_API_KEY');
    expect(host.textContent).not.toContain(
      'ChatGPT account mode is selected, but no managed Codex account is connected yet.'
    );
  });

  it('mentions local Codex account artifacts when ChatGPT mode is pinned but no active managed session is selected', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    storeState.appConfig.providerConnections.codex.preferredAuthMode = 'chatgpt';

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      requiresOpenaiAuth: true,
      localAccountArtifactsPresent: true,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: null,
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: null,
                requiresOpenaiAuth: true,
                localAccountArtifactsPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: false,
                launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
                launchReadinessState: 'missing_auth',
              },
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex CLI currently has no active ChatGPT account. Local Codex account data exists, but no active managed session is selected. Switch to API key mode to use the detected API key.'
    );
    expect(host.textContent).toContain(
      'Codex CLI currently reports no active ChatGPT account. Local Codex account data exists, but no active managed session is selected. Usage limits appear here only after Codex CLI sees one. The detected API key is only used after you switch Codex to API key mode.'
    );
  });

  it('asks for reconnect when ChatGPT mode is pinned and a local selected account exists but the session is stale', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    storeState.appConfig.providerConnections.codex.preferredAuthMode = 'chatgpt';

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      requiresOpenaiAuth: true,
      localAccountArtifactsPresent: true,
      localActiveChatgptAccountPresent: true,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              configuredAuthMode: 'chatgpt',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
              codex: {
                preferredAuthMode: 'chatgpt',
                effectiveAuthMode: null,
                appServerState: 'healthy',
                appServerStatusMessage: null,
                managedAccount: null,
                requiresOpenaiAuth: true,
                localAccountArtifactsPresent: true,
                localActiveChatgptAccountPresent: true,
                login: {
                  status: 'idle',
                  error: null,
                  startedAt: null,
                },
                rateLimits: null,
                launchAllowed: false,
                launchIssueMessage:
                  'Reconnect ChatGPT to refresh the current Codex subscription session.',
                launchReadinessState: 'missing_auth',
              },
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex has a locally selected ChatGPT account, but the current session needs reconnect. Switch to API key mode to use the detected API key.'
    );
    expect(host.textContent).toContain(
      'Codex has a locally selected ChatGPT account, but the current session needs reconnect before usage limits can load here. The detected API key is only used after you switch Codex to API key mode.'
    );
    expect(host.textContent).toContain('Reconnect ChatGPT');
    expect(host.textContent).not.toContain('Disconnect account');
    expect(host.textContent).toContain('Reconnect required');
  });

  it('disables Codex account actions while a Codex account request is already in flight', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    codexAccountHookState.loading = true;
    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: true,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              configuredAuthMode: 'chatgpt',
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(findButtonByText(host, 'Refresh').disabled).toBe(true);
    expect(findButtonByText(host, 'Connect ChatGPT').disabled).toBe(true);
  });

  it('prefers live Codex snapshot readiness over stale provider status after the account hook refreshes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'auto',
      effectiveAuthMode: 'chatgpt',
      launchAllowed: true,
      launchIssueMessage: null,
      launchReadinessState: 'ready_chatgpt',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: {
        type: 'chatgpt',
        email: 'belief@example.com',
        planType: 'plus',
      },
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              apiKeyConfigured: false,
              codex: {
                launchAllowed: false,
                launchIssueMessage:
                  'Connect a ChatGPT account or add OPENAI_API_KEY / CODEX_API_KEY to use Codex.',
                launchReadinessState: 'missing_auth',
              },
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('belief@example.com');
    expect(host.textContent).toContain('Plan: plus');
    expect(host.textContent).not.toContain(
      'Connect a ChatGPT account or add OPENAI_API_KEY / CODEX_API_KEY to use Codex.'
    );
  });

  it('starts the ChatGPT login flow from the Codex account panel', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Connect ChatGPT').click();
      await Promise.resolve();
    });

    expect(codexAccountHookState.startChatgptLogin).toHaveBeenCalledTimes(1);
  });

  it('shows cancel login while pending and refreshes provider state after cancellation', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: true,
      login: {
        status: 'pending',
        error: null,
        startedAt: '2026-04-20T12:00:00.000Z',
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Cancel login');

    await act(async () => {
      findButtonByText(host, 'Cancel login').click();
      await Promise.resolve();
    });

    expect(codexAccountHookState.cancelChatgptLogin).toHaveBeenCalledTimes(1);
    expect(onRefreshProvider).toHaveBeenCalledWith('codex');
  });

  it('surfaces a pending Codex ChatGPT login as a waiting alert instead of a missing-account warning', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    codexAccountHookState.snapshot = {
      preferredAuthMode: 'chatgpt',
      effectiveAuthMode: null,
      launchAllowed: false,
      launchIssueMessage: 'Connect a ChatGPT account to use your Codex subscription.',
      launchReadinessState: 'missing_auth',
      appServerState: 'healthy',
      appServerStatusMessage: null,
      managedAccount: null,
      apiKey: {
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
      },
      requiresOpenaiAuth: true,
      login: {
        status: 'pending',
        error: null,
        startedAt: '2026-04-20T12:00:00.000Z',
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              authenticated: false,
              authMethod: null,
              configuredAuthMode: 'chatgpt',
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Waiting for ChatGPT account login to finish...');
    expect(host.textContent).not.toContain(
      'Codex CLI currently has no active ChatGPT account. Connect ChatGPT to use your subscription, or switch to API key mode to use the detected API key.'
    );
  });

  it('shows disconnect account for connected Codex subscriptions and refreshes after logout', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));

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
        email: 'belief@example.com',
        planType: 'pro',
      },
      apiKey: {
        available: true,
        source: 'stored',
        sourceLabel: 'Stored in app',
      },
      requiresOpenaiAuth: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: null,
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createCodexProvider()],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Disconnect account');

    await act(async () => {
      findButtonByText(host, 'Disconnect account').click();
      await Promise.resolve();
    });

    expect(codexAccountHookState.logout).toHaveBeenCalledTimes(1);
    expect(onRefreshProvider).toHaveBeenCalledWith('codex');
  });

  it('renders Codex rate limits when available from the live account snapshot', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

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
        email: 'belief@example.com',
        planType: 'pro',
      },
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: {
          usedPercent: 77,
          windowDurationMins: 300,
          resetsAt: 1_776_678_034,
        },
        secondary: {
          usedPercent: 45,
          windowDurationMins: 10_080,
          resetsAt: 1_776_999_999,
        },
        credits: {
          hasCredits: true,
          unlimited: false,
          balance: '42',
        },
        planType: 'pro',
      },
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createCodexProvider()],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Primary used (5h)');
    expect(host.textContent).toContain('77%');
    expect(host.textContent).toContain('23% left');
    expect(host.textContent).toContain('Primary reset (5h)');
    expect(host.textContent).toContain(new Date(1_776_678_034_000).toLocaleString());
    expect(host.textContent).toContain('Weekly used (1w)');
    expect(host.textContent).toContain('45%');
    expect(host.textContent).toContain('55% left');
    expect(host.textContent).toContain('Weekly reset (1w)');
    expect(host.textContent).toContain(new Date(1_776_999_999_000).toLocaleString());
    expect(host.textContent).toContain('Credits');
    expect(host.textContent).toContain('42');
    expect(host.textContent).toContain('These percentages show used quota, not remaining quota.');
    expect(host.textContent).toContain('77% used - about 23% left in the current 5-hour window.');
  });

  it('shows truthful Codex rate-limit fallbacks instead of misleading zero values', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

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
        email: 'belief@example.com',
        planType: 'pro',
      },
      apiKey: {
        available: false,
        source: null,
        sourceLabel: null,
      },
      requiresOpenaiAuth: false,
      login: {
        status: 'idle',
        error: null,
        startedAt: null,
      },
      rateLimits: {
        limitId: 'codex',
        limitName: null,
        primary: {
          usedPercent: null as never,
          windowDurationMins: 300,
          resetsAt: null,
        },
        secondary: null,
        credits: {
          hasCredits: false,
          unlimited: false,
          balance: '0',
        },
        planType: 'pro',
      },
      updatedAt: new Date().toISOString(),
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createCodexProvider()],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Primary used (5h)');
    expect(host.textContent).toContain('Unknown');
    expect(host.textContent).toContain('Remaining unknown');
    expect(host.textContent).toContain('Credits');
    expect(host.textContent).toContain('Not available');
    expect(host.textContent).not.toContain('0%');
    expect(host.textContent).toContain(
      'Shows used quota in the current 5-hour window, not remaining quota.'
    );
  });

  it('keeps the API key icon container square', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createAnthropicProvider()],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    const icon = host.querySelector('[data-testid="provider-api-key-icon"]');
    expect(icon).not.toBeNull();
    expect(icon?.className).toContain('size-8');
    expect(icon?.className).not.toContain('w-8');
    expect(icon?.className).toContain('shrink-0');
  });

  it('keeps the API key form open and shows an error when delete fails', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));
    storeState.apiKeys = [
      {
        id: 'key-1',
        envVarName: 'OPENAI_API_KEY',
        scope: 'user',
        name: 'Codex API Key',
        maskedValue: 'sk-proj-...1234',
        createdAt: Date.now(),
      },
    ];
    storeState.deleteApiKey = vi.fn(() => Promise.reject(new Error('Delete failed')));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              apiKeyConfigured: true,
              apiKeySource: 'stored',
              apiKeySourceLabel: 'Stored in app',
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Replace key').click();
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Delete').click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Delete failed');
    expect(host.textContent).toContain('Update key');
    expect(onRefreshProvider).not.toHaveBeenCalled();
  });

  it('shows a runtime error when backend selection refresh fails after a successful update', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onSelectBackend = vi.fn(() =>
      Promise.reject(new Error('Runtime updated, but failed to refresh provider status.'))
    );

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createGeminiProvider()],
          initialProviderId: 'gemini',
          onSelectBackend,
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Select runtime backend').click();
      await Promise.resolve();
    });

    expect(onSelectBackend).toHaveBeenCalledWith('gemini', 'api');
    expect(host.textContent).toContain('Runtime updated, but failed to refresh provider status.');
  });

  it('renders the OpenCode runtime provider management feature panel', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [createOpenCodeProvider()],
          initialProviderId: 'opencode',
          projectPath: '/tmp/project-a',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    const panel = host.querySelector('[data-testid="runtime-provider-management-panel"]');
    expect(panel).not.toBeNull();
    expect(panel?.getAttribute('data-runtime-id')).toBe('opencode');
    expect(panel?.getAttribute('data-open')).toBe('true');
    expect(panel?.getAttribute('data-project-path')).toBe('/tmp/project-a');
    expect(host.textContent).toContain('Runtime provider management: opencode');
    expect(host.textContent).not.toContain('Desktop currently exposes status only.');
  });
});
