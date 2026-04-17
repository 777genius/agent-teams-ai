import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { EnrichedPlugin } from '@shared/types/extensions';

interface StoreState {
  fetchPluginReadme: ReturnType<typeof vi.fn>;
  pluginReadmes: Record<string, string | null>;
  pluginReadmeLoading: Record<string, boolean>;
  installPlugin: ReturnType<typeof vi.fn>;
  uninstallPlugin: ReturnType<typeof vi.fn>;
  pluginCatalogProjectPath: string | null;
  pluginInstallProgress: Record<string, string>;
  installErrors: Record<string, string>;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock('@renderer/api', () => ({
  api: {
    openExternal: vi.fn(),
  },
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) =>
    React.createElement('div', { 'data-testid': 'markdown' }, content),
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
    onClick?: () => void;
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
    React.createElement(
      'option',
      {
        value,
        disabled,
      },
      children
    ),
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

vi.mock('@renderer/components/extensions/common/InstallCountBadge', () => ({
  InstallCountBadge: ({ count }: { count: number }) =>
    React.createElement('span', { 'data-testid': 'install-count' }, String(count)),
}));

vi.mock('@renderer/components/extensions/common/SourceBadge', () => ({
  SourceBadge: ({ source }: { source: string }) =>
    React.createElement('span', { 'data-testid': 'source-badge' }, source),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    ExternalLink: Icon,
    Loader2: Icon,
    Mail: Icon,
  };
});

import { PluginDetailDialog } from '@renderer/components/extensions/plugins/PluginDetailDialog';

const makePlugin = (): EnrichedPlugin => ({
  pluginId: 'context7@claude-plugins-official',
  marketplaceId: 'context7@claude-plugins-official',
  qualifiedName: 'context7@claude-plugins-official',
  name: 'Context7',
  source: 'official',
  description: 'Fresh docs in Claude',
  category: 'docs',
  author: { name: 'Anthropic', email: 'help@example.com' },
  version: '1.0.0',
  homepage: 'https://example.com/context7',
  tags: [],
  hasLspServers: false,
  hasMcpServers: true,
  hasAgents: false,
  hasCommands: false,
  hasHooks: false,
  isExternal: true,
  installCount: 42,
  isInstalled: false,
  installations: [],
});

describe('PluginDetailDialog project context', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.fetchPluginReadme = vi.fn();
    storeState.pluginReadmes = {};
    storeState.pluginReadmeLoading = {};
    storeState.installPlugin = vi.fn();
    storeState.uninstallPlugin = vi.fn();
    storeState.pluginCatalogProjectPath = '/tmp/global-project';
    storeState.pluginInstallProgress = {};
    storeState.installErrors = {};
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('uses the current tab project path for project-scope installs', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const plugin = makePlugin();

    await act(async () => {
      root.render(
        React.createElement(PluginDetailDialog, {
          plugin,
          open: true,
          onClose: vi.fn(),
          projectPath: '/tmp/tab-project',
        })
      );
      await Promise.resolve();
    });

    const scopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;
    expect(scopeSelect).not.toBeNull();

    await act(async () => {
      scopeSelect.value = 'project';
      scopeSelect.dispatchEvent(new Event('change', { bubbles: true }));
      await Promise.resolve();
    });

    const installButton = host.querySelector('[data-testid="install-button"]') as HTMLButtonElement;
    expect(installButton).not.toBeNull();

    await act(async () => {
      installButton.click();
      await Promise.resolve();
    });

    expect(storeState.installPlugin).toHaveBeenCalledWith({
      pluginId: plugin.pluginId,
      scope: 'project',
      projectPath: '/tmp/tab-project',
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('disables project and local scopes when the current tab has no project', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(PluginDetailDialog, {
          plugin: makePlugin(),
          open: true,
          onClose: vi.fn(),
          projectPath: null,
        })
      );
      await Promise.resolve();
    });

    const scopeSelect = host.querySelector('[data-testid="scope-select"]') as HTMLSelectElement;
    const projectOption = scopeSelect.querySelector(
      'option[value="project"]'
    ) as HTMLOptionElement | null;
    const localOption = scopeSelect.querySelector(
      'option[value="local"]'
    ) as HTMLOptionElement | null;
    expect(scopeSelect).not.toBeNull();
    expect(projectOption?.disabled).toBe(true);
    expect(localOption?.disabled).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
