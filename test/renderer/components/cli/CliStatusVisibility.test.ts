import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { CLI_PROVIDER_STATUS_DEFERRED_MESSAGE } from '@shared/types/cliInstaller';
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
  openCodeRuntimeStatus: Record<string, unknown> | null;
  openCodeRuntimeStatusLoading: boolean;
  openCodeRuntimeError: string | null;
  codexRuntimeStatus: Record<string, unknown> | null;
  codexRuntimeStatusLoading: boolean;
  codexRuntimeError: string | null;
  bootstrapCliStatus: ReturnType<typeof vi.fn>;
  fetchCliStatus: ReturnType<typeof vi.fn>;
  fetchCliProviderStatus: ReturnType<typeof vi.fn>;
  invalidateCliStatus: ReturnType<typeof vi.fn>;
  installCli: ReturnType<typeof vi.fn>;
  fetchOpenCodeRuntimeStatus: ReturnType<typeof vi.fn>;
  installOpenCodeRuntime: ReturnType<typeof vi.fn>;
  invalidateOpenCodeRuntimeStatus: ReturnType<typeof vi.fn>;
  fetchCodexRuntimeStatus: ReturnType<typeof vi.fn>;
  installCodexRuntime: ReturnType<typeof vi.fn>;
  invalidateCodexRuntimeStatus: ReturnType<typeof vi.fn>;
  appConfig: {
    general: {
      multimodelEnabled: boolean;
    };
    providerConnections?: {
      anthropic: {
        authMode: 'auto' | 'oauth' | 'api_key';
        fastModeDefault: boolean;
      };
      codex: {
        preferredAuthMode: 'auto' | 'chatgpt' | 'api_key';
      };
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
  initialRuntimeProviderId?: string | null;
  initialRuntimeProviderAction?: 'connect' | 'select' | null;
} | null = null;
let runtimeProviderOnboardingDialogProps: {
  mode?: 'provider' | 'wizard';
  providerId?: string | null;
  onAdvancedSettings?: () => void;
} | null = null;
let terminalModalProps: {
  onClose?: () => void;
  onExit?: (exitCode: number) => void;
} | null = null;
let quickConnectConnectedCount = 0;
const codexAccountHookState = {
  snapshot: null as CodexAccountSnapshotDto | null,
  loading: false,
  rateLimitsLoading: false,
  error: null as string | null,
  refresh: vi.fn(() => Promise.resolve(true)),
  startChatgptLogin: vi.fn(() => Promise.resolve(true)),
  cancelChatgptLogin: vi.fn(() => Promise.resolve(true)),
  logout: vi.fn(() => Promise.resolve(true)),
};

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(() => Promise.resolve({ success: true })),
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

vi.mock('@features/runtime-provider-management/renderer', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@features/runtime-provider-management/renderer')>();
  return {
    ...actual,
    RuntimeProviderQuickConnect: (props: {
      onOpenCodeProviderAction?: (providerId: string, action: 'connect' | 'select') => void;
      onConnectedCountChange?: (count: number) => void;
    }) => {
      React.useEffect(() => {
        props.onConnectedCountChange?.(quickConnectConnectedCount);
      }, [props.onConnectedCountChange]);

      return React.createElement(
        'div',
        { 'data-testid': 'runtime-provider-quick-connect' },
        React.createElement(
          'button',
          {
            'data-testid': 'quick-connect-supergrok',
            onClick: () => props.onOpenCodeProviderAction?.('xai', 'connect'),
          },
          'Connect SuperGrok'
        ),
        React.createElement(
          'button',
          {
            'data-testid': 'manage-supergrok',
            onClick: () => props.onOpenCodeProviderAction?.('xai', 'select'),
          },
          'Configure SuperGrok'
        )
      );
    },
    RuntimeProviderOnboardingDialog: (props: {
      mode?: 'provider' | 'wizard';
      providerId?: string | null;
      onAdvancedSettings?: () => void;
    }) => {
      runtimeProviderOnboardingDialogProps = props;
      return React.createElement('div', {
        'data-testid': 'runtime-provider-onboarding-dialog',
        'data-mode': props.mode ?? '',
        'data-provider': props.providerId ?? '',
      });
    },
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
    initialRuntimeProviderId?: string | null;
    initialRuntimeProviderAction?: 'connect' | 'select' | null;
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
  const actual = await vi.importActual<
    typeof import('@renderer/components/runtime/ProviderRuntimeBackendSelector')
  >('@renderer/components/runtime/ProviderRuntimeBackendSelector');
  return {
    buildProviderRuntimeBackendSummaryText: actual.buildProviderRuntimeBackendSummaryText,
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
  TerminalModal: (props: { onClose?: () => void; onExit?: (exitCode: number) => void }) => {
    terminalModalProps = props;
    return React.createElement(
      'div',
      { 'data-testid': 'terminal-modal' },
      React.createElement(
        'button',
        { 'data-testid': 'terminal-exit', onClick: () => props.onExit?.(0) },
        'exit'
      ),
      React.createElement(
        'button',
        { 'data-testid': 'terminal-close', onClick: () => props.onClose?.() },
        'close'
      )
    );
  },
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
import { ProvisioningProviderRuntimeSettingsDialog } from '@renderer/components/team/dialogs/ProvisioningProviderRuntimeSettingsDialog';

async function flushLazyImports(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 0);
  });
}

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
      configurableAuthModes: providerId === 'anthropic' ? ['auto', 'oauth', 'api_key'] : [],
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
      overrides?.detailMessage ??
      'Codex native runtime is ready through the local codex exec seam.',
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
          overrides?.detailMessage ??
          'Codex native runtime is ready through the local codex exec seam.',
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

function createDeferredMultimodelProvider(
  providerId: 'anthropic' | 'codex' | 'opencode',
  displayName: string
): Record<string, unknown> {
  return {
    providerId,
    displayName,
    supported: false,
    authenticated: false,
    authMethod: null,
    verificationState: 'unknown',
    statusMessage: CLI_PROVIDER_STATUS_DEFERRED_MESSAGE,
    models: [],
    modelAvailability: [],
    canLoginFromUi: providerId !== 'opencode',
    capabilities: {
      teamLaunch: false,
      oneShot: false,
    },
    backend: null,
    availableBackends: [],
  };
}

describe('CLI status visibility during completed install state', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  beforeEach(() => {
    providerRuntimeSettingsDialogProps = null;
    runtimeProviderOnboardingDialogProps = null;
    terminalModalProps = null;
    quickConnectConnectedCount = 0;
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.rateLimitsLoading = false;
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
    storeState.openCodeRuntimeStatus = null;
    storeState.openCodeRuntimeStatusLoading = false;
    storeState.openCodeRuntimeError = null;
    storeState.codexRuntimeStatus = null;
    storeState.codexRuntimeStatusLoading = false;
    storeState.codexRuntimeError = null;
    storeState.bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCliProviderStatus = vi.fn().mockResolvedValue(true);
    storeState.invalidateCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.installCli = vi.fn();
    storeState.fetchOpenCodeRuntimeStatus = vi.fn().mockResolvedValue(undefined);
    storeState.installOpenCodeRuntime = vi.fn().mockResolvedValue(undefined);
    storeState.invalidateOpenCodeRuntimeStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCodexRuntimeStatus = vi.fn().mockResolvedValue(undefined);
    storeState.installCodexRuntime = vi.fn().mockResolvedValue(undefined);
    storeState.invalidateCodexRuntimeStatus = vi.fn().mockResolvedValue(undefined);
    storeState.appConfig = {
      general: {
        multimodelEnabled: true,
      },
      providerConnections: {
        anthropic: {
          authMode: 'auto',
          fastModeDefault: false,
        },
        codex: {
          preferredAuthMode: 'auto',
        },
      },
      runtime: {
        providerBackends: {},
      },
    };
    storeState.updateConfig = vi.fn().mockResolvedValue(undefined);
    storeState.openExtensionsTab = vi.fn();
    window.localStorage.clear();
  });

  it('opens focused provider onboarding without exposing the removed multi-plan shortcut', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.openCodeRuntimeStatus = {
      installed: true,
      source: 'app-managed',
      state: 'ready',
      version: '1.17.18',
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'managed',
          verificationState: 'verified',
          statusMessage: null,
          models: ['xai/grok-4.3'],
          canLoginFromUi: false,
          capabilities: { teamLaunch: true, oneShot: true },
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

    expect(host.querySelector('[data-testid="quick-connect-all-plans"]')).toBeNull();
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="quick-connect-supergrok"]')?.click();
      await Promise.resolve();
    });
    expect(runtimeProviderOnboardingDialogProps?.mode).toBe('provider');
    expect(runtimeProviderOnboardingDialogProps?.providerId).toBe('xai');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens connected OpenCode providers in settings without restarting onboarding', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.openCodeRuntimeStatus = {
      installed: true,
      source: 'app-managed',
      state: 'ready',
      version: '1.17.18',
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode',
          supported: true,
          authenticated: true,
          authMethod: 'managed',
          verificationState: 'verified',
          statusMessage: null,
          models: ['xai/grok-4.3'],
          canLoginFromUi: false,
          capabilities: { teamLaunch: true, oneShot: true },
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
    await act(async () => {
      host.querySelector<HTMLButtonElement>('[data-testid="manage-supergrok"]')?.click();
      await Promise.resolve();
    });

    expect(runtimeProviderOnboardingDialogProps).toBeNull();
    expect(providerRuntimeSettingsDialogProps).toMatchObject({
      initialProviderId: 'opencode',
      initialRuntimeProviderId: 'xai',
      initialRuntimeProviderAction: 'select',
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not expose the legacy runtime toggle or multimodel banner label', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('Multimodel');
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

  it('keeps the dashboard terminal modal unmounted until login is requested', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await flushLazyImports();
    });

    expect(host.querySelector('[data-testid="terminal-modal"]')).toBeNull();

    const loginButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Login'
    );
    expect(loginButton).not.toBeUndefined();

    await act(async () => {
      loginButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushLazyImports();
    });

    expect(host.querySelector('[data-testid="terminal-modal"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await flushLazyImports();
    });
  });

  it('waits until the runtime login modal closes before refreshing auth status', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliStatus = createInstalledCliStatus({
      authLoggedIn: false,
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await flushLazyImports();
    });

    const loginButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Login'
    );

    await act(async () => {
      loginButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushLazyImports();
    });

    expect(host.querySelector('[data-testid="terminal-modal"]')).not.toBeNull();
    expect(terminalModalProps?.onExit).toBeUndefined();

    storeState.invalidateCliStatus.mockClear();
    storeState.bootstrapCliStatus.mockClear();

    await act(async () => {
      terminalModalProps?.onClose?.();
      await flushLazyImports();
    });

    expect(storeState.invalidateCliStatus).toHaveBeenCalledTimes(1);
    expect(storeState.bootstrapCliStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flushLazyImports();
    });
  });

  it('loads the installer terminal log only while installation is active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'installing';
    storeState.cliInstallerRawChunks = ['installing...\n'];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await flushLazyImports();
    });

    expect(host.textContent).toContain('terminal-log');

    await act(async () => {
      root.unmount();
      await flushLazyImports();
    });
  });

  it('shows deferred multimodel provider snapshots as pending instead of disconnected', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      authStatusChecking: true,
      providers: [
        createDeferredMultimodelProvider('anthropic', 'Anthropic'),
        createDeferredMultimodelProvider('codex', 'Codex'),
        createDeferredMultimodelProvider('opencode', 'OpenCode'),
      ],
    });
    storeState.cliProviderStatusLoading = {
      anthropic: true,
      codex: true,
      opencode: true,
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking providers...');
    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain('Providers: 0 connected');
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders Anthropic legacy fallback status as connected with model badges', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      authStatusChecking: false,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'claude.ai',
          verificationState: 'verified',
          statusMessage: null,
          models: ['opus', 'opus[1m]'],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          backend: null,
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: null,
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

    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Connected via');
    expect(host.textContent).toContain('Opus');
    expect(host.textContent).not.toContain('Provider status unavailable');
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders OpenCode inventory fallback with model badges instead of unavailable text', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    quickConnectConnectedCount = 7;
    storeState.cliInstallerState = 'idle';
    storeState.openCodeRuntimeStatus = {
      installed: true,
      source: 'path',
      state: 'ready',
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      authStatusChecking: false,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          statusMessage: null,
          models: ['claude-haiku-4-5'],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          backend: null,
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: null,
        },
        createCodexNativeRolloutProvider({
          state: 'ready',
          statusMessage: 'ChatGPT account ready',
          models: ['gpt-5.4'],
        }),
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'unknown',
          statusMessage: null,
          models: ['opencode/big-pickle'],
          modelAvailability: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
          },
          backend: null,
          availableBackends: [],
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: null,
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

    expect(host.textContent).toContain('OpenCode');
    expect(host.textContent).toContain('Ready to run agents');
    expect(host.textContent).toContain('Providers: 10 connected');
    expect(host.textContent).toContain('Models available');
    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).not.toContain('Checking...');
    expect(host.textContent).not.toContain('Provider status unavailable');
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps connected provider details visible while a refresh is in flight', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      authStatusChecking: true,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'oauth',
          verificationState: 'verified',
          statusMessage: 'Connected via Anthropic subscription',
          models: ['claude-3-5-sonnet'],
          modelAvailability: [],
          canLoginFromUi: true,
          capabilities: {
            teamLaunch: true,
            oneShot: true,
          },
          backend: null,
        },
        createCodexNativeRolloutProvider({
          state: 'ready',
          statusMessage: 'ChatGPT account ready',
          models: ['gpt-5-codex'],
        }),
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          models: [],
          modelAvailability: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'runtime',
            },
          },
        },
      ],
    });
    storeState.cliProviderStatusLoading = {
      codex: true,
      opencode: true,
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 3 connected');
    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).toContain('Loading models...');
    expect(host.textContent).not.toContain('Checking...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows an OpenCode install action on the dashboard when the OpenCode CLI is missing', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          statusMessage: 'OpenCode CLI is not installed.',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
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

    expect(host.textContent).toContain('OpenCode (200+ models)');
    expect(host.textContent).toContain('Install');

    const installButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Install'
    );
    expect(installButton).not.toBeUndefined();

    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installOpenCodeRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('offers an OpenCode update when the installed runtime predates provider OAuth support', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.openCodeRuntimeStatus = {
      installed: true,
      source: 'app-managed',
      state: 'ready',
      version: '1.15.6',
    };
    storeState.cliStatus = createInstalledCliStatus({
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'managed',
          verificationState: 'verified',
          statusMessage: 'Connected via opencode managed',
          models: [],
          canLoginFromUi: false,
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

    const updateButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Update'
    );
    expect(updateButton).not.toBeUndefined();

    await act(async () => {
      updateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installOpenCodeRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows a Codex install action on the dashboard when the Codex native runtime is missing', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.codexRuntimeStatus = {
      installed: false,
      source: 'missing',
      state: 'idle',
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        createCodexNativeRolloutProvider({
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          state: 'runtime-missing',
          available: false,
          selectable: false,
          statusMessage: 'Codex CLI not found. Install Codex to use native account management.',
          detailMessage: 'Codex native runtime is missing.',
          models: [],
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

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Install');

    const installButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Install'
    );
    expect(installButton).not.toBeUndefined();

    await act(async () => {
      installButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installCodexRuntime).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]');
    const dialogInstallButton = Array.from(dialog?.querySelectorAll('button') ?? []).find(
      (button) => button.textContent?.trim() === 'Install'
    );
    await act(async () => {
      dialogInstallButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installCodexRuntime).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('opens the shared Codex update dialog for an installed stale runtime', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.codexRuntimeStatus = {
      installed: true,
      binaryPath: '/usr/local/bin/codex',
      version: 'codex-cli 0.139.0',
      latestVersion: '0.144.1',
      updateAvailable: true,
      source: 'path',
      state: 'ready',
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [createCodexNativeRolloutProvider({ state: 'ready', available: true })],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    const dashboardUpdateButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Update to v0.144.1')
    );
    expect(dashboardUpdateButton).toBeDefined();

    await act(async () => {
      dashboardUpdateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installCodexRuntime).not.toHaveBeenCalled();
    const dialog = document.body.querySelector('[role="dialog"]');
    expect(dialog?.textContent).toContain('v0.139.0 -> v0.144.1');
    const dialogUpdateButton = Array.from(dialog?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Update to v0.144.1')
    );

    await act(async () => {
      dialogUpdateButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(storeState.installCodexRuntime).toHaveBeenCalledTimes(1);
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows OpenCode app-managed install progress on the dashboard provider card', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.openCodeRuntimeStatus = {
      installed: false,
      source: 'missing',
      state: 'downloading',
      progress: {
        phase: 'downloading',
        downloadedBytes: 42,
        totalBytes: 100,
        percent: 42,
        detail: 'Downloading OpenCode 42%',
      },
    };
    storeState.openCodeRuntimeStatusLoading = true;
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: false,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: false,
          authenticated: false,
          authMethod: null,
          verificationState: 'error',
          statusMessage: 'OpenCode CLI is not installed.',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: false,
            oneShot: false,
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

    expect(host.textContent).toContain('Downloading 42%');
    const progressButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Downloading 42%'
    );
    expect(progressButton).not.toBeUndefined();
    expect(progressButton).toHaveProperty('disabled', true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not show OpenCode retry install when the provider is effectively ready', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.openCodeRuntimeStatus = {
      installed: false,
      source: 'app-managed',
      state: 'failed',
      error: 'app-managed OpenCode install failed earlier',
    };
    storeState.openCodeRuntimeStatusLoading = false;
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: 'Ready',
          models: ['opencode/big-pickle'],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: null,
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

    expect(host.textContent).toContain('Connected via opencode managed');
    expect(host.textContent).not.toContain('Retry install');
    const retryButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Retry install'
    );
    expect(retryButton).toBeUndefined();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('always shows a provider-level Free models badge on the OpenCode dashboard card', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: 'Ready',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: null,
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

    const providerFreeBadge = host.querySelector('[title*="Big Pickle"]');
    expect(providerFreeBadge?.textContent).toBe('Free models');
    expect(providerFreeBadge?.getAttribute('title')).toContain('OpenRouter');
    expect(providerFreeBadge?.getAttribute('title')).toContain(
      'not every OpenCode/OpenRouter model is free'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows compact OpenCode configured-local and verified counts on the dashboard card', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_configured_local',
          verificationState: 'verified',
          statusMessage: null,
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
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
                supportsPersonality: true,
                isDefault: true,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
                metadata: {
                  opencode: {
                    providerId: 'llama.cpp',
                    modelId: 'qwen-test:0.5b',
                    sourceLabel: 'llama.cpp',
                    accessKind: 'verified',
                    routeKind: 'configured_local',
                    proofState: 'verified',
                    requiresExecutionProof: false,
                    reason: null,
                  },
                },
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
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

    expect(host.textContent).toContain('Free models');
    expect(host.textContent).toContain('1 configured local');
    expect(host.textContent).toContain('1 verified');
    expect(host.textContent).not.toContain('qwen-test:0.5b qwen-test:0.5b');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows OpenCode model loading instead of the summary-only big-pickle badge', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: null,
          models: ['opencode/big-pickle'],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: null,
          modelCatalogRefreshState: 'idle',
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
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

    expect(host.textContent).toContain('Loading models...');
    expect(host.textContent).not.toContain('big-pickle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows OpenCode catalog models on the dashboard when provider models are empty', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: 'Ready',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
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
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
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

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows OpenCode catalog models in settings when provider models are empty', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [
        {
          providerId: 'opencode',
          displayName: 'OpenCode (200+ models)',
          supported: true,
          authenticated: true,
          authMethod: 'opencode_managed',
          verificationState: 'verified',
          statusMessage: 'Ready',
          models: [],
          canLoginFromUi: false,
          capabilities: {
            teamLaunch: true,
            oneShot: false,
          },
          backend: { kind: 'opencode-cli', label: 'OpenCode CLI' },
          modelCatalog: {
            schemaVersion: 1,
            providerId: 'opencode',
            source: 'app-server',
            status: 'ready',
            fetchedAt: '2026-05-12T00:00:00.000Z',
            staleAt: '2026-05-12T00:10:00.000Z',
            defaultModelId: 'opencode/big-pickle',
            defaultLaunchModel: 'opencode/big-pickle',
            models: [
              {
                id: 'opencode/big-pickle',
                launchModel: 'opencode/big-pickle',
                displayName: 'opencode/big-pickle',
                hidden: false,
                supportedReasoningEfforts: [],
                defaultReasoningEffort: null,
                inputModalities: ['text'],
                supportsPersonality: true,
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
                supportsPersonality: true,
                isDefault: false,
                upgrade: false,
                source: 'app-server',
                badgeLabel: null,
              },
            ],
            diagnostics: {
              configReadState: 'ready',
              appServerState: 'healthy',
            },
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusSection));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('big-pickle');
    expect(host.textContent).toContain('GPT-5.4');
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves dashboard runtime backend refresh errors for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.fetchCliProviderStatus = vi.fn(() => Promise.resolve(false));
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      displayName: 'Multimodel runtime',
      supportsSelfUpdate: false,
      showVersionDetails: false,
      showBinaryPath: false,
      authLoggedIn: true,
      providers: [createCodexNativeRolloutProvider()],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(providerRuntimeSettingsDialogProps).toBeNull();

    const manageButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Manage'
    );
    expect(manageButton).not.toBeUndefined();

    await act(async () => {
      manageButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
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
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex', {
      checkReason: 'manual_refresh',
    });

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

  it('waits until the provider login modal closes before refreshing provider auth status', async () => {
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
          verificationState: 'verified',
          statusMessage: 'Not connected',
          models: [],
          canLoginFromUi: true,
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
      await flushLazyImports();
    });

    const connectButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Connect Anthropic')
    );
    expect(connectButton).not.toBeUndefined();

    await act(async () => {
      connectButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushLazyImports();
    });

    expect(host.querySelector('[data-testid="terminal-modal"]')).not.toBeNull();
    expect(terminalModalProps?.onExit).toBeUndefined();

    storeState.invalidateCliStatus.mockClear();
    storeState.bootstrapCliStatus.mockClear();

    await act(async () => {
      terminalModalProps?.onClose?.();
      await flushLazyImports();
    });

    expect(storeState.invalidateCliStatus).toHaveBeenCalledTimes(1);
    expect(storeState.bootstrapCliStatus).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flushLazyImports();
    });
  });

  it('shows subscription limit placeholders while an Anthropic subscription provider is checking', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.appConfig.providerConnections = {
      anthropic: {
        authMode: 'oauth',
        fastModeDefault: false,
      },
      codex: {
        preferredAuthMode: 'auto',
      },
    };
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

    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('Weekly left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides subscription limit placeholders while an Anthropic API key provider is checking', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.appConfig.providerConnections = {
      anthropic: {
        authMode: 'api_key',
        fastModeDefault: false,
      },
      codex: {
        preferredAuthMode: 'auto',
      },
    };
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

    expect(host.textContent).not.toContain('5h left');
    expect(host.textContent).not.toContain('Weekly left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('periodically refreshes Anthropic subscription limits while subscription mode is active', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.appConfig.providerConnections = {
      anthropic: {
        authMode: 'oauth',
        fastModeDefault: false,
      },
      codex: {
        preferredAuthMode: 'auto',
      },
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: true,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'claude.ai',
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

    try {
      await act(async () => {
        root.render(React.createElement(CliStatusBanner));
        await Promise.resolve();
      });

      expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('anthropic', {
        silent: true,
      });
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      vi.useRealTimers();
    }
  });

  it('does not periodically refresh Anthropic limits while API key mode is active', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.appConfig.providerConnections = {
      anthropic: {
        authMode: 'api_key',
        fastModeDefault: false,
      },
      codex: {
        preferredAuthMode: 'auto',
      },
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: true,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'api_key',
          verificationState: 'verified',
          statusMessage: 'Connected via API key',
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
            configuredAuthMode: 'api_key',
            apiKeyConfigured: true,
            apiKeySource: 'stored',
            apiKeySourceLabel: 'Stored Anthropic API key',
          },
        },
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    try {
      await act(async () => {
        root.render(React.createElement(CliStatusBanner));
        await Promise.resolve();
      });

      await act(async () => {
        vi.advanceTimersByTime(60_000);
        await Promise.resolve();
      });

      expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    } finally {
      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
      vi.useRealTimers();
    }
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
    expect(host.textContent).toContain('Connect a provider to get started');
    expect(host.firstElementChild?.classList.contains('border-l-4')).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows provider setup guidance when only hidden providers are authenticated', async () => {
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

    expect(host.textContent).toContain('Connect a provider to get started');
    expect(host.textContent).not.toContain('Ready to run agents');
    expect(host.firstElementChild?.classList.contains('border-l-4')).toBe(false);

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

    expect(host.textContent).toContain('Providers: 1 connected');
    expect(host.textContent).toContain('Anthropic');

    const collapseHeader = host.querySelector<HTMLElement>(
      '[role="button"][aria-label="Collapse provider details"]'
    );
    expect(collapseHeader).not.toBeNull();

    await act(async () => {
      collapseHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Providers: 1 connected');
    expect(host.textContent).not.toContain('Anthropic');
    expect(host.textContent).not.toContain('Manage');
    expect(
      host.querySelector('[role="button"][aria-label="Expand provider details"]')
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

    const collapseHeader = firstHost.querySelector<HTMLElement>(
      '[role="button"][aria-label="Collapse provider details"]'
    );
    expect(collapseHeader).not.toBeNull();

    await act(async () => {
      collapseHeader?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
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

    expect(secondHost.textContent).toContain('Providers: 1 connected');
    expect(secondHost.textContent).not.toContain('ChatGPT account ready');
    expect(
      secondHost.querySelector('[role="button"][aria-label="Expand provider details"]')
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
    storeState.fetchCliProviderStatus = vi.fn(() => Promise.resolve(false));

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
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex', {
      checkReason: 'manual_refresh',
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('preserves provisioning runtime backend refresh failures for the manage dialog', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.fetchCliProviderStatus = vi.fn(() => Promise.resolve(false));
    const onProviderRuntimeChanged = vi.fn();
    const providers = [createCodexNativeRolloutProvider()] as unknown as React.ComponentProps<
      typeof ProvisioningProviderRuntimeSettingsDialog
    >['providers'];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(ProvisioningProviderRuntimeSettingsDialog, {
          openProviderId: 'codex',
          onOpenProviderIdChange: vi.fn(),
          providers,
          onProviderRuntimeChanged,
        })
      );
      await Promise.resolve();
    });

    const onSelectBackend = providerRuntimeSettingsDialogProps?.onSelectBackend;
    expect(onSelectBackend).toBeTypeOf('function');
    await expect(onSelectBackend?.('codex', 'api')).rejects.toThrow(
      'Runtime updated, but failed to refresh provider status.'
    );
    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('codex', {
      silent: false,
      checkReason: 'launch_preflight',
    });
    expect(onProviderRuntimeChanged).not.toHaveBeenCalled();

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

    expect(host.textContent).toContain('Providers: 1 connected');
    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).not.toContain(
      'Connect a ChatGPT account to use your Codex subscription.'
    );
    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('Weekly left');
    expect(host.textContent).toContain('59%');
    expect(host.textContent).toContain('resets');

    const previousSnapshot = codexAccountHookState.snapshot;
    const previousRateLimits = previousSnapshot?.rateLimits;
    const previousPrimary = previousRateLimits?.primary;
    if (!previousSnapshot || !previousRateLimits || !previousPrimary) {
      throw new Error('Expected the Codex rate-limit fixture to be available');
    }

    codexAccountHookState.rateLimitsLoading = true;
    codexAccountHookState.snapshot = {
      ...previousSnapshot,
      rateLimits: null,
    };
    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('59%');
    expect(host.querySelectorAll('.skeleton-shimmer')).toHaveLength(0);

    codexAccountHookState.rateLimitsLoading = false;
    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('95%');
    expect(host.textContent).toContain('59%');
    expect(host.querySelectorAll('.dashboard-rate-limit-refreshed')).toHaveLength(0);

    codexAccountHookState.snapshot = {
      ...previousSnapshot,
      rateLimits: {
        ...previousRateLimits,
        primary: {
          usedPercent: 8,
          windowDurationMins: previousPrimary.windowDurationMins ?? null,
          resetsAt: previousPrimary.resetsAt ?? null,
        },
        secondary: previousRateLimits.secondary
          ? {
              usedPercent: 43,
              windowDurationMins: previousRateLimits.secondary.windowDurationMins ?? null,
              resetsAt: previousRateLimits.secondary.resetsAt ?? null,
            }
          : null,
      },
      updatedAt: new Date(Date.now() + 1_000).toISOString(),
    };
    await act(async () => {
      root.render(React.createElement(CliStatusBanner));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('92%');
    expect(host.textContent).toContain('57%');
    expect(host.querySelectorAll('.dashboard-rate-limit-refreshed')).toHaveLength(2);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows Codex limit placeholders while ChatGPT account limits are loading', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    codexAccountHookState.rateLimitsLoading = true;
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
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'chatgpt',
            apiKeyConfigured: false,
            apiKeySource: null,
            apiKeySourceLabel: null,
            codex: null,
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

    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('Weekly left');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('refreshes Claude Code and Codex subscription limits when the dashboard becomes active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.cliInstallerState = 'idle';
    storeState.appConfig.providerConnections = {
      anthropic: {
        authMode: 'oauth',
        fastModeDefault: false,
      },
      codex: {
        preferredAuthMode: 'chatgpt',
      },
    };
    storeState.cliStatus = createInstalledCliStatus({
      flavor: 'agent_teams_orchestrator',
      authLoggedIn: true,
      providers: [
        {
          providerId: 'anthropic',
          displayName: 'Anthropic',
          supported: true,
          authenticated: true,
          authMethod: 'claude.ai',
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
        createCodexNativeRolloutProvider({
          connection: {
            supportsOAuth: false,
            supportsApiKey: true,
            configurableAuthModes: ['auto', 'chatgpt', 'api_key'],
            configuredAuthMode: 'chatgpt',
            apiKeyConfigured: false,
            apiKeySource: null,
            apiKeySourceLabel: null,
            codex: null,
          },
        }),
      ],
    });

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(CliStatusBanner, { isDashboardActive: false }));
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).not.toHaveBeenCalled();
    expect(codexAccountHookState.refresh).not.toHaveBeenCalled();

    await act(async () => {
      root.render(React.createElement(CliStatusBanner, { isDashboardActive: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('anthropic', { silent: true });
    expect(codexAccountHookState.refresh).toHaveBeenCalledWith({
      includeRateLimits: true,
      silent: true,
    });

    storeState.fetchCliProviderStatus.mockClear();
    codexAccountHookState.refresh.mockClear();
    await act(async () => {
      root.render(React.createElement(CliStatusBanner, { isDashboardActive: false }));
      await Promise.resolve();
    });
    await act(async () => {
      root.render(React.createElement(CliStatusBanner, { isDashboardActive: true }));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.fetchCliProviderStatus).toHaveBeenCalledWith('anthropic', { silent: true });
    expect(codexAccountHookState.refresh).toHaveBeenCalledTimes(1);

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
    expect(host.textContent).not.toContain(
      'Connect a ChatGPT account to use your Codex subscription.'
    );

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

    expect(host.textContent).toContain('Providers: 1 connected');
    expect(host.textContent).toContain('5h left');
    expect(host.textContent).toContain('Weekly left');
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

  it('keeps Codex on checking while its model catalog is loading and the live snapshot is only a negative auth result', async () => {
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
          models: [],
          modelCatalog: null,
          modelCatalogRefreshState: 'loading',
          runtimeCapabilities: {
            modelCatalog: {
              dynamic: true,
              source: 'app-server',
            },
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

    expect(host.textContent).toContain('Checking...');
    expect(host.textContent).not.toContain(
      'Reconnect ChatGPT to refresh the current Codex subscription session.'
    );
    expect(host.textContent).not.toContain('Models unavailable for this runtime build');

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
              launchIssueMessage:
                'Reconnect ChatGPT to refresh the current Codex subscription session.',
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
      (button) => button.textContent?.trim() === 'Generate link'
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
          detailMessage:
            'Codex native runtime requires the codex CLI binary to be installed and discoverable.',
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
