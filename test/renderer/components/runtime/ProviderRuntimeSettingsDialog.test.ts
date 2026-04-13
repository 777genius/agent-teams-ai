import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliProviderStatus } from '@shared/types';

interface StoreState {
  appConfig: {
    providerConnections: {
      anthropic: {
        authMode: 'auto' | 'oauth' | 'api_key';
      };
      codex: {
        apiKeyBetaEnabled: boolean;
        authMode: 'oauth' | 'api_key';
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

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: StoreState) => unknown) => selector(storeState);
  Object.assign(useStore, {
    setState: vi.fn(),
  });
  return { useStore };
});

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
  DialogHeader: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  DialogTitle: ({ children }: React.PropsWithChildren) => React.createElement('h2', null, children),
  DialogDescription: ({ children }: React.PropsWithChildren) =>
    React.createElement('p', null, children),
}));

vi.mock('@renderer/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) =>
    React.createElement('input', props),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: React.PropsWithChildren) => React.createElement('label', null, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement('button', { type: 'button' }, children),
  SelectValue: () => React.createElement('span', null, 'select-value'),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren<{ value: string }>) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@renderer/components/ui/tabs', () => ({
  Tabs: ({
    children,
    value,
    onValueChange,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) =>
    React.createElement('div', { 'data-value': value, 'data-on-change': Boolean(onValueChange) }, children),
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
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: ({ providerId }: { providerId: string }) =>
    React.createElement('span', {
      'data-testid': `provider-logo-${providerId}`,
      'data-provider-id': providerId,
    }),
}));

import { ProviderRuntimeSettingsDialog } from '@renderer/components/runtime/ProviderRuntimeSettingsDialog';

function createCodexProvider(
  overrides?: Partial<CliProviderStatus['connection']> & {
    authenticated?: boolean;
    authMethod?: string | null;
  }
): CliProviderStatus {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: overrides?.authenticated ?? true,
    authMethod: overrides?.authMethod ?? 'oauth_token',
    verificationState: 'verified',
    statusMessage: 'Connected',
    models: ['gpt-5-codex'],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    selectedBackendId: 'auto',
    resolvedBackendId: 'adapter',
    availableBackends: [],
    backend: {
      kind: 'adapter',
      label: 'Codex subscription',
    },
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: overrides?.apiKeyBetaEnabled ? ['oauth', 'api_key'] : [],
      configuredAuthMode: overrides?.configuredAuthMode ?? null,
      apiKeyBetaAvailable: true,
      apiKeyBetaEnabled: overrides?.apiKeyBetaEnabled ?? false,
      apiKeyConfigured: overrides?.apiKeyConfigured ?? false,
      apiKeySource: overrides?.apiKeySource ?? null,
      apiKeySourceLabel: overrides?.apiKeySourceLabel ?? null,
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
    },
    selectedBackendId: null,
    resolvedBackendId: null,
    availableBackends: [],
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

