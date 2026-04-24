import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';

interface StoreState {
  cliStatus: Record<string, unknown> | null;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Record<string, boolean>;
  cliStatusError: string | null;
  cliInstallerState:
    | 'idle'
    | 'checking'
    | 'downloading'
    | 'verifying'
    | 'installing'
    | 'completed'
    | 'error';
  cliDownloadProgress: number;
  cliDownloadTransferred: number;
  cliDownloadTotal: number;
  cliInstallerError: string | null;
  cliInstallerDetail: string | null;
  cliInstallerRawChunks: string[];
  cliCompletedVersion: string | null;
  bootstrapCliStatus: ReturnType<typeof vi.fn>;
  fetchCliStatus: ReturnType<typeof vi.fn>;
  fetchCliProviderStatus: ReturnType<typeof vi.fn>;
  invalidateCliStatus: ReturnType<typeof vi.fn>;
  installCli: ReturnType<typeof vi.fn>;
  appConfig: {
    general: {
      multimodelEnabled: boolean;
    };
    runtime?: {
      providerBackends?: Record<string, string>;
    };
  };
  updateConfig: ReturnType<typeof vi.fn>;
  openExtensionsTab: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;
let providerRuntimeSettingsDialogProps: {
  onSelectBackend?: (providerId: string, backendId: string) => Promise<void> | void;
  open?: boolean;
  initialProviderId?: string;
} | null = null;
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(undefined)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/api', () => ({
  api: {
    showInFolder: vi.fn(),
  },
  isElectronMode: () => true,
}));

vi.mock('@features/codex-account/renderer', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@features/codex-account/renderer')>();
  return {
    ...actual,
    useCodexAccountSnapshot: () => codexAccountHookState,
  };
});

vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('@renderer/components/runtime/ProviderRuntimeSettingsDialog', () => ({
  ProviderRuntimeSettingsDialog: (props: {
    onSelectBackend?: (providerId: string, backendId: string) => Promise<void> | void;
    open?: boolean;
    initialProviderId?: string;
  }) => {
    providerRuntimeSettingsDialogProps = props;
    return React.createElement(
      'div',
      {
        'data-testid': 'provider-runtime-settings-dialog',
        'data-open': String(Boolean(props.open)),
        'data-provider': props.initialProviderId ?? '',
      },
      null
    );
  },
}));

vi.mock('@renderer/components/runtime/ProviderRuntimeBackendSelector', async () => {
  const actual =
    await vi.importActual<typeof import('@renderer/components/runtime/ProviderRuntimeBackendSelector')>(
      '@renderer/components/runtime/ProviderRuntimeBackendSelector'
    );
  return {
    getProviderRuntimeBackendSummary: actual.getProviderRuntimeBackendSummary,
  };
});

vi.mock('@renderer/components/settings/components', async () => {
  const actual = await vi.importActual<object>('@renderer/components/settings/components');
  return {
    ...actual,
    SettingsToggle: ({
      enabled,
      disabled,
      onChange,
    }: {
      enabled: boolean;
      disabled?: boolean;
      onChange: (value: boolean) => void;
    }) =>
      React.createElement(
        'button',
        {
          type: 'button',
          'data-testid': 'multimodel-toggle',
          disabled,
          onClick: () => onChange(!enabled),
        },
        enabled ? 'toggle-on' : 'toggle-off'
      ),
  };
});

vi.mock('@renderer/components/terminal/TerminalLogPanel', () => ({
  TerminalLogPanel: () => React.createElement('div', null, 'terminal-log'),
}));

vi.mock('@renderer/components/terminal/TerminalModal', () => ({
  TerminalModal: () => React.createElement('div', { 'data-testid': 'terminal-modal' }, 'terminal'),
}));

vi.mock('@renderer/store', () => {
  const useStore = (selector: (state: StoreState) => unknown) => selector(storeState);
  Object.assign(useStore, {
    setState: vi.fn(),
  });
  return { useStore };
});

import { CliStatusBanner } from '@renderer/components/dashboard/CliStatusBanner';
import { CliStatusSection } from '@renderer/components/settings/sections/CliStatusSection';

function createInstalledCliStatus(
  overrides?: Partial<Record<string, unknown>>
): Record<string, unknown> {
  return {
    flavor: 'claude',
    displayName: 'Claude CLI',
    supportsSelfUpdate: true,
    showVersionDetails: true,
    showBinaryPath: true,
    installed: true,
    installedVersion: '2.1.100',
    binaryPath: '/usr/local/bin/claude',
    latestVersion: null,
    updateAvailable: false,
    authLoggedIn: false,
    authStatusChecking: false,
    authMethod: null,
    providers: [],
    ...overrides,
  };
}

