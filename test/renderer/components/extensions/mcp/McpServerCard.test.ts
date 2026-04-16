import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { getMcpOperationKey } from '@shared/utils/extensionNormalizers';
import type { InstalledMcpEntry, McpCatalogItem } from '@shared/types/extensions';

interface StoreState {
  mcpInstallProgress: Record<string, string>;
  installMcpServer: ReturnType<typeof vi.fn>;
  uninstallMcpServer: ReturnType<typeof vi.fn>;
  installErrors: Record<string, string>;
  mcpGitHubStars: Record<string, number>;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(),
  },
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    type = 'button',
  }: React.PropsWithChildren<{
    onClick?: (event: React.MouseEvent<HTMLButtonElement>) => void;
    type?: 'button' | 'submit' | 'reset';
  }>) =>
    React.createElement(
      'button',
      {
        type,
        onClick,
      },
      children
    ),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) => React.createElement('span', null, children),
}));

vi.mock('@renderer/components/extensions/common/InstallButton', () => ({
  InstallButton: ({
    state,
    errorMessage,
  }: {
    state?: string;
    errorMessage?: string;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'install-button',
        'data-state': state,
        'data-error': errorMessage,
      },
      'Install'
    ),
}));

vi.mock('@renderer/components/extensions/common/SourceBadge', () => ({
  SourceBadge: ({ source }: { source: string }) => React.createElement('span', null, source),
}));

vi.mock('@renderer/utils/formatters', () => ({
  formatCompactNumber: (value: number) => String(value),
  formatRelativeTime: () => 'recently',
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Clock: Icon,
    Cloud: Icon,
    Globe: Icon,
    KeyRound: Icon,
    Lock: Icon,
    Monitor: Icon,
    Star: Icon,
    Tag: Icon,
    Wrench: Icon,
    Github: Icon,
  };
});

import { McpServerCard } from '@renderer/components/extensions/mcp/McpServerCard';

function makeServer(): McpCatalogItem {
  return {
    id: 'io.github.upstash/context7',
    name: 'Context7',
    description: 'Docs server',
    source: 'official',
    installSpec: {
      type: 'stdio',
      npmPackage: '@upstash/context7-mcp',
    },
    envVars: [],
    tools: [],
    requiresAuth: false,
    authHeaders: [],
  };
}

describe('McpServerCard direct action safety', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.mcpInstallProgress = {};
    storeState.installMcpServer = vi.fn();
    storeState.uninstallMcpServer = vi.fn();
    storeState.installErrors = {};
    storeState.mcpGitHubStars = {};
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('falls back to Manage for installed entries that cannot be safely uninstalled directly', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onClick = vi.fn();
    const installedEntry: InstalledMcpEntry = {
      name: 'context7-local',
      scope: 'local',
    };

    await act(async () => {
      root.render(
        React.createElement(McpServerCard, {
          server: makeServer(),
          isInstalled: true,
          installedEntry,
          diagnostic: null,
          diagnosticsLoading: false,
          onClick,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="install-button"]')).toBeNull();
    const manageButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent === 'Manage'
    ) as HTMLButtonElement | undefined;
    expect(manageButton).toBeDefined();

    await act(async () => {
      manageButton?.click();
      await Promise.resolve();
    });

    expect(onClick).toHaveBeenCalledWith('io.github.upstash/context7');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps direct actions for standard user-scope installs', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const installedEntry: InstalledMcpEntry = {
      name: 'context7',
      scope: 'user',
    };

    await act(async () => {
      root.render(
        React.createElement(McpServerCard, {
          server: makeServer(),
          isInstalled: true,
          installedEntry,
          installedEntries: [installedEntry],
          diagnostic: null,
          diagnosticsLoading: false,
          onClick: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[data-testid="install-button"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('falls back to Manage when the same server is installed in multiple scopes', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const installedEntries: InstalledMcpEntry[] = [
      { name: 'context7', scope: 'user' },
      { name: 'context7', scope: 'project' },
    ];

    await act(async () => {
      root.render(
        React.createElement(McpServerCard, {
          server: makeServer(),
          isInstalled: true,
          installedEntry: installedEntries[1],
          installedEntries,
          diagnostic: null,
          diagnosticsLoading: false,
          onClick: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Installed in 2 scopes');
    expect(host.querySelector('[data-testid="install-button"]')).toBeNull();
    expect(host.textContent).toContain('Manage');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reads direct-action state from the user-scope operation key', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const installedEntry: InstalledMcpEntry = {
      name: 'context7',
      scope: 'user',
    };

    storeState.mcpInstallProgress = {
      [getMcpOperationKey('io.github.upstash/context7', 'project')]: 'error',
      [getMcpOperationKey('io.github.upstash/context7', 'user')]: 'pending',
    };
    storeState.installErrors = {
      [getMcpOperationKey('io.github.upstash/context7', 'project')]: 'Project failed',
      [getMcpOperationKey('io.github.upstash/context7', 'user')]: 'User failed',
    };

    await act(async () => {
      root.render(
        React.createElement(McpServerCard, {
          server: makeServer(),
          isInstalled: true,
          installedEntry,
          installedEntries: [installedEntry],
          diagnostic: null,
          diagnosticsLoading: false,
          onClick: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const installButton = host.querySelector('[data-testid="install-button"]') as HTMLButtonElement;
    expect(installButton.dataset.state).toBe('pending');
    expect(installButton.dataset.error).toBe('User failed');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
