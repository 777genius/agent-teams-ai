import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { ResolvedTeamMember } from '@shared/types';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  removedAt: undefined,
};

const storeState = {
  selectedTeamData: {
    members: [member],
    isAlive: true,
    tasks: [],
  },
  selectedTeamName: 'northstar-core',
  memberSpawnStatusesByTeam: {
    'northstar-core': {
      alice: {
        status: 'spawning',
        launchState: 'starting',
        updatedAt: '2026-04-09T10:00:00.000Z',
        runtimeAlive: false,
      },
    },
  },
  leadActivityByTeam: {},
  openMemberProfile: vi.fn(),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/hover-card', () => ({
  HoverCard: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
  HoverCardTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  HoverCardContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/members/CurrentTaskIndicator', () => ({
  CurrentTaskIndicator: () => null,
}));

import { MemberHoverCard } from '@renderer/components/team/members/MemberHoverCard';

describe('MemberHoverCard spawn-aware presence', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    storeState.selectedTeamData.members = [member];
    storeState.selectedTeamData.isAlive = true;
    storeState.selectedTeamData.tasks = [];
    storeState.selectedTeamName = 'northstar-core';
    storeState.memberSpawnStatusesByTeam['northstar-core'].alice = {
      status: 'spawning',
      launchState: 'starting',
      updatedAt: '2026-04-09T10:00:00.000Z',
      runtimeAlive: false,
    };
    storeState.openMemberProfile.mockReset();
  });

  it('shows starting from the team spawn snapshot even when provisioning is no longer active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberHoverCard, {
          name: 'alice',
          children: React.createElement('button', { type: 'button' }, 'alice'),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('starting');
    expect(host.textContent).not.toContain('idle');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