function findButtonByText(container: HTMLElement, text: string): HTMLButtonElement {
  const button = Array.from(container.querySelectorAll('button')).find((candidate) =>
    candidate.textContent?.includes(text)
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button with text "${text}" not found`);
  }
  return button;
}

function countOccurrences(text: string, fragment: string): number {
  return text.split(fragment).length - 1;
}

describe('ProviderRuntimeSettingsDialog Codex connection flows', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.appConfig = {
      providerConnections: {
        anthropic: {
          authMode: 'auto',
        },
        codex: {
          apiKeyBetaEnabled: false,
          authMode: 'oauth',
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
        const nextProviderConnections = data as Partial<StoreState['appConfig']['providerConnections']>;
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

  it('switches Codex into api_key mode when enabling API key mode', async () => {
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
            createCodexProvider({
              apiKeyBetaEnabled: false,
              configuredAuthMode: null,
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
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
      findButtonByText(host, 'Enable API key mode').click();
      await Promise.resolve();
    });

    expect(storeState.updateConfig).toHaveBeenCalledWith('providerConnections', {
      codex: {
        apiKeyBetaEnabled: true,
        authMode: 'api_key',
      },
    });
    expect(onRefreshProvider).toHaveBeenCalledWith('codex');
  });

  it('shows a loading message while switching Codex to OpenAI API key', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    let resolveUpdate: (() => void) | null = null;
    storeState.appConfig.providerConnections.codex = {
      apiKeyBetaEnabled: true,
      authMode: 'oauth',
    };
    storeState.updateConfig = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveUpdate = resolve;
        })
    );

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              apiKeyBetaEnabled: true,
              configuredAuthMode: 'oauth',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
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
      findButtonByText(host, 'OpenAI API key').click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Switching to OpenAI API key...');
    expect(host.textContent).toContain('Switching...');

    await act(async () => {
      resolveUpdate?.();
      await Promise.resolve();
    });
  });

  it('removes duplicate Codex summary and API key source text when connection cards are visible', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    storeState.appConfig.providerConnections.codex = {
      apiKeyBetaEnabled: true,
      authMode: 'oauth',
    };

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              apiKeyBetaEnabled: true,
              configuredAuthMode: 'oauth',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
            }),
          ],
          initialProviderId: 'codex',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Current runtime: Codex subscription');
    expect(host.textContent).not.toContain('Mode: Codex subscription');
    expect(host.textContent).not.toContain('Runtime: Default adapter');
    expect(countOccurrences(host.textContent ?? '', 'Using Codex subscription')).toBe(0);
    expect(countOccurrences(host.textContent ?? '', 'Detected from OPENAI_API_KEY')).toBe(1);
    expect(host.textContent).not.toContain('Connected');
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

  it('renders Anthropics connection methods as cards and hides the empty runtime section', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              configuredAuthMode: 'auto',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from ANTHROPIC_API_KEY',
            }),
          ],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Connection method');
    expect(host.textContent).toContain('Auto');
    expect(host.textContent).toContain('Anthropic subscription');
    expect(host.textContent).toContain('API key');
    expect(host.textContent).not.toContain('Authentication method');
    expect(host.textContent).not.toContain('Runtime backend is not configurable');
    expect(host.textContent).not.toContain('Mode: Auto');
    expect(countOccurrences(host.textContent ?? '', 'Using Anthropic subscription')).toBe(1);
    expect(countOccurrences(host.textContent ?? '', 'Detected from ANTHROPIC_API_KEY')).toBe(1);
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

  it('switches Anthropic to API key mode from the connection cards', async () => {
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

  it('does not show Connect Anthropic when Auto is already authenticated via API key', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              authenticated: true,
              authMethod: 'api_key',
              configuredAuthMode: 'auto',
              apiKeyConfigured: true,
              apiKeySource: 'environment',
              apiKeySourceLabel: 'Detected from ANTHROPIC_API_KEY',
            }),
          ],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider: vi.fn(() => Promise.resolve(undefined)),
          onRequestLogin: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Connect Anthropic');
    expect(host.textContent).not.toContain('Reconnect Anthropic');
  });

  it('keeps the API key form open and shows an error when delete fails', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));
    storeState.apiKeys = [
      {
        id: 'key-1',
        envVarName: 'ANTHROPIC_API_KEY',
        scope: 'user',
        name: 'Anthropic API Key',
        maskedValue: 'sk-ant-...1234',
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
            createAnthropicProvider({
              configuredAuthMode: 'api_key',
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

  it('shows a deleted stored key as removed even if provider refresh fails afterwards', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.reject(new Error('refresh failed')));
    storeState.apiKeys = [
      {
        id: 'key-1',
        envVarName: 'ANTHROPIC_API_KEY',
        scope: 'user',
        name: 'Anthropic API Key',
        maskedValue: 'sk-ant-...1234',
        createdAt: Date.now(),
      },
    ];
    storeState.deleteApiKey = vi.fn((id: string) => {
      storeState.apiKeys = storeState.apiKeys.filter((entry) => entry.id !== id);
      return Promise.resolve(undefined);
    });

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              configuredAuthMode: 'api_key',
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

    await act(async () => {
      findButtonByText(host, 'Replace key').click();
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Delete').click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('API key deleted, but failed to refresh provider status.');
    expect(host.textContent).toContain('Not configured');
    expect(host.textContent).not.toContain('sk-ant-...1234');
  });

  it('shows a connection error and skips refresh when auth mode update fails', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));
    storeState.updateConfig = vi.fn(() => Promise.reject(new Error('Config update failed')));

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

    await act(async () => {
      findButtonByText(host, 'API key').click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Config update failed');
    expect(host.textContent).not.toContain('Switching to API key...');
    expect(host.textContent).not.toContain('Switching...');
    expect(onRefreshProvider).not.toHaveBeenCalled();
  });

  it('clears Codex beta loading state when enabling API key mode fails early', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.resolve(undefined));
    storeState.updateConfig = vi.fn(() => Promise.reject(new Error('Config update failed')));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              apiKeyBetaEnabled: false,
              configuredAuthMode: null,
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
      findButtonByText(host, 'Enable API key mode').click();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Config update failed');
    expect(host.textContent).not.toContain('Enabling API key mode...');
    expect(onRefreshProvider).not.toHaveBeenCalled();
  });

  it('reports refresh failures separately after a successful auth mode update', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.reject(new Error('refresh failed')));
    storeState.updateConfig = vi.fn((section: string, data: Record<string, unknown>) => {
      if (section === 'providerConnections') {
        const nextProviderConnections = data as Partial<StoreState['appConfig']['providerConnections']>;
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

    await act(async () => {
      findButtonByText(host, 'API key').click();
      await Promise.resolve();
    });

    expect(storeState.updateConfig).toHaveBeenCalled();
    expect(onRefreshProvider).toHaveBeenCalledWith('anthropic');
    expect(host.textContent).not.toContain('Mode: API key');
    expect(host.textContent).toContain('API keySelected');
    expect(host.textContent).toContain('Connection updated, but failed to refresh provider status.');
    expect(host.textContent).not.toContain('Failed to update connection');
  });

  it('shows subscription recovery actions when OAuth mode is selected but stale status still says API key', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.reject(new Error('refresh failed')));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createAnthropicProvider({
              authenticated: true,
              authMethod: 'api_key',
              configuredAuthMode: 'auto',
              apiKeyConfigured: true,
              apiKeySource: 'stored',
              apiKeySourceLabel: 'Stored in app',
            }),
          ],
          initialProviderId: 'anthropic',
          onSelectBackend: vi.fn(),
          onRefreshProvider,
          onRequestLogin: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      findButtonByText(host, 'Anthropic subscription').click();
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Mode: Anthropic subscription');
    expect(host.textContent).toContain('Anthropic subscriptionSelected');
    expect(host.textContent).toContain('Connect Anthropic');
    expect(host.textContent).toContain(
      'Anthropic subscription mode is selected. Sign in with Anthropic to use this provider.'
    );
    expect(host.textContent).toContain('Connection updated, but failed to refresh provider status.');
  });

  it('keeps the Codex API key mode UI in sync with config when refresh fails after enabling beta', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onRefreshProvider = vi.fn(() => Promise.reject(new Error('refresh failed')));

    await act(async () => {
      root.render(
        React.createElement(ProviderRuntimeSettingsDialog, {
          open: true,
          onOpenChange: vi.fn(),
          providers: [
            createCodexProvider({
              apiKeyBetaEnabled: false,
              configuredAuthMode: null,
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
      findButtonByText(host, 'Enable API key mode').click();
      await Promise.resolve();
    });

    expect(storeState.updateConfig).toHaveBeenCalledWith('providerConnections', {
      codex: {
        apiKeyBetaEnabled: true,
        authMode: 'api_key',
      },
    });
    expect(host.textContent).not.toContain('Mode: API key');
    expect(host.textContent).toContain('Selected');
    expect(host.textContent).toContain('Disable API key mode');
    expect(host.textContent).toContain('Connection updated, but failed to refresh provider status.');
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
});
