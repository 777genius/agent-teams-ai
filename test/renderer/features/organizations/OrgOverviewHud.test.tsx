import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildOrganizationMapViewModel } from '@features/organizations/renderer/adapters/organizationMapViewModel';
import { OrgOverviewHud } from '@features/organizations/renderer/ui/OrgOverviewHud';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationMapPayload } from '@features/organizations/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string, params: Record<string, number>) => {
      if (key.endsWith('.summary')) {
        return `${params.groupCount} groups · ${params.teamCount} teams · ${params.agentCount} agents`;
      }
      if (key.endsWith('.activeTasks')) return `${params.count} active tasks`;
      if (key.endsWith('.attention')) return `${params.count} need attention`;
      if (key.endsWith('.teamsOnline')) {
        return `${params.onlineCount}/${params.teamCount} teams online`;
      }
      return key;
    },
  }),
}));

function buildViewModel() {
  const payload: OrganizationMapPayload = {
    organizations: [{ id: 'acme', name: 'Acme Platform', rootNodeId: 'org:acme' }],
    activeOrganizationId: 'acme',
    rootNodeId: 'org:acme',
    nodes: [
      { id: 'org:acme', kind: 'organization', label: 'Acme Platform' },
      { id: 'group:runtime', kind: 'container', label: 'Runtime' },
      {
        id: 'team:alpha',
        kind: 'team',
        label: 'Alpha',
        team: {
          teamName: 'alpha',
          displayName: 'Alpha',
          isOnline: true,
          memberCount: 4,
          taskCounts: { pending: 1, inProgress: 2, completed: 3 },
          agents: [],
        },
      },
    ],
    relations: [
      {
        id: 'r1',
        sourceNodeId: 'org:acme',
        targetNodeId: 'group:runtime',
        kind: 'contains',
        sourceKind: 'manual',
        weight: 1,
      },
      {
        id: 'r2',
        sourceNodeId: 'group:runtime',
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
      generatedAt: '2026-07-16T00:00:00.000Z',
    },
  };
  return buildOrganizationMapViewModel(payload);
}

describe('OrgOverviewHud', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    vi.spyOn(window, 'requestAnimationFrame').mockImplementation(() => 1);
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation(() => undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it('renders a semantic organization card in the dedicated overview and drills into groups', async () => {
    const onSelectNode = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<OrgOverviewHud viewModel={buildViewModel()} onSelectNode={onSelectNode} />);
      await Promise.resolve();
    });

    const card = host.querySelector<HTMLElement>('[data-organization-overview-card="acme"]');
    expect(host.querySelector('[data-organization-overview-grid]')).not.toBeNull();
    expect(card?.classList.contains('absolute')).toBe(false);
    expect(card?.textContent).toContain('Acme Platform');
    expect(card?.textContent).toContain('1 groups · 1 teams · 4 agents');
    expect(card?.textContent).toContain('2 active tasks');

    const group = Array.from(card?.querySelectorAll('button') ?? []).find((button) =>
      button.textContent?.includes('Runtime')
    );
    act(() => {
      group?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    expect(onSelectNode).toHaveBeenCalledWith('group:runtime', true);

    act(() => root.unmount());
  });
});
