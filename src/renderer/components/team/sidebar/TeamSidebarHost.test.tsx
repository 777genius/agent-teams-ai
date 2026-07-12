import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const hoisted = vi.hoisted(() => ({
  state: {
    messagesPanelMode: 'sidebar' as const,
    messagesPanelWidth: 360,
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: <T,>(selector: (state: typeof hoisted.state) => T): T => selector(hoisted.state),
}));

import { TeamSidebarHost } from './TeamSidebarHost';
import { resetTeamSidebarPortalManagerForTests } from './TeamSidebarPortalManager';

const mountedRoots: Root[] = [];

async function renderHost(reserveSpaceWithoutSource: boolean): Promise<HTMLElement> {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mountedRoots.push(root);

  await act(async () => {
    root.render(
      <TeamSidebarHost
        teamName="loading-team"
        surface="team"
        isActive
        isFocused
        reserveSpaceWithoutSource={reserveSpaceWithoutSource}
      >
        <div data-testid="sidebar-skeleton" />
      </TeamSidebarHost>
    );
    await Promise.resolve();
  });

  const host = container.querySelector<HTMLElement>('[data-team-sidebar-host="team"]');
  if (!host) throw new Error('Expected team sidebar host');
  return host;
}

describe('TeamSidebarHost', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    resetTeamSidebarPortalManagerForTests();
  });

  afterEach(() => {
    for (const root of mountedRoots.splice(0)) {
      act(() => root.unmount());
    }
    document.body.innerHTML = '';
    resetTeamSidebarPortalManagerForTests();
    vi.unstubAllGlobals();
  });

  it('reserves the configured sidebar width for a loading skeleton without a portal source', async () => {
    const host = await renderHost(true);

    expect(host.style.width).toBe('360px');
    expect(host.style.minWidth).toBe('360px');
    expect(host.querySelector('[data-testid="sidebar-skeleton"]')).not.toBeNull();
  });

  it('keeps regular portal hosts collapsed until a source is available', async () => {
    const host = await renderHost(false);

    expect(host.style.width).toBe('0px');
    expect(host.style.minWidth).toBe('0');
  });
});
