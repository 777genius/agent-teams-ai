import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { resetTeamSidebarPortalManagerForTests } from './sidebar/TeamSidebarPortalManager';
import {
  createDefaultMessagesSidebarUiState,
  setTeamMessagesSidebarUiState,
} from './sidebar/teamSidebarUiState';
import { TeamLoadingSkeleton } from './TeamLoadingSkeleton';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('./TeamProvisioningBanner', () => ({
  TeamProvisioningBanner: () => null,
}));

const hoisted = vi.hoisted(() => ({
  state: {
    messagesPanelMode: 'sidebar' as const,
    messagesPanelWidth: 360,
    teamByName: {} as Record<
      string,
      { leadName?: string; memberCount?: number; members?: { name: string }[] }
    >,
  },
}));

vi.mock('@renderer/store', () => ({
  useStore: <T,>(selector: (state: typeof hoisted.state) => T): T => selector(hoisted.state),
}));

afterEach(() => {
  document.body.innerHTML = '';
  hoisted.state.messagesPanelMode = 'sidebar';
  hoisted.state.teamByName = {};
  setTeamMessagesSidebarUiState('test-team', createDefaultMessagesSidebarUiState());
  resetTeamSidebarPortalManagerForTests();
});

const headerColorSet = {
  border: '#3b82f6',
  badge: 'rgba(59, 130, 246, 0.15)',
  text: '#60a5fa',
};

describe('TeamLoadingSkeleton Kanban', () => {
  it('uses the live five-column flat layout and shared card skeletons', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="inline"
          headerColorSet={headerColorSet}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const columns = Array.from(host.querySelectorAll<HTMLElement>('.kanban-column-glow'));
    expect(columns).toHaveLength(5);
    expect(
      columns.map((column) => column.style.getPropertyValue('--kanban-column-accent'))
    ).toEqual([
      'rgb(59, 130, 246)',
      'rgb(234, 179, 8)',
      'rgb(139, 92, 246)',
      'rgb(20, 184, 166)',
      'rgb(101, 163, 13)',
    ]);
    expect(columns.every((column) => column.className.includes('animate-pulse'))).toBe(true);
    expect(columns.every((column) => !column.className.includes('border'))).toBe(true);
    expect(columns.every((column) => !column.className.includes('rounded-md'))).toBe(true);

    const gridItems = columns.map((column) => column.parentElement!);
    const grid = gridItems[0]?.parentElement;
    const fullBleedWrapper = grid?.parentElement;
    expect(fullBleedWrapper?.className).toContain('-mx-4');
    expect(fullBleedWrapper?.className).toContain('w-[calc(100%+2rem)]');
    expect(gridItems.map((item) => item.style.gridColumn)).toEqual([
      '1 / span 4',
      '5 / span 4',
      '9 / span 4',
      '1 / span 6',
      '7 / span 6',
    ]);
    expect(gridItems.map((item) => item.style.gridRow)).toEqual([
      '1 / span 14',
      '1 / span 14',
      '1 / span 14',
      '15 / span 14',
      '15 / span 14',
    ]);
    expect(host.querySelectorAll('.kanban-column-header-glow')).toHaveLength(5);
    expect(host.querySelectorAll('.kanban-task-card-skeleton')).toHaveLength(8);
    const columnControls = Array.from(
      host.querySelectorAll<HTMLElement>('.kanban-column-glow > div > div.border-dashed')
    );
    expect(columnControls).toHaveLength(2);
    expect(columnControls.every((control) => control.classList.contains('mx-2'))).toBe(true);
    expect(
      columnControls.every(
        (control) => !Array.from(control.classList).some((className) => className.startsWith('w-['))
      )
    ).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows only the known lead plus teammates instead of extra placeholder members', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.state.teamByName = {
      'test-team': {
        leadName: 'team-lead',
        memberCount: 3,
        members: [{ name: 'alice' }, { name: 'cody' }, { name: 'oscar' }],
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="inline"
          headerColorSet={headerColorSet}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    expect(
      host
        .querySelector('[data-team-loading-member-count]')
        ?.getAttribute('data-team-loading-member-count')
    ).toBe('4');
    expect(host.querySelectorAll('[data-team-loading-member-row]')).toHaveLength(4);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('TeamLoadingSkeleton messages sidebar', () => {
  it('shows the chat-list skeleton by default', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.state.messagesPanelMode = 'sidebar';
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="sidebar"
          headerColorSet={headerColorSet}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const skeleton = host.querySelector('[data-messages-skeleton]');
    expect(skeleton?.getAttribute('data-messages-skeleton')).toBe('list');
    expect(skeleton?.getAttribute('data-messages-skeleton-title')).toBe('messages.title');
    expect(host.querySelector('.message-composer-flat-layout')).toBeNull();
    const logs = host.querySelector('[data-team-sidebar-logs]');
    expect(logs?.querySelector('.lucide-message-square')).toBeNull();
    expect(logs?.querySelector('.lucide-panel-left-close')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('uses the known member count for the chat-list placeholder', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.state.messagesPanelMode = 'sidebar';
    hoisted.state.teamByName = {
      'test-team': {
        leadName: 'team-lead',
        memberCount: 3,
        members: [{ name: 'alice' }, { name: 'cody' }, { name: 'oscar' }],
      },
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="sidebar"
          headerColorSet={headerColorSet}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const skeleton = host.querySelector('[data-messages-skeleton]');
    expect(skeleton?.getAttribute('data-messages-skeleton-members')).toBe('4');
    expect(
      host
        .querySelector('[data-team-loading-member-count]')
        ?.getAttribute('data-team-loading-member-count')
    ).toBe('4');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows the selected chat skeleton when a thread was already open', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    hoisted.state.messagesPanelMode = 'sidebar';
    setTeamMessagesSidebarUiState('test-team', {
      ...createDefaultMessagesSidebarUiState(),
      conversationSurface: 'thread',
      conversationScope: { kind: 'direct', participant: 'alice' },
    });
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="sidebar"
          headerColorSet={headerColorSet}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const skeleton = host.querySelector('[data-messages-skeleton]');
    expect(skeleton?.getAttribute('data-messages-skeleton')).toBe('thread');
    expect(skeleton?.getAttribute('data-messages-skeleton-title')).toBe('alice');
    expect(host.querySelector('.lucide-arrow-left')).not.toBeNull();
    expect(host.querySelector('.message-composer-flat-layout')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});

describe('TeamLoadingSkeleton sidebar', () => {
  it('keeps the logs strip at the bottom of the loading sidebar', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TeamLoadingSkeleton
          teamName="test-team"
          messagesPanelMode="sidebar"
          headerColorSet={{
            border: '#3b82f6',
            badge: 'rgba(59, 130, 246, 0.15)',
            text: '#60a5fa',
          }}
          isLight={false}
        />
      );
      await Promise.resolve();
    });

    const messages = host.querySelector('[data-team-sidebar-messages]');
    const logs = host.querySelector('[data-team-sidebar-logs]');
    expect(messages).not.toBeNull();
    expect(logs).not.toBeNull();
    expect(
      Boolean(messages!.compareDocumentPosition(logs!) & Node.DOCUMENT_POSITION_FOLLOWING)
    ).toBe(true);
    expect(logs!.querySelector('.lucide-message-square')).toBeNull();
    expect(logs!.querySelector('.lucide-panel-left-close')).not.toBeNull();
    expect(logs!.className).toContain('px-3');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
