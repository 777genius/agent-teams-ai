import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { CliInstallationStatus } from '@shared/types';

type PluginsPanelCliStatus = Pick<
  CliInstallationStatus,
  'installed' | 'authLoggedIn' | 'binaryPath' | 'launchError' | 'flavor' | 'providers'
>;

interface StoreState {
  pluginCatalog: {
    pluginId: string;
    marketplaceId: string;
    qualifiedName: string;
    name: string;
    source: 'official';
    description: string;
    category: string;
    author: { name: string };
    version: string;
    homepage: null;
    tags: string[];
    hasLspServers: false;
    hasMcpServers: false;
    hasAgents: false;
    hasCommands: false;
    hasHooks: false;
    isExternal: false;
    installCount: number;
    isInstalled: false;
    installations: [];
  }[];
  pluginCatalogLoading: boolean;
  pluginCatalogError: string | null;
  cliStatus: PluginsPanelCliStatus | null;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({ children }: React.PropsWithChildren) => React.createElement('button', null, children),
}));

vi.mock('@renderer/components/ui/checkbox', () => ({
  Checkbox: () => React.createElement('input', { type: 'checkbox' }),
}));

vi.mock('@renderer/components/ui/label', () => ({
  Label: ({ children }: React.PropsWithChildren) => React.createElement('label', null, children),
}));

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement('button', null, children),
  SelectValue: () => React.createElement('span', null, 'select-value'),
  SelectContent: ({ children }: React.PropsWithChildren) =>
    React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren<{ value: string }>) =>
    React.createElement('button', null, children),
}));

vi.mock('@renderer/components/extensions/common/SearchInput', () => ({
  SearchInput: ({ value }: { value: string }) => React.createElement('input', { value, readOnly: true }),
}));

vi.mock('@renderer/components/extensions/plugins/CapabilityChips', () => ({
  CapabilityChips: () => React.createElement('div', null, 'capability-chips'),
}));

vi.mock('@renderer/components/extensions/plugins/CategoryChips', () => ({
  CategoryChips: () => React.createElement('div', null, 'category-chips'),
}));

vi.mock('@renderer/components/extensions/plugins/PluginCard', () => ({
  PluginCard: ({ plugin }: { plugin: { name: string } }) => React.createElement('div', null, plugin.name),
}));

vi.mock('@renderer/components/extensions/plugins/PluginDetailDialog', () => ({
  PluginDetailDialog: () => null,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    ArrowUpDown: Icon,
    Filter: Icon,
    Puzzle: Icon,
    Search: Icon,
  };
});

import { PluginsPanel } from '@renderer/components/extensions/plugins/PluginsPanel';

const staleCodexStatus: PluginsPanelCliStatus = {
  flavor: 'agent_teams_orchestrator',
  installed: true,
  authLoggedIn: false,
  binaryPath: '/usr/local/bin/agent-teams',
  launchError: null,
  providers: [
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
          plugins: {
            status: 'unsupported',
            ownership: 'provider-scoped',
            reason: 'Codex bootstrap placeholder',
          },
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

const mergedCodexStatus: PluginsPanelCliStatus = {
  ...staleCodexStatus,
  providers: [
    {
      ...staleCodexStatus.providers[0],
      supported: true,
      statusMessage: 'ChatGPT account ready',
      capabilities: {
        ...staleCodexStatus.providers[0].capabilities,
        extensions: {
          ...staleCodexStatus.providers[0].capabilities.extensions,
          plugins: { status: 'supported', ownership: 'shared', reason: null },
        },
      },
    },
  ],
};

describe('PluginsPanel effective runtime status', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.pluginCatalog = [];
    storeState.pluginCatalogLoading = false;
    storeState.pluginCatalogError = null;
    storeState.cliStatus = staleCodexStatus;
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the merged runtime status prop instead of stale store status for Codex plugin warnings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(PluginsPanel, {
          projectPath: null,
          pluginFilters: {
            search: '',
            categories: [],
            capabilities: [],
            installedOnly: false,
          },
          pluginSort: { field: 'popularity', order: 'desc' },
          selectedPluginId: null,
          updatePluginSearch: vi.fn(),
          toggleCategory: vi.fn(),
          toggleCapability: vi.fn(),
          toggleInstalledOnly: vi.fn(),
          setSelectedPluginId: vi.fn(),
          clearFilters: vi.fn(),
          hasActiveFilters: false,
          setPluginSort: vi.fn(),
          cliStatus: mergedCodexStatus,
          cliStatusLoading: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain(
      'In the multimodel runtime, plugins currently apply only to Anthropic sessions.'
    );
    expect(host.textContent).not.toContain('Codex bootstrap placeholder');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('explains that broader plugin support for all agents is actively being built when Codex plugins are not supported yet', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(PluginsPanel, {
          projectPath: null,
          pluginFilters: {
            search: '',
            categories: [],
            capabilities: [],
            installedOnly: false,
          },
          pluginSort: { field: 'popularity', order: 'desc' },
          selectedPluginId: null,
          updatePluginSearch: vi.fn(),
          toggleCategory: vi.fn(),
          toggleCapability: vi.fn(),
          toggleInstalledOnly: vi.fn(),
          setSelectedPluginId: vi.fn(),
          clearFilters: vi.fn(),
          hasActiveFilters: false,
          setPluginSort: vi.fn(),
          cliStatus: staleCodexStatus,
          cliStatusLoading: false,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain(
      'plugins are currently guaranteed only for Anthropic sessions'
    );
    expect(host.textContent).toContain(
      'We are actively building broader plugin support for all agents'
    );
    expect(host.textContent).toContain('universal plugins and agent-specific plugins');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
