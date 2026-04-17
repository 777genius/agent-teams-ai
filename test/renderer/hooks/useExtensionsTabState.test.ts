import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useExtensionsTabState } from '../../../src/renderer/hooks/useExtensionsTabState';

import type { McpCatalogItem } from '@shared/types/extensions';

type ExtensionsTabState = ReturnType<typeof useExtensionsTabState>;

let capturedState: ExtensionsTabState | null = null;
const mcpSearchMock = vi.fn();

vi.mock('@renderer/api', () => ({
  api: {
    mcpRegistry: {
      search: (...args: unknown[]) => mcpSearchMock(...args),
    },
  },
}));

function Harness(): null {
  capturedState = useExtensionsTabState();
  return null;
}

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function makeMcpServer(id: string): McpCatalogItem {
  return {
    id,
    name: id,
    description: `${id} description`,
    source: 'official',
    installSpec: null,
    envVars: [],
    tools: [],
    requiresAuth: false,
  };
}

describe('useExtensionsTabState', () => {
  beforeEach(() => {
    mcpSearchMock.mockReset();
    mcpSearchMock.mockResolvedValue({ servers: [], warnings: [] });
  });

  afterEach(() => {
    capturedState = null;
    document.body.innerHTML = '';
    vi.useRealTimers();
  });

  it('clears selected plugin when leaving the plugins sub-tab', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.setSelectedPluginId('context7@claude-plugins-official');
      await Promise.resolve();
    });
    expect(capturedState?.selectedPluginId).toBe('context7@claude-plugins-official');

    await act(async () => {
      capturedState?.setActiveSubTab('mcp-servers');
      await Promise.resolve();
    });
    expect(capturedState?.selectedPluginId).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears selected MCP server when leaving the MCP sub-tab', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.setActiveSubTab('mcp-servers');
      await Promise.resolve();
    });
    await act(async () => {
      capturedState?.setSelectedMcpServerId('server-1');
      await Promise.resolve();
    });
    expect(capturedState?.selectedMcpServerId).toBe('server-1');

    await act(async () => {
      capturedState?.setActiveSubTab('skills');
      await Promise.resolve();
    });
    expect(capturedState?.selectedMcpServerId).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears selected skill when leaving the skills sub-tab', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.setActiveSubTab('skills');
      await Promise.resolve();
    });
    await act(async () => {
      capturedState?.setSelectedSkillId('skill-1');
      await Promise.resolve();
    });
    expect(capturedState?.selectedSkillId).toBe('skill-1');

    await act(async () => {
      capturedState?.setActiveSubTab('api-keys');
      await Promise.resolve();
    });
    expect(capturedState?.selectedSkillId).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('ignores stale MCP search responses that resolve out of order', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const first = createDeferred<{ servers: McpCatalogItem[]; warnings: string[] }>();
    const second = createDeferred<{ servers: McpCatalogItem[]; warnings: string[] }>();

    mcpSearchMock
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.mcpSearch('first');
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      capturedState?.mcpSearch('second');
      await vi.advanceTimersByTimeAsync(300);
    });

    await act(async () => {
      second.resolve({ servers: [makeMcpServer('second-result')], warnings: ['new warning'] });
      await Promise.resolve();
    });
    expect(capturedState?.mcpSearchResults.map((server) => server.id)).toEqual(['second-result']);
    expect(capturedState?.mcpSearchWarnings).toEqual(['new warning']);

    await act(async () => {
      first.resolve({ servers: [makeMcpServer('first-result')], warnings: ['old warning'] });
      await Promise.resolve();
    });
    expect(capturedState?.mcpSearchResults.map((server) => server.id)).toEqual(['second-result']);
    expect(capturedState?.mcpSearchWarnings).toEqual(['new warning']);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('drops in-flight MCP search results after clearing the query', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.useFakeTimers();
    const pending = createDeferred<{ servers: McpCatalogItem[]; warnings: string[] }>();
    mcpSearchMock.mockReturnValueOnce(pending.promise);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(Harness));
      await Promise.resolve();
    });

    await act(async () => {
      capturedState?.mcpSearch('context7');
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(capturedState?.mcpSearchLoading).toBe(true);

    await act(async () => {
      capturedState?.mcpSearch('');
      await Promise.resolve();
    });
    expect(capturedState?.mcpSearchQuery).toBe('');
    expect(capturedState?.mcpSearchResults).toEqual([]);
    expect(capturedState?.mcpSearchWarnings).toEqual([]);
    expect(capturedState?.mcpSearchLoading).toBe(false);

    await act(async () => {
      pending.resolve({ servers: [makeMcpServer('stale-result')], warnings: ['stale warning'] });
      await Promise.resolve();
    });
    expect(capturedState?.mcpSearchResults).toEqual([]);
    expect(capturedState?.mcpSearchWarnings).toEqual([]);
    expect(capturedState?.mcpSearchLoading).toBe(false);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
