import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { buildOrganizationMapViewModel } from '@features/organizations/renderer/adapters/organizationMapViewModel';
import { OrgGraphSurface } from '@features/organizations/renderer/ui/OrgGraphSurface';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OrganizationMapPayload } from '@features/organizations/contracts';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
  }),
}));

vi.mock('@claude-teams/agent-graph', () => ({
  GraphView: ({ renderTopToolbarContent }: { renderTopToolbarContent?: () => React.ReactNode }) => (
    <div>{renderTopToolbarContent?.()}</div>
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
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('renders the layout switch inside the centered relation toolbar', async () => {
    const onLayoutModeChange = vi.fn();
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
          onRevealNode={vi.fn()}
          onToggleNodeCollapse={vi.fn()}
        />
      );
      await Promise.resolve();
    });

    const switchButton = host.querySelector<HTMLButtonElement>(
      'button[aria-label="organizations.graph.layout.switchToNested"]'
    );
    expect(switchButton).not.toBeNull();

    await act(async () => {
      switchButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });
    expect(onLayoutModeChange).toHaveBeenCalledWith('grid-under-lead');

    await act(async () => root.unmount());
  });
});
