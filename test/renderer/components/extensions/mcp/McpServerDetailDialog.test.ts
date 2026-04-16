import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InstalledMcpEntry, McpCatalogItem } from '@shared/types/extensions';

interface StoreState {
  mcpInstallProgress: Record<string, string>;
  installMcpServer: ReturnType<typeof vi.fn>;
  uninstallMcpServer: ReturnType<typeof vi.fn>;
  installErrors: Record<string, string>;
  mcpGitHubStars: Record<string, number>;
}

const storeState = {} as StoreState;
const lookupMock = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(),
    apiKeys: {
      lookup: (...args: unknown[]) => lookupMock(...args),
    },
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
    disabled,
  }: React.PropsWithChildren<{
    onClick?: () => void;
    type?: 'button' | 'submit' | 'reset';
    disabled?: boolean;
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
    open ? React.createElement('div', null, children) : null,
  DialogContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
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
  Select: ({
    children,
    value,
    onValueChange,
  }: React.PropsWithChildren<{ value: string; onValueChange: (value: string) => void }>) =>
    React.createElement(
      'select',
      {
        'data-testid': 'scope-select',
        value,
        onChange: (event: React.ChangeEvent<HTMLSelectElement>) => onValueChange(event.target.value),
      },
      children
    ),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  SelectValue: () => null,
  SelectContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  SelectItem: ({
    children,
    value,
    disabled,
  }: React.PropsWithChildren<{ value: string; disabled?: boolean }>) =>
    React.createElement('option', { value, disabled }, children),
}));

vi.mock('@renderer/components/extensions/common/InstallButton', () => ({
  InstallButton: ({
    isInstalled,
    onInstall,
    onUninstall,
  }: {
    isInstalled: boolean;
    onInstall: () => void;
    onUninstall: () => void;
  }) =>
    React.createElement(
      'button',
      {
        type: 'button',
        'data-testid': 'install-button',
        onClick: () => (isInstalled ? onUninstall() : onInstall()),
      },
      isInstalled ? 'Uninstall' : 'Install'
    ),
}));

vi.mock('@renderer/components/extensions/common/SourceBadge', () => ({
  SourceBadge: ({ source }: { source: string }) => React.createElement('span', null, source),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    ExternalLink: Icon,
    Lock: Icon,
    Plus: Icon,
    Star: Icon,
    Trash2: Icon,
    Wrench: Icon,
  };
});

import { McpServerDetailDialog } from '@renderer/components/extensions/mcp/McpServerDetailDialog';

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

describe('McpServerDetailDialog installed entry handling', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.mcpInstallProgress = {};
    storeState.installMcpServer = vi.fn();
    storeState.uninstallMcpServer = vi.fn();
    storeState.installErrors = {};
    storeState.mcpGitHubStars = {};
    lookupMock.mockReset();
    lookupMock.mockResolvedValue([]);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uninstalls using the real installed server name and scope', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const installedEntry: InstalledMcpEntry = {
      name: 'context7-local',
      scope: 'local',
    };

    await act(async () => {
      root.render(
        React.createElement(McpServerDetailDialog, {
          server: makeServer(),
          isInstalled: true,
          installedEntry,
          diagnostic: null,
          diagnosticsLoading: false,
          projectPath: '/tmp/project',
          open: true,
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const serverNameInput = host.querySelector('#server-name') as HTMLInputElement;
    expect(serverNameInput).not.toBeNull();
    expect(serverNameInput.value).toBe('context7-local');
    expect(serverNameInput.disabled).toBe(true);

    const scopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;
    expect(scopeSelect.value).toBe('local');

    const uninstallButton = host.querySelector('[data-testid="install-button"]') as HTMLButtonElement;
    await act(async () => {
      uninstallButton.click();
      await Promise.resolve();
    });

    expect(storeState.uninstallMcpServer).toHaveBeenCalledWith(
      'io.github.upstash/context7',
      'context7-local',
      'local',
      undefined
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('looks up saved API keys only once per dialog open', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const server = makeServer();
    server.envVars = [{ name: 'CONTEXT7_API_KEY', isSecret: true }];
    lookupMock.mockResolvedValue([
      {
        envVarName: 'CONTEXT7_API_KEY',
        value: 'secret',
      },
    ]);

    await act(async () => {
      root.render(
        React.createElement(McpServerDetailDialog, {
          server,
          isInstalled: false,
          installedEntry: null,
          diagnostic: null,
          diagnosticsLoading: false,
          projectPath: null,
          open: true,
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(lookupMock).toHaveBeenCalledTimes(1);
    expect(lookupMock).toHaveBeenCalledWith(['CONTEXT7_API_KEY']);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('passes project path for project-scoped installs and uninstalls', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const projectPath = '/tmp/project-context7';
    const installedEntry: InstalledMcpEntry = {
      name: 'context7-project',
      scope: 'project',
    };

    await act(async () => {
      root.render(
        React.createElement(McpServerDetailDialog, {
          server: makeServer(),
          isInstalled: true,
          installedEntry,
          diagnostic: null,
          diagnosticsLoading: false,
          projectPath,
          open: true,
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const scopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;
    expect(scopeSelect.value).toBe('project');

    const uninstallButton = host.querySelector('[data-testid="install-button"]') as HTMLButtonElement;
    await act(async () => {
      uninstallButton.click();
      await Promise.resolve();
    });

    expect(storeState.uninstallMcpServer).toHaveBeenCalledWith(
      'io.github.upstash/context7',
      'context7-project',
      'project',
      projectPath
    );

    await act(async () => {
      root.render(
        React.createElement(McpServerDetailDialog, {
          server: makeServer(),
          isInstalled: false,
          installedEntry: null,
          diagnostic: null,
          diagnosticsLoading: false,
          projectPath,
          open: true,
          onClose: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const installScopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;
    await act(async () => {
      installScopeSelect.value = 'project';
      installScopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const installButton = host.querySelector('[data-testid="install-button"]') as HTMLButtonElement;
    await act(async () => {
      installButton.click();
      await Promise.resolve();
    });

    expect(storeState.installMcpServer).toHaveBeenCalledWith(
      expect.objectContaining({
        registryId: 'io.github.upstash/context7',
        scope: 'project',
        projectPath,
      })
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
