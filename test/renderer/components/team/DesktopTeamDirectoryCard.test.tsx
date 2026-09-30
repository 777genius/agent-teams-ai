import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { ActiveTeamCard } from '@renderer/components/team/DesktopTeamDirectoryCard';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import type { TeamSummary } from '@shared/types';
import type { ComponentProps } from 'react';

vi.mock('@renderer/components/team/TeamStatusBadge', () => ({ TeamStatusBadge: () => null }));
vi.mock('@renderer/components/team/TeamTaskStatusSummary', () => ({
  TeamTaskStatusSummary: () => null,
}));

beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
});

afterEach(() => {
  document.body.replaceChildren();
  vi.unstubAllGlobals();
});

it('keeps keyboard activation of a row action separate from opening the team', async () => {
  const team: TeamSummary = {
    teamName: 'team-sandbox',
    displayName: 'Sandbox team',
    description: '',
    memberCount: 0,
    taskCount: 0,
    lastActivity: null,
    projectPath: '/tmp/sandbox-project',
  };
  const onOpenTeam = vi.fn();
  const onCopyTeam = vi.fn();
  const host = document.createElement('div');
  document.body.append(host);
  const root = createRoot(host);

  try {
    await act(async () => {
      root.render(
        <ActiveTeamCard
          team={team}
          status="offline"
          runtimeUnknown={false}
          unknownLabel=""
          teamColorSet={{ border: '#000', badge: '#000', text: '#000' }}
          isLight={false}
          matchesCurrentProject={false}
          currentProjectPath={null}
          launchingTeamName={null}
          isStopping={false}
          onOpenTeam={onOpenTeam}
          onLaunchTeam={vi.fn()}
          onStopTeam={vi.fn()}
          onCopyTeam={onCopyTeam}
          onDeleteTeam={vi.fn()}
          t={((key: string) => key) as ComponentProps<typeof ActiveTeamCard>['t']}
        />
      );
    });

    const copy = host.querySelector<HTMLButtonElement>('button[aria-label="list.actions.copyTeam"]');
    const open = host.querySelector<HTMLButtonElement>('button[aria-label="Sandbox team"]');
    expect(copy).not.toBeNull();
    expect(open).not.toBeNull();

    for (const key of ['Enter', ' ']) {
      await act(async () => {
        copy!.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
        copy!.click(); // happy-dom does not synthesize native keyboard button activation.
      });
    }

    expect(onCopyTeam).toHaveBeenCalledTimes(2);
    expect(onCopyTeam).toHaveBeenNthCalledWith(1, team.teamName, expect.anything());
    expect(onOpenTeam).not.toHaveBeenCalled();

    await act(async () => open!.click());
    expect(onOpenTeam).toHaveBeenCalledExactlyOnceWith(team.teamName, team.projectPath);
  } finally {
    act(() => root.unmount());
  }
});
