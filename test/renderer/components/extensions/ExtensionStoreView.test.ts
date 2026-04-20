import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CodexAccountSnapshotDto } from '@features/codex-account/contracts';
import type { CliInstallationStatus } from '@shared/types';

interface StoreState {
  fetchPluginCatalog: ReturnType<typeof vi.fn>;
  bootstrapCliStatus: ReturnType<typeof vi.fn>;
  fetchCliStatus: ReturnType<typeof vi.fn>;
  fetchApiKeys: ReturnType<typeof vi.fn>;
  fetchSkillsCatalog: ReturnType<typeof vi.fn>;
  mcpBrowse: ReturnType<typeof vi.fn>;
  mcpFetchInstalled: ReturnType<typeof vi.fn>;
  apiKeysLoading: boolean;
  pluginCatalogLoading: boolean;
  mcpBrowseLoading: boolean;
  skillsLoading: boolean;
  cliStatus: CliInstallationStatus | null;
  cliStatusLoading: boolean;
  cliProviderStatusLoading: Record<string, boolean>;
  appConfig: {
    general: {
      multimodelEnabled: boolean;
    };
  };
  openDashboard: ReturnType<typeof vi.fn>;
  sessions: { isOngoing: boolean }[];
  projects: unknown[];
  repositoryGroups: unknown[];
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
const pluginsPanelSpy = vi.fn();
const mcpServersPanelSpy = vi.fn();
const customMcpDialogSpy = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@renderer/api', () => ({
  api: {
    plugins: {},
    mcpRegistry: {},
    skills: {},
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

vi.mock('@renderer/contexts/useTabUIContext', () => ({
  useTabIdOptional: () => undefined,
}));

vi.mock('@renderer/hooks/useExtensionsTabState', () => ({
  useExtensionsTabState: () => ({
    activeSubTab: 'plugins',
    setActiveSubTab: vi.fn(),
    pluginFilters: {
      search: '',
      categories: [],
      capabilities: [],
      installedOnly: false,
    },
    pluginSort: { field: 'popularity', order: 'desc' },
    setPluginSort: vi.fn(),
    selectedPluginId: null,
    setSelectedPluginId: vi.fn(),
    updatePluginSearch: vi.fn(),
    toggleCategory: vi.fn(),
    toggleCapability: vi.fn(),
    toggleInstalledOnly: vi.fn(),
    clearFilters: vi.fn(),
    hasActiveFilters: false,
    mcpSearchQuery: '',
    mcpSearch: vi.fn(),
    mcpSearchResults: [],
    mcpSearchLoading: false,
    mcpSearchWarnings: [],
    selectedMcpServerId: null,
    setSelectedMcpServerId: vi.fn(),
    skillsSearchQuery: '',
    setSkillsSearchQuery: vi.fn(),
    skillsInstalledOnly: false,
    skillsSort: 'name-asc',
    setSkillsSort: vi.fn(),
    selectedSkillId: null,
    setSelectedSkillId: vi.fn(),
  }),
}));

vi.mock('@renderer/utils/projectLookup', () => ({
  resolveProjectPathById: () => null,
}));

vi.mock('@renderer/components/common/ProviderBrandLogo', () => ({
  ProviderBrandLogo: ({ providerId }: { providerId: string }) =>
    React.createElement('span', { 'data-testid': `provider-logo-${providerId}` }, providerId),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: React.PropsWithChildren<{ onClick?: () => void; disabled?: boolean }>) =>
    React.createElement(
      'button',
      {
        type: 'button',
        disabled,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/tabs', () => ({
  Tabs: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  TabsList: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  TabsContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  TooltipProvider: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/extensions/ExtensionsSubTabTrigger', () => ({
  ExtensionsSubTabTrigger: ({ label }: { label: string }) =>
    React.createElement('button', { type: 'button' }, label),
}));

vi.mock('@renderer/components/extensions/plugins/PluginsPanel', () => ({
  PluginsPanel: (props: unknown) => {
    pluginsPanelSpy(props);
    return React.createElement('div', null, 'plugins-panel');
  },
}));

vi.mock('@renderer/components/extensions/mcp/McpServersPanel', () => ({
  McpServersPanel: (props: unknown) => {
    mcpServersPanelSpy(props);
    return React.createElement('div', null, 'mcp-panel');
  },
}));

vi.mock('@renderer/components/extensions/skills/SkillsPanel', () => ({
  SkillsPanel: () => React.createElement('div', null, 'skills-panel'),
}));

vi.mock('@renderer/components/extensions/apikeys/ApiKeysPanel', () => ({
  ApiKeysPanel: () => React.createElement('div', null, 'apikeys-panel'),
}));

vi.mock('@renderer/components/extensions/mcp/CustomMcpServerDialog', () => ({
  CustomMcpServerDialog: (props: unknown) => {
    customMcpDialogSpy(props);
    return null;
  },
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    BookOpen: Icon,
    Info: Icon,
    Key: Icon,
    Loader2: Icon,
    Plus: Icon,
    Puzzle: Icon,
    RefreshCw: Icon,
    Server: Icon,
  };
});

import { ExtensionStoreView } from '@renderer/components/extensions/ExtensionStoreView';

function createLoadingMultimodelStatus(): CliInstallationStatus {
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
    authLoggedIn: false,
    authStatusChecking: true,
    authMethod: null,
    providers: [
      {
        providerId: 'anthropic',
        displayName: 'Anthropic',
        supported: false,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        modelVerificationState: 'idle',
        statusMessage: 'Checking...',
        models: [],
        modelAvailability: [],
        canLoginFromUi: true,
        capabilities: {
          teamLaunch: false,
          oneShot: false,
          extensions: {
            plugins: { status: 'supported', ownership: 'shared', reason: null },
            mcp: { status: 'supported', ownership: 'shared', reason: null },
            skills: { status: 'supported', ownership: 'shared', reason: null },
            apiKeys: { status: 'supported', ownership: 'shared', reason: null },
          },
        },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      },
      {
        providerId: 'codex',
        displayName: 'Codex',
        supported: false,
        authenticated: false,
        authMethod: null,
        verificationState: 'unknown',
        modelVerificationState: 'idle',
        statusMessage: 'Checking...',
        models: [],
        modelAvailability: [],
        canLoginFromUi: true,
        capabilities: {
          teamLaunch: false,
          oneShot: false,
          extensions: {
            plugins: { status: 'unsupported', ownership: 'provider-scoped', reason: null },
            mcp: { status: 'supported', ownership: 'shared', reason: null },
            skills: { status: 'supported', ownership: 'shared', reason: null },
            apiKeys: { status: 'supported', ownership: 'shared', reason: null },
          },
        },
        selectedBackendId: null,
        resolvedBackendId: null,
        availableBackends: [],
        externalRuntimeDiagnostics: [],
        backend: null,
        connection: null,
      },
    ],
  };
}

describe('ExtensionStoreView provider loading placeholders', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    pluginsPanelSpy.mockReset();
    mcpServersPanelSpy.mockReset();
    customMcpDialogSpy.mockReset();
    codexAccountHookState.snapshot = null;
    codexAccountHookState.loading = false;
    codexAccountHookState.error = null;
    codexAccountHookState.refresh.mockReset().mockResolvedValue(undefined);
    codexAccountHookState.startChatgptLogin.mockReset().mockResolvedValue(true);
    codexAccountHookState.cancelChatgptLogin.mockReset().mockResolvedValue(true);
    codexAccountHookState.logout.mockReset().mockResolvedValue(true);
    storeState.fetchPluginCatalog = vi.fn().mockResolvedValue(undefined);
    storeState.bootstrapCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchCliStatus = vi.fn().mockResolvedValue(undefined);
    storeState.fetchApiKeys = vi.fn().mockResolvedValue(undefined);
    storeState.fetchSkillsCatalog = vi.fn().mockResolvedValue(undefined);
    storeState.mcpBrowse = vi.fn().mockResolvedValue(undefined);
    storeState.mcpFetchInstalled = vi.fn().mockResolvedValue(undefined);
    storeState.apiKeysLoading = false;
    storeState.pluginCatalogLoading = false;
    storeState.mcpBrowseLoading = false;
    storeState.skillsLoading = false;
    storeState.cliStatus = createLoadingMultimodelStatus();
    storeState.cliStatusLoading = true;
    storeState.cliProviderStatusLoading = {
      anthropic: true,
      codex: true,
    };
    storeState.appConfig = {
      general: {
        multimodelEnabled: true,
      },
    };
    storeState.openDashboard = vi.fn();
    storeState.sessions = [];
    storeState.projects = [];
    storeState.repositoryGroups = [];
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows multimodel provider skeleton cards while provider status is still loading', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.bootstrapCliStatus).toHaveBeenCalledWith({ multimodelEnabled: true });
    expect(storeState.fetchCliStatus).not.toHaveBeenCalled();

    expect(host.textContent).toContain('Multimodel runtime capabilities');
    expect(host.textContent).toContain('Anthropic');
    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Checking provider status...');
    expect(host.textContent).toContain('Loading...');
    expect(host.textContent).not.toContain('Checking extensions runtime availability');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('falls back to legacy refresh when multimodel is disabled', async () => {
    storeState.appConfig = {
      general: {
        multimodelEnabled: false,
      },
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(storeState.fetchCliStatus).toHaveBeenCalledTimes(1);
    expect(storeState.bootstrapCliStatus).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps provider placeholders visible when bootstrap data still says Checking...', async () => {
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Checking provider status...');
    expect(host.textContent).toContain('Loading...');
    expect(host.textContent).not.toContain('Plugins: unsupported');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the live Codex account snapshot to replace stale extension-card status', async () => {
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};
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
    storeState.cliStatus = {
      ...createLoadingMultimodelStatus(),
      authLoggedIn: true,
      authStatusChecking: false,
      providers: [
        createLoadingMultimodelStatus().providers[1],
      ],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).not.toContain('Checking provider status...');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the live Codex snapshot even while multimodel root status is still loading', async () => {
    storeState.cliStatus = null;
    storeState.cliStatusLoading = true;
    storeState.cliProviderStatusLoading = {};
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
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('ChatGPT account ready');
    expect(host.textContent).not.toContain('Checking extensions runtime availability');
    expect(host.querySelector('button[disabled]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not leave the stale Codex placeholder stuck as unsupported once live snapshot truth arrives', async () => {
    storeState.cliStatusLoading = false;
    storeState.cliProviderStatusLoading = {};
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
    storeState.cliStatus = {
      ...createLoadingMultimodelStatus(),
      authLoggedIn: true,
      authStatusChecking: false,
      providers: [createLoadingMultimodelStatus().providers[1]],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Codex');
    expect(host.textContent).toContain('Needs setup');
    expect(host.textContent).not.toContain('Unsupported');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes merged effective Codex status to nested extension panels and dialogs', async () => {
    storeState.cliStatusLoading = true;
    storeState.cliProviderStatusLoading = {};
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
    storeState.cliStatus = {
      ...createLoadingMultimodelStatus(),
      authLoggedIn: true,
      authStatusChecking: false,
      providers: [createLoadingMultimodelStatus().providers[1]],
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(ExtensionStoreView));
      await Promise.resolve();
      await Promise.resolve();
    });

    const pluginsPanelProps = pluginsPanelSpy.mock.calls.at(-1)?.[0] as {
      cliStatus?: CliInstallationStatus | null;
      cliStatusLoading?: boolean;
    };
    const mcpPanelProps = mcpServersPanelSpy.mock.calls.at(-1)?.[0] as {
      cliStatus?: CliInstallationStatus | null;
      cliStatusLoading?: boolean;
    };
    const customDialogProps = customMcpDialogSpy.mock.calls.at(-1)?.[0] as {
      cliStatus?: CliInstallationStatus | null;
      cliStatusLoading?: boolean;
    };

    expect(pluginsPanelProps.cliStatusLoading).toBe(false);
    expect(mcpPanelProps.cliStatusLoading).toBe(false);
    expect(customDialogProps.cliStatusLoading).toBe(false);
    expect(pluginsPanelProps.cliStatus?.providers[0]?.supported).toBe(true);
    expect(pluginsPanelProps.cliStatus?.providers[0]?.statusMessage).toBe('ChatGPT account ready');
    expect(mcpPanelProps.cliStatus?.providers[0]?.resolvedBackendId).toBe('codex-native');
    expect(customDialogProps.cliStatus?.providers[0]?.connection?.codex?.managedAccount?.email).toBe(
      'user@example.com'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
