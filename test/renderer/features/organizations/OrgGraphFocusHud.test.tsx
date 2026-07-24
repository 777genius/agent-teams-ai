import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { OrgGraphFocusHud } from '@features/organizations/renderer/ui/OrgGraphFocusHud';
import { buildOrganizationMapViewModel } from '@features/organizations/renderer/view-models/organizationMapViewModel';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationMapPayload } from '@features/organizations/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, options?: { count?: number; task?: string }) => {
      if (key.endsWith('connectedOnly')) return `Connected (${options?.count ?? 0})`;
      if (key.endsWith('taskMatch')) return `Task: ${options?.task ?? ''}`;
      return key;
    },
  }),
}));

function buildViewModel() {
  const payload: OrganizationMapPayload = {
    organizations: [{ id: 'acme', name: 'Acme', rootNodeId: 'org:acme' }],
    activeOrganizationId: 'acme',
    rootNodeId: 'org:acme',
    nodes: [
      { id: 'org:acme', kind: 'organization', label: 'Acme' },
      { id: 'group:platform', kind: 'container', label: 'Platform' },
      {
        id: 'team:alpha',
        kind: 'team',
        label: 'Alpha',
        team: {
          teamName: 'alpha',
          displayName: 'Alpha Team',
          isOnline: true,
          memberCount: 1,
          taskCounts: { pending: 0, inProgress: 1, completed: 0 },
          agents: [
            {
              id: 'agent:alpha',
              teamName: 'alpha',
              name: 'Alice',
              status: 'active',
              activeTaskCount: 1,
              currentTasks: [
                { id: 'task:1', subject: 'Implement live search', status: 'in_progress' },
              ],
            },
          ],
        },
      },
    ],
    relations: [
      {
        id: 'contains:group',
        sourceNodeId: 'org:acme',
        targetNodeId: 'group:platform',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'contains:team',
        sourceNodeId: 'group:platform',
        targetNodeId: 'team:alpha',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
    ],
    degraded: false,
    diagnostics: {
      totalTeams: 1,
      renderedTeams: 1,
      totalCrossTeamMessages: 0,
      renderedCrossTeamRelations: 0,
      truncatedTeams: 0,
      truncatedCrossTeamMessages: 0,
      generatedAt: '2026-07-14T00:00:00.000Z',
    },
  };
  return buildOrganizationMapViewModel(payload);
}

describe('OrgGraphFocusHud', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('finds a team by active task and reveals it', async () => {
    const onFocusModeChange = vi.fn();
    const onSelectNode = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OrgGraphFocusHud
          viewModel={buildViewModel()}
          selectedNodeId={null}
          focusMode="context"
          connectedTeamCount={0}
          collapsedNodeIds={new Set()}
          onFocusModeChange={onFocusModeChange}
          onSelectNode={onSelectNode}
          onToggleNodeCollapse={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const searchToggle = host.querySelector<HTMLButtonElement>(
      'button[aria-controls="organization-map-search-panel"]'
    );
    expect(searchToggle?.getAttribute('aria-expanded')).toBe('false');
    await act(async () => {
      searchToggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    const searchInput = host.querySelector<HTMLInputElement>('input[role="combobox"]');
    expect(searchInput).not.toBeNull();
    expect(searchToggle?.getAttribute('aria-expanded')).toBe('true');
    expect(document.activeElement).toBe(searchInput);
    await act(async () => {
      const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
      valueSetter?.call(searchInput, 'live search');
      searchInput?.dispatchEvent(new Event('input', { bubbles: true }));
      await Promise.resolve();
    });
    const result = host.querySelector<HTMLButtonElement>('button[role="option"]');
    expect(result?.textContent).toContain('Alpha Team');
    await act(async () => {
      result?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onFocusModeChange).toHaveBeenCalledWith('context');
    expect(onSelectNode).toHaveBeenCalledWith('team:alpha', true);

    await act(async () => root.unmount());
  });

  it('opens and hides the search panel from the icon button', async () => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OrgGraphFocusHud
          viewModel={buildViewModel()}
          selectedNodeId={null}
          focusMode="context"
          connectedTeamCount={0}
          collapsedNodeIds={new Set()}
          onFocusModeChange={vi.fn()}
          onSelectNode={vi.fn()}
          onToggleNodeCollapse={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const toggle = host.querySelector<HTMLButtonElement>(
      'button[aria-controls="organization-map-search-panel"]'
    );
    expect(toggle).not.toBeNull();
    expect(host.querySelector('#organization-map-search-panel')).toBeNull();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await new Promise((resolve) => window.requestAnimationFrame(resolve));
    });
    expect(host.querySelector('#organization-map-search-panel')).not.toBeNull();

    await act(async () => {
      toggle?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(host.querySelector('#organization-map-search-panel')).toBeNull();
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');

    await act(async () => root.unmount());
  });

  it('renders breadcrumbs and exposes focus and collapse controls', async () => {
    const onFocusModeChange = vi.fn();
    const onToggleNodeCollapse = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <OrgGraphFocusHud
          viewModel={buildViewModel()}
          selectedNodeId="group:platform"
          focusMode="context"
          connectedTeamCount={3}
          collapsedNodeIds={new Set()}
          onFocusModeChange={onFocusModeChange}
          onSelectNode={vi.fn()}
          onToggleNodeCollapse={onToggleNodeCollapse}
        />
      );
      await Promise.resolve();
    });

    const findButton = (text: string): HTMLButtonElement | undefined =>
      Array.from(host.querySelectorAll('button')).find((button) => button.textContent === text);
    await act(async () => {
      findButton('organizations.graph.focus.pathToRoot')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      findButton('Connected (3)')?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      findButton('organizations.graph.focus.collapseBranch')?.dispatchEvent(
        new MouseEvent('click', { bubbles: true })
      );
      await Promise.resolve();
    });

    expect(findButton('Acme')).not.toBeUndefined();
    expect(onFocusModeChange).toHaveBeenNthCalledWith(1, 'path');
    expect(onFocusModeChange).toHaveBeenNthCalledWith(2, 'connections');
    expect(onToggleNodeCollapse).toHaveBeenCalledWith('group:platform');

    await act(async () => root.unmount());
  });
});
