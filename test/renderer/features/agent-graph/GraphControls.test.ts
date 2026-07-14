import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@radix-ui/react-tooltip', () => ({
  Root: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Trigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Portal: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Content: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', { 'data-testid': 'tooltip-content' }, children),
  Arrow: () => null,
}));

import { GraphControls } from '../../../../packages/agent-graph/src/ui/GraphControls';

describe('GraphControls', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders the sidebar toggle before the team and task buttons and triggers the callback', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onToggleSidebar = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange: vi.fn(),
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          onToggleSidebar,
          isSidebarVisible: true,
          onOpenTeamPage: vi.fn(),
          onCreateTask: vi.fn(),
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    const labels = Array.from(host.querySelectorAll('button[aria-label]')).map((button) =>
      button.getAttribute('aria-label')
    );

    expect(labels.indexOf('Hide sidebar')).toBeGreaterThanOrEqual(0);
    expect(labels.indexOf('Open team page')).toBeGreaterThan(labels.indexOf('Hide sidebar'));
    expect(labels.indexOf('Create task')).toBeGreaterThan(labels.indexOf('Open team page'));

    const toggleButton = host.querySelector('button[aria-label="Hide sidebar"]');
    expect(toggleButton).not.toBeNull();

    await act(async () => {
      toggleButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onToggleSidebar).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the open-sidebar label when the sidebar is hidden', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange: vi.fn(),
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          onToggleSidebar: vi.fn(),
          isSidebarVisible: false,
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('button[aria-label="Show sidebar"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('toggles activity visibility from graph settings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFiltersChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange,
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    const settingsButton = host.querySelector('button[aria-label="Graph settings"]');
    expect(settingsButton).not.toBeNull();

    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const activityButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Activity')
    );
    expect(activityButton).not.toBeUndefined();

    await act(async () => {
      activityButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      showActivity: false,
      showLogs: true,
      showTasks: true,
      showProcesses: true,
      showEdges: true,
      showSpaceEffects: true,
      paused: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('toggles log preview visibility from graph settings independently of activity', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFiltersChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange,
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    const settingsButton = host.querySelector('button[aria-label="Graph settings"]');
    expect(settingsButton).not.toBeNull();

    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const logsButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Logs')
    );
    expect(logsButton).not.toBeUndefined();

    await act(async () => {
      logsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      showActivity: true,
      showLogs: false,
      showTasks: true,
      showProcesses: true,
      showEdges: true,
      showSpaceEffects: true,
      paused: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('switches layout mode from the top toolbar', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLayoutModeChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange: vi.fn(),
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          layoutMode: 'radial',
          onLayoutModeChange,
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    const rowsButton = host.querySelector('button[aria-label="Switch to rows layout"]');
    expect(rowsButton).not.toBeNull();

    await act(async () => {
      rowsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onLayoutModeChange).toHaveBeenCalledWith('grid-under-lead');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('supports an organization-specific nested to hierarchy cycle', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onLayoutModeChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange: vi.fn(),
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          layoutMode: 'grid-under-lead',
          layoutModeCycle: ['grid-under-lead', 'hierarchical'],
          layoutModeLabels: {
            hierarchical: 'Switch to hierarchy chart',
            'grid-under-lead': 'Switch to nested map',
          },
          onLayoutModeChange,
          teamName: 'organization-map',
        })
      );
      await Promise.resolve();
    });

    const hierarchyButton = host.querySelector('button[aria-label="Switch to hierarchy chart"]');
    expect(hierarchyButton).not.toBeNull();

    await act(async () => {
      hierarchyButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onLayoutModeChange).toHaveBeenCalledWith('hierarchical');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('toggles stable space effects from graph settings', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onFiltersChange = vi.fn();

    await act(async () => {
      root.render(
        React.createElement(GraphControls, {
          filters: {
            showActivity: true,
            showLogs: true,
            showTasks: true,
            showProcesses: true,
            showEdges: true,
            showSpaceEffects: true,
            paused: false,
          },
          onFiltersChange,
          onZoomIn: vi.fn(),
          onZoomOut: vi.fn(),
          onZoomToFit: vi.fn(),
          teamName: 'demo-team',
        })
      );
      await Promise.resolve();
    });

    const settingsButton = host.querySelector('button[aria-label="Graph settings"]');
    expect(settingsButton).not.toBeNull();

    await act(async () => {
      settingsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    const spaceButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('Space FX')
    );
    expect(spaceButton).not.toBeUndefined();

    await act(async () => {
      spaceButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onFiltersChange).toHaveBeenCalledWith({
      showActivity: true,
      showLogs: true,
      showTasks: true,
      showProcesses: true,
      showEdges: true,
      showSpaceEffects: false,
      paused: false,
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
