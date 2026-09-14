import React, { act, useEffect } from 'react';
import { createRoot, type Root } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask, TeamSummary } from '@shared/types';

const aliveListReadHarness = vi.hoisted(() => ({
  listAliveTeams: vi.fn<() => Promise<string[]>>(),
}));

const storeState = vi.hoisted(() => ({
  teams: [] as TeamSummary[],
  globalTasks: [] as GlobalTask[],
  globalTasksInitialized: true,
  globalTasksLoading: false,
  fetchAllTasks: vi.fn(),
  openTeamTab: vi.fn(),
  provisioningRuns: {},
  currentProvisioningRunIdByTeam: {},
  provisioningSnapshotByTeam: {},
  leadActivityByTeam: {},
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock('@renderer/composition/team/createTeamAliveListReadPort', () => ({
  createTeamAliveListReadPort: () => ({
    listAliveTeams: aliveListReadHarness.listAliveTeams,
  }),
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  getCurrentProvisioningProgressForTeam: () => null,
  isTeamProvisioningActive: () => false,
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

import { useRunningTeamsSection } from '@features/running-teams/renderer/hooks/useRunningTeamsSection';

type RunningTeamsSectionValue = ReturnType<typeof useRunningTeamsSection>;

interface HookProbeProps {
  searchQuery: string;
  onValue(value: RunningTeamsSectionValue): void;
}

function HookProbe({ searchQuery, onValue }: HookProbeProps): React.JSX.Element | null {
  const value = useRunningTeamsSection(searchQuery);
  useEffect(() => {
    onValue(value);
  }, [onValue, value]);
  return null;
}

function team(teamName: string): TeamSummary {
  return {
    teamName,
    displayName: teamName,
    description: '',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
    projectPath: `/tmp/${teamName}`,
  };
}

async function flushPromises(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('useRunningTeamsSection alive-team read port', () => {
  let host: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    aliveListReadHarness.listAliveTeams.mockReset();
    aliveListReadHarness.listAliveTeams.mockResolvedValue([]);
    storeState.teams = [];
    storeState.globalTasks = [];
    storeState.globalTasksInitialized = true;
    storeState.globalTasksLoading = false;
    storeState.provisioningRuns = {};
    storeState.currentProvisioningRunIdByTeam = {};
    storeState.provisioningSnapshotByTeam = {};
    storeState.leadActivityByTeam = {};
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(() => {
    act(() => {
      root.unmount();
    });
    host.remove();
    vi.unstubAllGlobals();
  });

  it('uses the narrow alive-team port to classify running rows', async () => {
    storeState.teams = [team('team-alpha'), team('team-beta')];
    aliveListReadHarness.listAliveTeams.mockResolvedValue(['team-beta']);
    const observed: RunningTeamsSectionValue[] = [];
    const onValue = (value: RunningTeamsSectionValue): void => {
      observed.push(value);
    };

    await act(async () => {
      root.render(<HookProbe searchQuery="" onValue={onValue} />);
      await flushPromises();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledOnce();
    expect(observed.at(-1)?.rows).toEqual([
      expect.objectContaining({ teamName: 'team-beta', status: 'idle' }),
    ]);
    expect(observed.at(-1)?.hidden).toBe(false);
  });

  it('keeps alive reads best-effort and retries when the team list changes', async () => {
    storeState.teams = [team('team-alpha')];
    aliveListReadHarness.listAliveTeams
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(['team-beta']);
    const observed: RunningTeamsSectionValue[] = [];
    const onValue = (value: RunningTeamsSectionValue): void => {
      observed.push(value);
    };

    await act(async () => {
      root.render(<HookProbe searchQuery="find" onValue={onValue} />);
      await flushPromises();
    });

    expect(aliveListReadHarness.listAliveTeams).not.toHaveBeenCalled();
    expect(observed.at(-1)?.hidden).toBe(true);

    await act(async () => {
      root.render(<HookProbe searchQuery="" onValue={onValue} />);
      await flushPromises();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledOnce();
    expect(observed.at(-1)?.rows).toEqual([]);

    storeState.teams = [...storeState.teams, team('team-beta')];
    await act(async () => {
      root.render(<HookProbe searchQuery="" onValue={onValue} />);
      await flushPromises();
    });

    expect(aliveListReadHarness.listAliveTeams).toHaveBeenCalledTimes(2);
    expect(observed.at(-1)?.rows).toEqual([
      expect.objectContaining({ teamName: 'team-beta', status: 'idle' }),
    ]);
  });
});
