import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallationStatus } from '@shared/types';
import { createDefaultCliExtensionCapabilities } from '@shared/utils/providerExtensionCapabilities';

interface StoreState {
  apiKeys: Array<{
    id: string;
    providerId: string;
    displayName: string;
    envVarName: string;
    scope: 'user';
    createdAt: number;
    updatedAt: number;
  }>;
  apiKeysLoading: boolean;
  apiKeysError: string | null;
  apiKeyStorageStatus: {
    encryptionMethod: 'os-keychain' | 'local-aes';
    backend: string;
  } | null;
  fetchApiKeyStorageStatus: ReturnType<typeof vi.fn>;
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
  appConfig: {
    general: {
      multimodelEnabled: boolean;
    };
  } | null;
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

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

vi.mock('@renderer/api', () => ({
  isElectronMode: () => true,
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: React.PropsWithChildren<{ onClick?: () => void }>) =>
    React.createElement(
      'button',
      {
        type: 'button',
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: () => null,
}));

vi.mock('@renderer/components/extensions/apikeys/ApiKeyCard', () => ({
  ApiKeyCard: ({ apiKey }: { apiKey: { displayName: string } }) =>
    React.createElement('div', null, apiKey.displayName),
}));

vi.mock('@renderer/components/extensions/apikeys/ApiKeyFormDialog', () => ({
  ApiKeyFormDialog: () => null,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    Info: Icon,
    Key: Icon,
    Plus: Icon,
  };
});

import { ApiKeysPanel } from '@renderer/components/extensions/apikeys/ApiKeysPanel';

function createCliStatus(): CliInstallationStatus {
  return {
    flavor: 'agent_teams_orchestrator',
    displayName: 'Multimodel runtime',
    supportsSelfUpdate: false,
    showVersionDetails: false,
    showBinaryPath: false,
    installed: true,
    installedVersion: null,
    binaryPath: '/usr/local/bin/agent-teams',
    launchError: null,
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: true,
    authStatusChecking: false,
    authMethod: null,
    providers: [
      {
        providerId: 'anthropic',
        displayName: 'Anthropic',
        supported: true,
        authenticated: true,
        authMethod: 'oauth_token',
        verificationState: 'verified',
        statusMessage: 'Connected',
        models: [],
        modelAvailability: [],
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
          configuredAuthMode: 'auto',
          apiKeyConfigured: false,
          apiKeySource: null,
          apiKeySourceLabel: null,
        },
      },
      {
        providerId: 'codex',
        displayName: 'Codex',
        supported: true,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
        models: [],
        modelAvailability: [],
        canLoginFromUi: false,
        capabilities: {
          teamLaunch: true,
          oneShot: true,
          extensions: createDefaultCliExtensionCapabilities(),
        },
        selectedBackendId: 'codex-native',
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      },
    ],
  };
}

describe('ApiKeysPanel', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.apiKeys = [];
    storeState.apiKeysLoading = false;
    storeState.apiKeysError = null;
    storeState.apiKeyStorageStatus = {
      encryptionMethod: 'os-keychain',
      backend: 'Keychain Access',
    };
    storeState.fetchApiKeyStorageStatus = vi.fn().mockResolvedValue(undefined);
    storeState.cliStatus = createCliStatus();
    storeState.cliStatusLoading = false;
    storeState.appConfig = {
      general: {
        multimodelEnabled: true,
      },
    };
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the live Codex account snapshot for the Codex runtime card', async () => {
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
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
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

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ApiKeysPanel, {
          projectPath: null,
          projectLabel: null,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex runtime');
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).toContain('Current source: Detected from OPENAI_API_KEY.');
    expect(host.textContent).toContain('ChatGPT account ready');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the live Codex snapshot even while multimodel provider status is still loading', async () => {
    storeState.cliStatus = null;
    storeState.cliStatusLoading = true;
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
        available: true,
        source: 'environment',
        sourceLabel: 'Detected from OPENAI_API_KEY',
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

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ApiKeysPanel, {
          projectPath: null,
          projectLabel: null,
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex runtime');
    expect(host.textContent).toContain('Connected');
    expect(host.textContent).toContain('ChatGPT account ready');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
