import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildOrganizationMapViewModel } from '@features/organizations/renderer/adapters/organizationMapViewModel';
import { OrgGraphSurface } from '@features/organizations/renderer/ui/OrgGraphSurface';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationMapPayload } from '@features/organizations/contracts';

const graphViewMock = vi.hoisted(() => ({
  zoomToFit: vi.fn(),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@features/organizations/renderer/ui/OrgOverviewHud', () => ({
  OrgOverviewHud: ({
    onSelectNode,
  }: {
    onSelectNode: (nodeId: string, reveal: boolean) => void;
  }) => (
    <button
      type="button"
      data-organization-overview-hud
      onClick={() => onSelectNode('org:acme', true)}
    />
  ),
}));

vi.mock('@claude-teams/agent-graph', () => ({
  GraphView: ({
    data,
    fitViewRequestId,
    renderControls,
    renderHud,
  }: {
    data: { nodes: unknown[] };
    fitViewRequestId?: number;
    renderControls?: (controls: {
      filters: {
        showActivity: boolean;
        showLogs: boolean;
        showTasks: boolean;
        showProcesses: boolean;
        showEdges: boolean;
        showSpaceEffects: boolean;
        paused: boolean;
      };
      onFiltersChange: () => void;
      onZoomIn: () => void;
      onZoomOut: () => void;
      onZoomToFit: () => void;
    }) => React.ReactNode;
    renderHud?: (controls: {
      getGroupFrameScreenPlacements: () => [];
      getViewportSize: () => { width: number; height: number };
      getCameraZoom: () => number;
    }) => React.ReactNode;
  }) => (
    <div data-fit-view-request-id={fitViewRequestId} data-graph-node-count={data.nodes.length}>
      {renderControls?.({
        filters: {
          showActivity: false,
          showLogs: false,
          showTasks: true,
          showProcesses: false,
          showEdges: true,
          showSpaceEffects: false,
          paused: true,
        },
        onFiltersChange: vi.fn(),
        onZoomIn: vi.fn(),
        onZoomOut: vi.fn(),
        onZoomToFit: () => graphViewMock.zoomToFit(data.nodes.length),
      })}
      {renderHud?.({
        getGroupFrameScreenPlacements: () => [],
        getViewportSize: () => ({ width: 1200, height: 800 }),
        getCameraZoom: () => 1,
      })}
    </div>
  ),
}));

function buildViewModel() {
  const payload: OrganizationMapPayload = {
    organizations: [{ id: 'acme', name: 'Acme', rootNodeId: 'org:acme' }],
    activeOrganizationId: 'acme',
    rootNodeId: 'org:acme',
    nodes: [{ id: 'org:acme', kind: 'organization', label: 'Acme' }],
    relations: [],
    degraded: false,
    diagnostics: {
      totalTeams: 0,
      renderedTeams: 0,
      totalCrossTeamMessages: 0,
      renderedCrossTeamRelations: 0,
      truncatedTeams: 0,
      truncatedCrossTeamMessages: 0,
      generatedAt: '2026-07-14T00:00:00.000Z',
    },
  };
  return buildOrganizationMapViewModel(payload);
}

describe('OrgGraphSurface', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('keeps the organization overview separate from hierarchy, structure, and relations', async () => {
    const onLayoutModeChange = vi.fn();
    const onRevealNode = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OrgGraphSurface
          viewModel={buildViewModel()}
          isActive
          collapsedNodeIds={new Set()}
          layoutMode="hierarchical"
          selectedNodeId={null}
          onLayoutModeChange={onLayoutModeChange}
          onSelectNode={vi.fn()}
          onRevealNode={onRevealNode}
          onToggleNodeCollapse={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const modeButtons = Array.from(
      host.querySelectorAll<HTMLButtonElement>('button[data-organization-map-view-mode]')
    );
    expect(modeButtons.map((button) => button.dataset.organizationMapViewMode)).toEqual([
      'overview',
      'hierarchy',
      'structure',
      'relations',
    ]);
    expect(modeButtons[1]?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-organization-overview-hud]')).toBeNull();
    expect(
      host.querySelector<HTMLButtonElement>(
        'button[aria-label="organizations.graph.toolbar.reset"]'
      )?.disabled
    ).toBe(false);

    await act(async () => {
      modeButtons[0]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(modeButtons[0]?.getAttribute('aria-pressed')).toBe('true');
    expect(host.querySelector('[data-organization-overview-hud]')).not.toBeNull();
    expect(host.querySelector('[data-graph-node-count="0"]')).not.toBeNull();
    expect(onLayoutModeChange).not.toHaveBeenCalled();

    await act(async () => {
      host
        .querySelector('[data-organization-overview-hud]')
        ?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-organization-overview-hud]')).toBeNull();
    expect(onLayoutModeChange).toHaveBeenCalledWith('grid-under-lead');
    expect(onRevealNode).toHaveBeenCalledWith('org:acme');

    onLayoutModeChange.mockClear();
    await act(async () => {
      modeButtons[3]?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onLayoutModeChange).toHaveBeenCalledWith('grid-under-lead');
    expect(modeButtons[3]?.getAttribute('aria-pressed')).toBe('true');

    act(() => root.unmount());
  });

  it('requests a fit for restored hierarchy data instead of fitting empty overview data', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OrgGraphSurface
          viewModel={buildViewModel()}
          isActive
          collapsedNodeIds={new Set()}
          layoutMode="hierarchical"
          selectedNodeId={null}
          onLayoutModeChange={vi.fn()}
          onSelectNode={vi.fn()}
          onRevealNode={vi.fn()}
          onToggleNodeCollapse={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const overviewButton = host.querySelector<HTMLButtonElement>(
      'button[data-organization-map-view-mode="overview"]'
    );
    await act(async () => {
      overviewButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('[data-graph-node-count="0"]')).not.toBeNull();

    const resetButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="organizations.graph.toolbar.reset"]'
    );
    await act(async () => {
      resetButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(host.querySelector('[data-graph-node-count="1"]')).not.toBeNull();
    expect(host.querySelector('[data-fit-view-request-id="1"]')).not.toBeNull();
    expect(graphViewMock.zoomToFit).not.toHaveBeenCalled();

    act(() => root.unmount());
  });
});
