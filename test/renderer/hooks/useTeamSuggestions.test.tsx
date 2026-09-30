import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { MentionSuggestion } from '@renderer/types/mention';
import type { TeamSummary } from '@shared/types';

const aliveListReadHarness = vi.hoisted(() => ({
  listAliveTeams: vi.fn<() => Promise<string[]>>(),
}));

vi.mock('@renderer/composition/team/createTeamAliveListReadPort', () => ({
  createTeamAliveListReadPort: () => ({
    listAliveTeams: aliveListReadHarness.listAliveTeams,
  }),
}));

const storeState = {
  teams: [] as TeamSummary[],
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

import {
  useTeamSuggestions,
  type UseTeamSuggestionsResult,
} from '@renderer/hooks/useTeamSuggestions';

interface HookProbeProps {
  currentTeamName: string | null;
  enabled?: boolean;
  onValue(value: UseTeamSuggestionsResult): void;
}

function HookProbe({
  currentTeamName,
  enabled,
  onValue,
}: HookProbeProps): React.JSX.Element | null {
  const value = useTeamSuggestions(currentTeamName, { enabled });
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

function makeTeam(teamName: string, overrides: Partial<TeamSummary> = {}): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    projectPath: `/workspace/${teamName}`,
    ...overrides,
  };
}

async function flushEffects(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useTeamSuggestions alive-team read port', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.teams = [];
    aliveListReadHarness.listAliveTeams.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('sorts the narrow-port alive result first and excludes current or deleted teams', async () => {
    storeState.teams = [
      makeTeam('team-alpha', { displayName: 'Alpha' }),
      makeTeam('team-beta', { displayName: 'Beta' }),
      makeTeam('team-gamma', { displayName: 'Gamma' }),
      makeTeam('team-deleted', {
        displayName: 'Deleted',
        deletedAt: '2026-07-30T00:00:00.000Z',
      }),
    ];
    aliveListReadHarness.listAliveTeams.mockResolvedValue(['team-gamma']);
    const observed: UseTeamSuggestionsResult[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          currentTeamName="team-alpha"
          onValue={(value) => {
            observed.push(value);
          }}
        />
      );
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledOnce();
    expect(
      observed
        .at(-1)
        ?.suggestions.map(
          (suggestion: MentionSuggestion) =>
            `${suggestion.id}:${suggestion.subtitle}:${suggestion.isOnline}`
        )
    ).toEqual(['team:team-gamma:online:true', 'team:team-beta:offline:false']);
    expect(observed.at(-1)?.loading).toBe(false);

    await act(async () => {
      root.unmount();
    });
  });

  it('keeps failures best-effort and retries when the team list changes', async () => {
    storeState.teams = [makeTeam('team-beta', { displayName: 'Beta' })];
    aliveListReadHarness.listAliveTeams
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['team-beta']);
    const observed: UseTeamSuggestionsResult[] = [];
    const onValue = (value: UseTeamSuggestionsResult): void => {
      observed.push(value);
    };
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(<HookProbe currentTeamName={null} onValue={onValue} />);
      await flushEffects();
    });

    expect(observed.at(-1)?.suggestions[0]).toMatchObject({
      id: 'team:team-beta',
      isOnline: false,
      subtitle: 'offline',
    });
    expect(observed.at(-1)?.loading).toBe(false);

    storeState.teams = [...storeState.teams, makeTeam('team-gamma', { displayName: 'Gamma' })];
    await act(async () => {
      root.render(<HookProbe currentTeamName={null} onValue={onValue} />);
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.suggestions[0]).toMatchObject({
      id: 'team:team-beta',
      isOnline: true,
      subtitle: 'online',
    });

    await act(async () => {
      root.unmount();
    });
  });

  it('does not read alive teams while suggestions are disabled', async () => {
    storeState.teams = [makeTeam('team-beta')];
    const observed: UseTeamSuggestionsResult[] = [];
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <HookProbe
          currentTeamName={null}
          enabled={false}
          onValue={(value) => {
            observed.push(value);
          }}
        />
      );
      await flushEffects();
    });

    expect(aliveListReadHarness.listAliveTeams).not.toHaveBeenCalled();
    expect(observed.at(-1)).toEqual({ suggestions: [], loading: false });

    await act(async () => {
      root.unmount();
    });
  });
});
