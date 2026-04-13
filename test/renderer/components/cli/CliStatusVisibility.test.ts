import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@renderer/api', () => ({
  api: {
    showInFolder: vi.fn(),
  },
  isElectronMode: () => true,
}));

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

vi.mock('@renderer/components/runtime/ProviderRuntimeBackendSelector', () => ({
  getProviderRuntimeBackendSummary: () => null,
}));

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
        : 'Codex API key mode is enabled, but no OPENAI_API_KEY is configured.',
    models: [],
    canLoginFromUi: true,
    capabilities: {
      teamLaunch: true,
      oneShot: true,
    },
    connection: {
      supportsOAuth: true,
      supportsApiKey: true,
      configurableAuthModes: providerId === 'anthropic' ? ['auto', 'oauth', 'api_key'] : ['oauth', 'api_key'],
      configuredAuthMode: 'api_key',
      apiKeyBetaAvailable: providerId === 'codex' ? true : undefined,
      apiKeyBetaEnabled: providerId === 'codex' ? true : undefined,
      apiKeyConfigured: false,
      apiKeySource: null,
      apiKeySourceLabel: null,
    },
  };
}

function createApiKeyModeProviderIssue(
  providerId: 'anthropic' | 'codex'
): Record<string, unknown> {
  return {
    ...createApiKeyMisconfiguredProvider(providerId),
    statusMessage:
      providerId === 'anthropic'
        ? 'Anthropic API key was rejected by the runtime.'
        : 'OpenAI API key was rejected by the runtime.',
    connection: {
      ...((createApiKeyMisconfiguredProvider(providerId) as { connection: Record<string, unknown> })
        .connection),
      apiKeyConfigured: true,
      apiKeySource: 'stored',
      apiKeySourceLabel:
        providerId === 'anthropic' ? 'Stored Anthropic API key' : 'Stored OpenAI API key',
    },
  };
}

describe('CLI status visibility during completed install state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    providerRuntimeSettingsDialogProps = null;
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
  });

  it('keeps the Multimodel toggle visible and enabled on the dashboard while login is still required', async () => {
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
    expect(toggle).not.toBeNull();
    expect(toggle?.hasAttribute('disabled')).toBe(false);

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

  it('preserves dashboard runtime backend refresh errors for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.fetchCliProviderStatus = vi.fn(() =>
      Promise.reject(new Error('refresh failed'))
    );

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
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

  it('shows a degraded runtime warning when a binary is found but the health check fails', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
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
    expect(host.textContent).toContain('Reinstall Claude CLI');

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

  it('preserves settings runtime backend refresh errors for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.fetchCliProviderStatus = vi.fn(() =>
      Promise.reject(new Error('refresh failed'))
    );

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

  it('hides the settings Extensions button when the runtime is not authenticated yet', async () => {
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

    expect(host.textContent).not.toContain('Extensions');

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

    const manageButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Manage Providers')
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
});