function createApiKeyMisconfiguredProvider(
  providerId: 'anthropic' | 'codex'
): Record<string, unknown> {
  return {
    providerId,
    displayName: providerId === 'anthropic' ? 'Anthropic' : 'Codex',
    supported: true,
    authenticated: false,
    authMethod: null,
    verificationState: 'error',
    statusMessage:
      providerId === 'anthropic'
        ? 'Anthropic API key mode is enabled, but no ANTHROPIC_API_KEY is configured.'
        : 'Codex native runtime requires OPENAI_API_KEY or CODEX_API_KEY.',
    models: [],
    canLoginFromUi: providerId === 'anthropic',
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    connection: {
      supportsOAuth: providerId === 'anthropic',
      supportsApiKey: true,
      configurableAuthModes:
        providerId === 'anthropic' ? ['auto', 'oauth', 'api_key'] : [],
      configuredAuthMode: providerId === 'anthropic' ? 'api_key' : null,
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
    },
  };
}

function createApiKeyModeProviderIssue(providerId: 'anthropic' | 'codex'): Record<string, unknown> {
  return {
    ...createApiKeyMisconfiguredProvider(providerId),
    statusMessage:
      providerId === 'anthropic'
        ? 'Anthropic API key was rejected by the runtime.'
        : 'Codex native runtime is unavailable because the configured API key was rejected.',
    connection: {
      ...(createApiKeyMisconfiguredProvider(providerId) as { connection: Record<string, unknown> })
        .connection,
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel:
        providerId === 'anthropic' ? 'Stored Anthropic API key' : 'Stored Codex API key',
    },
  };
}

function createCodexNativeRolloutProvider(
  overrides?: Partial<Record<string, unknown>> & {
    state?: 'ready' | 'authentication-required' | 'runtime-missing' | 'degraded';
    audience?: 'general';
    selectable?: boolean;
    available?: boolean;
    statusMessage?: string | null;
    detailMessage?: string | null;
  }
): Record<string, unknown> {
  return {
    providerId: 'codex',
    displayName: 'Codex',
    supported: true,
    authenticated: overrides?.state === 'ready' || overrides?.available === true,
    authMethod: overrides?.state === 'ready' || overrides?.available === true ? 'api_key' : null,
    verificationState:
      overrides?.state === 'ready' || overrides?.available === true ? 'verified' : 'unknown',
    statusMessage: overrides?.statusMessage ?? 'Ready',
    detailMessage:
      overrides?.detailMessage ?? 'Codex native runtime is ready through the local codex exec seam.',
    selectedBackendId: 'codex-native',
    resolvedBackendId:
      overrides?.state === 'ready' || overrides?.available === true ? 'codex-native' : null,
    models: ['gpt-5-codex'],
    canLoginFromUi: false,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    availableBackends: [
      {
        id: 'codex-native',
        label: 'Codex native',
        description: 'Use codex exec JSON mode.',
        selectable: overrides?.selectable ?? true,
        recommended: true,
        available: overrides?.available ?? true,
        state: overrides?.state ?? 'ready',
        audience: overrides?.audience ?? 'general',
        statusMessage: overrides?.statusMessage ?? 'Ready',
        detailMessage:
          overrides?.detailMessage ?? 'Codex native runtime is ready through the local codex exec seam.',
      },
    ],
    backend:
      overrides?.state === 'ready' || overrides?.available === true
        ? {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: 'api_key',
          }
        : null,
    ...overrides,
  };
}

