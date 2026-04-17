import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

interface StoreState {
  mcpBrowseCatalog: Array<{
    id: string;
    name: string;
    description: string;
    source: 'official' | 'glama';
    installSpec: null;
    envVars: [];
    tools: [];
    requiresAuth: boolean;
  }>;
  mcpBrowseNextCursor?: string;
  mcpBrowseLoading: boolean;
  mcpBrowseError: string | null;
  mcpBrowse: ReturnType<typeof vi.fn>;
  mcpInstalledServers: Array<{ name: string; scope: 'local' | 'user' | 'project' }>;
  mcpInstalledServersByProjectPath?: Record<
    string,
    Array<{ name: string; scope: 'local' | 'user' | 'project' }>
  >;
  fetchMcpGitHubStars: ReturnType<typeof vi.fn>;
  mcpDiagnostics: Record<string, never>;
  mcpDiagnosticsByProjectPath?: Record<string, Record<string, never>>;
  mcpDiagnosticsLoading: boolean;
  mcpDiagnosticsLoadingByProjectPath?: Record<string, boolean>;
  mcpDiagnosticsError: string | null;
  mcpDiagnosticsErrorByProjectPath?: Record<string, string | null>;
  mcpDiagnosticsLastCheckedAt: number | null;
  mcpDiagnosticsLastCheckedAtByProjectPath?: Record<string, number | null>;
  runMcpDiagnostics: ReturnType<typeof vi.fn>;
}

const storeState = {} as StoreState;

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
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

vi.mock('@renderer/components/ui/select', () => ({
  Select: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement('button', { type: 'button' }, children),
  SelectValue: () => React.createElement('span', null, 'select-value'),
  SelectContent: ({ children }: React.PropsWithChildren) => React.createElement('div', null, children),
  SelectItem: ({ children }: React.PropsWithChildren<{ value: string }>) =>
    React.createElement('button', { type: 'button' }, children),
}));

vi.mock('@renderer/components/extensions/common/SearchInput', () => ({
  SearchInput: ({
    value,
    onChange,
  }: {
    value: string;
    onChange: (value: string) => void;
  }) =>
    React.createElement('input', {
      value,
      onChange: (event: React.ChangeEvent<HTMLInputElement>) => onChange(event.target.value),
    }),
}));

vi.mock('@renderer/components/extensions/mcp/McpServerCard', () => ({
  McpServerCard: ({ server }: { server: { id: string; name: string } }) =>
    React.createElement('div', { 'data-testid': 'mcp-card', 'data-server-id': server.id }, server.name),
}));

vi.mock('@renderer/components/extensions/mcp/McpServerDetailDialog', () => ({
  McpServerDetailDialog: ({ open }: { open: boolean }) =>
    open ? React.createElement('div', { 'data-testid': 'mcp-detail' }) : null,
}));

vi.mock('@renderer/utils/formatters', () => ({
  formatRelativeTime: () => 'just now',
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    AlertTriangle: Icon,
    RefreshCw: Icon,
    Search: Icon,
    Server: Icon,
  };
});

import { McpServersPanel } from '@renderer/components/extensions/mcp/McpServersPanel';

describe('McpServersPanel initial browse loading', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.mcpBrowseCatalog = [];
    storeState.mcpBrowseNextCursor = undefined;
    storeState.mcpBrowseLoading = false;
    storeState.mcpBrowseError = null;
    storeState.mcpBrowse = vi.fn();
    storeState.mcpInstalledServers = [];
    storeState.mcpInstalledServersByProjectPath = undefined;
    storeState.fetchMcpGitHubStars = vi.fn();
    storeState.mcpDiagnostics = {};
    storeState.mcpDiagnosticsByProjectPath = undefined;
    storeState.mcpDiagnosticsLoading = false;
    storeState.mcpDiagnosticsLoadingByProjectPath = undefined;
    storeState.mcpDiagnosticsError = null;
    storeState.mcpDiagnosticsErrorByProjectPath = undefined;
    storeState.mcpDiagnosticsLastCheckedAt = null;
    storeState.mcpDiagnosticsLastCheckedAtByProjectPath = undefined;
    storeState.runMcpDiagnostics = vi.fn();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('loads the catalog once on first mount when browse state is empty', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(McpServersPanel, {
          projectPath: null,
          mcpSearchQuery: '',
          mcpSearch: vi.fn(),
          mcpSearchResults: [],
          mcpSearchLoading: false,
          mcpSearchWarnings: [],
          selectedMcpServerId: null,
          setSelectedMcpServerId: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(storeState.mcpBrowse).toHaveBeenCalledTimes(1);
    expect(storeState.runMcpDiagnostics).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not auto-retry browse after an error with an empty catalog', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(McpServersPanel, {
          projectPath: null,
          mcpSearchQuery: '',
          mcpSearch: vi.fn(),
          mcpSearchResults: [],
          mcpSearchLoading: false,
          mcpSearchWarnings: [],
          selectedMcpServerId: null,
          setSelectedMcpServerId: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(storeState.mcpBrowse).toHaveBeenCalledTimes(1);

    storeState.mcpBrowseError = 'Registry unavailable';
    await act(async () => {
      root.render(
        React.createElement(McpServersPanel, {
          projectPath: null,
          mcpSearchQuery: '',
          mcpSearch: vi.fn(),
          mcpSearchResults: [],
          mcpSearchLoading: false,
          mcpSearchWarnings: [],
          selectedMcpServerId: null,
          setSelectedMcpServerId: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(storeState.mcpBrowse).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
