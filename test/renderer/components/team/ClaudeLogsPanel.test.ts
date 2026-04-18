import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ClaudeLogsController } from '@renderer/components/team/useClaudeLogsController';

const cliLogsRichViewState = vi.hoisted(() => ({
  calls: [] as Array<Record<string, unknown>>,
}));

vi.mock('@renderer/components/team/CliLogsRichView', () => ({
  CliLogsRichView: (props: Record<string, unknown>) => {
    cliLogsRichViewState.calls.push(props);
    return React.createElement(
      'div',
      { 'data-testid': 'cli-logs-rich-view' },
      String(props.cliLogsTail ?? '')
    );
  },
}));

vi.mock('@renderer/components/team/ClaudeLogsFilterPopover', () => ({
  ClaudeLogsFilterPopover: () => React.createElement('div', { 'data-testid': 'logs-filter' }),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => React.createElement('button', { type: 'button', onClick, disabled }, children),
}));

import { ClaudeLogsPanel } from '@renderer/components/team/ClaudeLogsPanel';

function createController(overrides: Partial<ClaudeLogsController> = {}): ClaudeLogsController {
  return {
    data: { lines: [], total: 0, hasMore: false },
    loading: false,
    loadingMore: false,
    error: null,
    pendingNewCount: 0,
    isAlive: false,
    filteredText: '',
    online: false,
    badge: undefined,
    showMoreVisible: false,
    lastLogPreview: null,
    searchQuery: '',
    setSearchQuery: vi.fn(),
    filter: { streams: new Set(), kinds: new Set() } as ClaudeLogsController['filter'],
    setFilter: vi.fn(),
    filterOpen: false,
    setFilterOpen: vi.fn(),
    viewerState: {} as ClaudeLogsController['viewerState'],
    onViewerStateChange: vi.fn(),
    applyPending: vi.fn(async () => {}),
    loadOlderLogs: vi.fn(async () => {}),
    containerRefCallback: vi.fn(),
    handleScroll: vi.fn(),
    ...overrides,
  };
}

describe('ClaudeLogsPanel', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    cliLogsRichViewState.calls = [];
    vi.unstubAllGlobals();
  });

  it('renders logs even when the team is offline if log lines are available', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const ctrl = createController({
      isAlive: false,
      data: {
        lines: ['second line', 'first line'],
        total: 2,
        hasMore: false,
        updatedAt: '2026-04-19T10:00:01.000Z',
      },
      filteredText: '[stdout]\nfirst line\nsecond line',
      badge: 2,
    });

    await act(async () => {
      root.render(React.createElement(ClaudeLogsPanel, { ctrl }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('2 lines');
    expect(host.textContent).toContain('first line');
    expect(host.textContent).not.toContain('Team is not running.');
    expect(host.querySelector('[data-testid="cli-logs-rich-view"]')).not.toBeNull();
    expect(cliLogsRichViewState.calls.at(-1)?.cliLogsTail).toBe('[stdout]\nfirst line\nsecond line');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the offline empty state only when no logs exist', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const ctrl = createController({
      isAlive: false,
      data: { lines: [], total: 0, hasMore: false },
      filteredText: '',
    });

    await act(async () => {
      root.render(React.createElement(ClaudeLogsPanel, { ctrl }));
      await Promise.resolve();
    });

    expect(host.textContent).toContain('Team is not running.');
    expect(host.querySelector('[data-testid="cli-logs-rich-view"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