describe('CLI status visibility during completed install state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    providerRuntimeSettingsDialogProps = null;
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
    codexAccountHookState.refresh.mockClear();
    codexAccountHookState.startChatgptLogin.mockClear();
    codexAccountHookState.cancelChatgptLogin.mockClear();
    codexAccountHookState.logout.mockClear();
    storeState.cliStatus = createInstalledCliStatus();
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};
    storeState.cliStatusError = null;
    storeState.cliInstallerState = 'completed';
    storeState.cliDownloadProgress = 0;
    storeState.cliDownloadTransferred = 0;
    storeState.cliDownloadTotal = 0;
    storeState.cliInstallerError = null;
    storeState.cliInstallerDetail = null;
    storeState.cliInstallerRawChunks = [];
    storeState.cliCompletedVersion = '2.1.100';
    storeState.bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCliProviderStatus = vi.fn().mockResolvedValue(undefined);
    storeState.invalidateCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.installCli = vi.fn();
    storeState.appConfig = {
      general: {
        multimodelEnabled: true,
      },
      runtime: {
        providerBackends: {},
      },
    };
    storeState.updateConfig = vi.fn().mockResolvedValue(undefined);
    storeState.openExtensionsTab = vi.fn();
    window.localStorage.clear();
  });

  it('shows multimodel status without exposing the legacy runtime toggle', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Multimodel');
    expect(host.textContent).toContain('Login');

    const toggle = host.querySelector('[data-testid="multimodel-toggle"]');
    expect(toggle).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps authenticated dashboard actions visible after install completion', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: true,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Extensions');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the dashboard Extensions button visible before authentication completes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    const extensionsButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Extensions')
    );
    expect(extensionsButton).not.toBeNull();

    await act(async () => {
      extensionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.openExtensionsTab).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves dashboard runtime backend refresh errors for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.fetchCliProviderStatus = vi.fn(() => Promise.reject(new Error('refresh failed')));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    const onSelectBackend = providerRuntimeSettingsDialogProps?.onSelectBackend;
    expect(onSelectBackend).toBeTypeOf('function');

    await expect(onSelectBackend?.('codex', 'codex-native')).rejects.toThrow(
      'Runtime updated, but failed to refresh provider status.'
    );
    expect(storeState.updateConfig).toHaveBeenCalledWith('runtime', {
      providerBackends: {
        codex: 'codex-native',
      },
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps auth verification inside the main installed banner instead of rendering a second banner', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
      authStatusChecking: true,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking authentication...');
    expect(host.textContent).not.toContain('Verifying authentication...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not render the Anthropic connect action while the provider card is still checking', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: false,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Checking...',
          models: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          backend: null,
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain('Connect Anthropic');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not fall back to direct-Claude auth copy when only hidden multimodel providers are available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: true,
      providers: [
        {
          providerId: 'gemini',
          displayName: 'Gemini',
          supported: true,
          authenticated: true,
          authMethod: 'cli_oauth_personal',
          verificationState: 'verified',
          statusMessage: 'Resolved to CLI SDK',
          models: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Authenticated');
    expect(host.textContent).not.toContain('Providers:');
    expect((host.firstElementChild as HTMLElement | null)?.getAttribute('style')).toContain(
      '245, 158, 11'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the dashboard banner in warning state when only hidden providers are authenticated', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: true,
      showVersionDetails: false,
      showBinaryPath: false,
      supportsSelfUpdate: false,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Authentication required',
          models: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
        {
          providerId: 'codex',
          displayName: 'Codex',
          supported: true,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Authentication required',
          models: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
        {
          providerId: 'gemini',
          displayName: 'Gemini',
          supported: true,
          authenticated: true,
          authMethod: 'cli_oauth_personal',
          verificationState: 'verified',
          statusMessage: 'Resolved to CLI SDK',
          models: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 0/2 connected');
    expect((host.firstElementChild as HTMLElement | null)?.getAttribute('style')).toContain(
      '245, 158, 11'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('collapses dashboard provider cards down to the header summary', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'oauth',
          verificationState: 'verified',
          statusMessage: 'Connected via Anthropic subscription',
          models: ['claude-sonnet-4-5'],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          connection: {
            supportsOAuth: true,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'oauth', 'api_key'],
            configuredAuthMode: 'oauth',
            apiKeyConfigured: false,
            apiKeySource: null,
            apiKeySourceLabel: null,
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 1/1 connected');
    expect(host.textContent).toContain('Anthropic');

    const collapseButton = host.querySelector(
      'button[aria-label="Collapse provider details"]'
    ) as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    await act(async () => {
      collapseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 1/1 connected');
    expect(host.textContent).not.toContain('Anthropic');
    expect(host.textContent).not.toContain('Manage');
    expect(
      host.querySelector('button[aria-label="Expand provider details"]')
    ).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('restores the collapsed dashboard provider banner after remount', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'codex',
          displayName: 'Codex',
          supported: true,
          authenticated: true,
          authMethod: 'chatgpt',
          verificationState: 'verified',
          statusMessage: 'ChatGPT account ready',
          models: ['gpt-5.4'],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'chatgpt',
            apiKeyConfigured: true,
            apiKeySource: 'environment',
            apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
            codex: {
              preferredAuthMode: 'chatgpt',
              effectiveAuthMode: 'chatgpt',
              appServerState: 'healthy',
              appServerStatusMessage: null,
              managedAccount: {
                type: 'chatgpt',
                email: 'user@example.com',
                planType: 'pro',
              },
              requiresOpenaiAuth: false,
              login: {
                status: 'idle',
                error: null,
                startedAt: null,
              },
              rateLimits: null,
              launchAllowed: true,
              launchIssueMessage: null,
              launchReadinessState: 'ready_chatgpt',
            },
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: 'chatgpt',
          },
        },
      ],
    });

    const firstHost = document.createElement('div');
    document.body.appendChild(firstHost);
    const firstRoot = createRoot(firstHost);

    await act(async () => {
      firstRoot.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    const collapseButton = firstHost.querySelector(
      'button[aria-label="Collapse provider details"]'
    ) as HTMLButtonElement | null;
    expect(collapseButton).not.toBeNull();

    await act(async () => {
      collapseButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    await act(async () => {
      firstRoot.unmount();
      await Promise.resolve();
    });

    const secondHost = document.createElement('div');
    document.body.appendChild(secondHost);
    const secondRoot = createRoot(secondHost);

    await act(async () => {
      secondRoot.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(secondHost.textContent).toContain('Providers: 1/1 connected');
    expect(secondHost.textContent).not.toContain('ChatGPT account ready');
    expect(
      secondHost.querySelector('button[aria-label="Expand provider details"]')
    ).not.toBeNull();

    await act(async () => {
      secondRoot.unmount();
      await Promise.resolve();
    });
  });

  it('shows a degraded runtime warning when a binary is found but the health check fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      installed: false,
      installedVersion: null,
      binaryPath: '/Users/tester/.claude/local/node_modules/.bin/claude',
      launchError: 'spawn EACCES',
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('failed to start');
    expect(host.textContent).toContain('Multimodel runtime was found but failed to start');
    expect(host.textContent).toContain('Re-check');
    expect(host.textContent).toContain(
      'The configured Multimodel runtime failed its startup health check.'
    );
    expect(host.textContent).not.toContain('Reinstall Claude CLI');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps installed controls visible in settings and wires the Extensions button correctly', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: true,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Installed v2.1.100');
    expect(host.textContent).toContain('Multimodel');
    expect(host.textContent).toContain('Extensions');

    const extensionsButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Extensions')
    );
    expect(extensionsButton).not.toBeNull();

    await act(async () => {
      extensionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.openExtensionsTab).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses provider-first bootstrap when settings re-check runs in multimodel mode', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: true,
      showVersionDetails: false,
      installed: false,
      authLoggedIn: false,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    const refreshButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Re-check')
    );
    expect(refreshButton).not.toBeNull();

    await act(async () => {
      refreshButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.bootstrapCliStatus).toHaveBeenCalledWith({ multimodelEnabled: true });
    expect(storeState.fetchCliStatus).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves settings runtime backend refresh errors for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.fetchCliProviderStatus = vi.fn(() => Promise.reject(new Error('refresh failed')));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    const onSelectBackend = providerRuntimeSettingsDialogProps?.onSelectBackend;
    expect(onSelectBackend).toBeTypeOf('function');

    await expect(onSelectBackend?.('codex', 'api')).rejects.toThrow(
      'Runtime updated, but failed to refresh provider status.'
    );
    expect(storeState.updateConfig).toHaveBeenCalledWith('runtime', {
      providerBackends: {
        codex: 'api',
      },
    });
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the settings Extensions button visible when the runtime is installed but not authenticated yet', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    const extensionsButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Extensions')
    );
    expect(extensionsButton).not.toBeNull();

    await act(async () => {
      extensionsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.openExtensionsTab).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('routes API-key misconfiguration to provider settings instead of login', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
      providers: [createApiKeyMisconfiguredProvider('anthropic')],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('API key required');
    expect(host.textContent).toContain('Manage Providers');
    expect(host.textContent).not.toContain('Already logged in?');
    expect(host.textContent).not.toContain('Login');

    const manageButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Manage Providers')
    );
    expect(manageButton).not.toBeUndefined();

    await act(async () => {
      manageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const dialog = host.querySelector('[data-testid="provider-runtime-settings-dialog"]');
    expect(dialog?.getAttribute('data-open')).toBe('true');
    expect(dialog?.getAttribute('data-provider')).toBe('anthropic');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps API-key mode issues on provider settings even when a saved key exists', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
      providers: [createApiKeyModeProviderIssue('anthropic')],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Provider action required');
    expect(host.textContent).toContain('Manage Providers');
    expect(host.textContent).not.toContain('Already logged in?');
    expect(host.textContent).not.toContain('Login');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows runtime model availability badges on the dashboard without hiding native Codex models', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'codex',
          displayName: 'Codex',
          supported: true,
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          modelVerificationState: 'verified',
          statusMessage: null,
          models: ['gpt-5.4', 'gpt-5.1-codex-max', 'gpt-5.2-codex'],
          modelAvailability: [
            { modelId: 'gpt-5.4', status: 'available', checkedAt: '2026-04-16T12:00:00.000Z' },
            {
              modelId: 'gpt-5.1-codex-max',
              status: 'unavailable',
              reason: 'The requested model is not available for your account.',
              checkedAt: '2026-04-16T12:00:00.000Z',
            },
            {
              modelId: 'gpt-5.2-codex',
              status: 'unavailable',
              reason: 'The requested model is not available for your account.',
              checkedAt: '2026-04-16T12:00:00.000Z',
            },
          ],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('5.4');
    expect(host.textContent).toContain('5.1-codex-max');
    expect(host.textContent).not.toContain('5.2-codex');
    expect(host.textContent).toContain('Unavailable');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps dashboard codex-native truth explicit for ready native lanes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        createCodexNativeRolloutProvider({
          state: 'ready',
          available: true,
          selectable: true,
          audience: 'general',
          statusMessage: 'Ready',
          detailMessage: 'Codex native runtime is ready through the local codex exec seam.',
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Ready');
    expect(host.textContent).toContain('Current runtime: Codex native');
    expect(host.textContent).not.toContain('Connected via API key');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows remaining Codex subscription limits on the dashboard card when ChatGPT mode is active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
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
      rateLimits: {
        limitId: 'plan-pro',
        limitName: 'Pro',
        primary: {
          usedPercent: 5,
          windowDurationMins: 300,
          resetsAt: 1_762_547_200,
        },
        secondary: {
          usedPercent: 41,
          windowDurationMins: 10_080,
          resetsAt: 1_762_891_200,
        },
        credits: {
          hasCredits: false,
          unlimited: false,
          balance: null,
        },
        planType: 'pro',
      },
      updatedAt: new Date().toISOString(),
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'auto',
            apiKeyConfigured: true,
            apiKeySource: 'environment',
            apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
            codex: {
              preferredAuthMode: 'auto',
              effectiveAuthMode: null,
              appServerState: 'healthy',
              appServerStatusMessage: null,
              managedAccount: null,
              requiresOpenaiAuth: false,
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
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: null,
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 1/1 connected');
    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).not.toContain('Connect a ChatGPT account to use your Codex subscription.');
    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('1w left');
    expect(host.textContent).toContain('59%');
    expect(host.textContent).toContain('resets');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the live Codex account snapshot in the settings runtime section too', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
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
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'auto',
            apiKeyConfigured: true,
            apiKeySource: 'environment',
            apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
            codex: {
              preferredAuthMode: 'auto',
              effectiveAuthMode: null,
              appServerState: 'healthy',
              appServerStatusMessage: null,
              managedAccount: null,
              requiresOpenaiAuth: false,
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
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: null,
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).not.toContain('Connect a ChatGPT account to use your Codex subscription.');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('applies the live Codex snapshot even while the dashboard is still on multimodel loading placeholder state', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = null;
    storeState.cliStatusLoading = true;
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
      rateLimits: {
        limitId: 'plan-pro',
        limitName: 'Pro',
        primary: {
          usedPercent: 5,
          windowDurationMins: 300,
          resetsAt: 1_762_547_200,
        },
        secondary: {
          usedPercent: 41,
          windowDurationMins: 10_080,
          resetsAt: 1_762_891_200,
        },
        credits: {
          hasCredits: false,
          unlimited: false,
          balance: null,
        },
        planType: 'pro',
      },
      updatedAt: new Date().toISOString(),
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 1/3 connected');
    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('1w left');
    expect(host.textContent).toContain('resets');
    expect(host.textContent).not.toContain('status will be checked in the background');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps Codex on checking while the dashboard bootstrap is still on placeholder state and the live snapshot is only a negative auth result', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = null;
    storeState.cliStatusLoading = true;
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

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain(
      'Codex has a locally selected ChatGPT account, but the current session needs reconnect.'
    );
    expect(host.textContent).not.toContain(
      'Usage limits appear only after Codex refreshes the currently selected ChatGPT session.'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('explains missing Codex limits when ChatGPT mode is selected but Codex is not logged in', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
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
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Connect a ChatGPT account to use your Codex subscription.',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
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
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: null,
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex CLI reports no active ChatGPT login');
    expect(host.textContent).toContain('Selected auth: ChatGPT account');
    expect(host.textContent).toContain(
      'Detected from OPENAI_API_KEY - available if you switch to API key mode'
    );
    expect(host.textContent).toContain(
      'Usage limits appear only after Codex CLI sees an active ChatGPT account. Right now it reports no active ChatGPT login. API key fallback is available if you switch auth mode.'
    );
    expect(host.textContent).not.toContain('5h left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('explains reconnect when a local selected ChatGPT account exists but the current session is stale', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
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
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
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
              launchIssueMessage: 'Reconnect ChatGPT to refresh the current Codex subscription session.',
              launchReadinessState: 'missing_auth',
            },
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: null,
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Codex has a locally selected ChatGPT account, but the current session needs reconnect.'
    );
    expect(host.textContent).toContain(
      'Usage limits appear only after Codex refreshes the currently selected ChatGPT session. Right now the local session needs reconnect. API key fallback is available if you switch auth mode.'
    );
    const reconnectButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Reconnect ChatGPT'
    );
    expect(reconnectButton).toBeTruthy();

    await act(async () => {
      reconnectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(codexAccountHookState.startChatgptLogin).toHaveBeenCalledTimes(1);
    expect(host.textContent).not.toContain('5h left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('explains when Auto is using an API key while ChatGPT usage limits are still unavailable', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    codexAccountHookState.snapshot = {
      preferredAuthMode: 'auto',
      effectiveAuthMode: 'api_key',
      launchAllowed: true,
      launchIssueMessage: null,
      launchReadinessState: 'ready_api_key',
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
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          statusMessage: 'API key ready',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'auto',
            apiKeyConfigured: true,
            apiKeySource: 'environment',
            apiKeySourceLabel: 'Detected from OPENAI_API_KEY',
            codex: {
              preferredAuthMode: 'auto',
              effectiveAuthMode: 'api_key',
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
              launchAllowed: true,
              launchIssueMessage: null,
              launchReadinessState: 'ready_api_key',
            },
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: 'api_key',
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'Detected from OPENAI_API_KEY - Auto will use this until ChatGPT is connected'
    );
    expect(host.textContent).toContain(
      'Usage limits appear only after Codex CLI sees an active ChatGPT account. Right now it reports no active ChatGPT login. Auto will keep using the API key until ChatGPT is connected.'
    );
    expect(host.textContent).not.toContain('5h left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not spin the provider refresh control during a global CLI refresh once the provider card is already rendered', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatusLoading = true;
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: true,
          authMethod: 'api_key',
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'api_key',
            apiKeyConfigured: true,
            apiKeySource: 'stored',
            apiKeySourceLabel: 'Stored in app',
            codex: {
              preferredAuthMode: 'api_key',
              effectiveAuthMode: 'api_key',
              appServerState: 'healthy',
              appServerStatusMessage: null,
              managedAccount: null,
              requiresOpenaiAuth: false,
              login: {
                status: 'idle',
                error: null,
                startedAt: null,
              },
              rateLimits: null,
              launchAllowed: true,
              launchIssueMessage: null,
              launchReadinessState: 'ready_api_key',
            },
          },
          backend: {
            kind: 'codex-native',
            label: 'Codex native',
            endpointLabel: 'codex exec --json',
            authMethodDetail: 'api_key',
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    const refreshButton = host.querySelector('[title="Re-check Codex"]');
    expect(refreshButton).not.toBeNull();
    const refreshIcon = refreshButton?.querySelector('svg');
    expect(refreshIcon?.getAttribute('class')).not.toContain('animate-spin');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps settings codex-native rollout truth explicit for runtime-missing lanes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'agent_teams_orchestrator',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          state: 'runtime-missing',
          available: false,
          selectable: false,
          statusMessage: 'Codex CLI not found',
          detailMessage: 'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
          backend: null,
          resolvedBackendId: null,
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex CLI not found');
    expect(host.textContent).toContain('Selected runtime: Codex native');
    expect(host.textContent).not.toContain('Connected via API key');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
