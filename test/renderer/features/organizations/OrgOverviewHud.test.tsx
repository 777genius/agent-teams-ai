import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { OrgOverviewHud } from '@features/organizations/renderer/ui/OrgOverviewHud';
import { buildOrganizationMapViewModel } from '@features/organizations/renderer/view-models/organizationMapViewModel';
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

type ButtonActivation = 'click' | 'Enter' | 'Space';

async function activateNativeButton(
  button: HTMLButtonElement,
  activation: ButtonActivation
): Promise<void> {
  await act(async () => {
    button.focus();

    if (activation === 'click') {
      button.click();
    } else {
      // happy-dom dispatches key events but does not perform the native button default action.
      // Pair them with click() in browser order so a manual key handler would be caught as a duplicate.
      const key = activation === 'Enter' ? 'Enter' : ' ';
      const code = activation === 'Enter' ? 'Enter' : 'Space';
      const keyDown = new KeyboardEvent('keydown', {
        bubbles: true,
        cancelable: true,
        code,
        key,
      });

      expect(button.dispatchEvent(keyDown)).toBe(true);
      if (activation === 'Enter') button.click();

      const keyUp = new KeyboardEvent('keyup', {
        bubbles: true,
        cancelable: true,
        code,
        key,
      });
      expect(button.dispatchEvent(keyUp)).toBe(true);
      if (activation === 'Space') button.click();
    }

    await Promise.resolve();
  });
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

  it('renders a semantic organization card in the dedicated overview', async () => {
    const onSelectNode = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<OrgOverviewHud viewModel={buildViewModel()} onSelectNode={onSelectNode} />);
      await Promise.resolve();
    });

    const card = host.querySelector<HTMLElement>('[data-organization-overview-card="acme"]');
    expect(
      host
        .querySelector('[data-organization-overview-scroll]')
        ?.classList.contains('pointer-events-auto')
    ).toBe(true);
    expect(host.querySelector('[data-organization-overview-grid]')).not.toBeNull();
    expect(card?.tagName).toBe('ARTICLE');
    expect(card?.hasAttribute('role')).toBe(false);
    expect(card?.hasAttribute('tabindex')).toBe(false);
    expect(card?.classList.contains('absolute')).toBe(false);
    expect(card?.textContent).toContain('Acme Platform');
    expect(card?.textContent).toContain('1 groups · 1 teams · 4 agents');
    expect(card?.textContent).toContain('2 active tasks');

    const selectButton = card?.querySelector<HTMLButtonElement>(
      '[data-organization-overview-select="acme"]'
    );
    expect(selectButton?.type).toBe('button');
    expect(selectButton?.getAttribute('aria-label')).toBe('Acme Platform');

    act(() => root.unmount());
  });

  it('uses one native activation for card and nested group click, Enter, and Space', async () => {
    const onSelectNode = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<OrgOverviewHud viewModel={buildViewModel()} onSelectNode={onSelectNode} />);
      await Promise.resolve();
    });

    const card = host.querySelector<HTMLElement>('[data-organization-overview-card="acme"]');
    const selectButton = card?.querySelector<HTMLButtonElement>(
      '[data-organization-overview-select="acme"]'
    );
    const groupButton = Array.from(card?.querySelectorAll<HTMLButtonElement>('button') ?? []).find(
      (button) => button.textContent?.includes('Runtime')
    );

    expect(selectButton).toBeInstanceOf(HTMLButtonElement);
    expect(groupButton).toBeInstanceOf(HTMLButtonElement);

    for (const activation of ['click', 'Enter', 'Space'] as const) {
      onSelectNode.mockClear();
      await activateNativeButton(selectButton!, activation);
      expect(onSelectNode, `card ${activation} activation`).toHaveBeenCalledTimes(1);
      expect(onSelectNode).toHaveBeenCalledWith('org:acme', true);
    }

    for (const activation of ['click', 'Enter', 'Space'] as const) {
      onSelectNode.mockClear();
      await activateNativeButton(groupButton!, activation);
      expect(onSelectNode, `nested group ${activation} activation`).toHaveBeenCalledTimes(1);
      expect(onSelectNode).toHaveBeenCalledWith('group:runtime', true);
      expect(onSelectNode).not.toHaveBeenCalledWith('org:acme', true);
    }

    act(() => root.unmount());
  });
});
