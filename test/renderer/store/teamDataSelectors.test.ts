import { describe, expect, it } from 'vitest';

import {
  selectTeamDataForName,
  selectTeamIsAliveForName,
  selectTeamMemberSnapshotsForName,
  selectTeamTasksForName,
  type TeamDataSelectorState,
} from '../../../src/renderer/store/team/teamDataSelectors';

import type { TeamViewSnapshot } from '../../../src/shared/types';

function createSnapshot(overrides: Partial<TeamViewSnapshot> = {}): TeamViewSnapshot {
  return {
    teamName: 'my-team',
    config: { name: 'My Team' },
    members: [],
    tasks: [],
    kanbanState: { teamName: 'my-team', reviewers: [], tasks: {} },
    processes: [],
    ...overrides,
  };
}

function createState(overrides: Partial<TeamDataSelectorState> = {}): TeamDataSelectorState {
  return {
    teamDataCacheByName: {},
    selectedTeamName: null,
    selectedTeamData: null,
    ...overrides,
  };
}

describe('teamDataSelectors', () => {
  it('returns null when no team name is selected or cached', () => {
    const state = createState();

    expect(selectTeamDataForName(state, null)).toBeNull();
    expect(selectTeamDataForName(state, undefined)).toBeNull();
    expect(selectTeamDataForName(state, 'missing-team')).toBeNull();
  });

  it('prefers selected team data over cached data for the active team', () => {
    const cachedSnapshot = createSnapshot({ teamName: 'my-team', isAlive: false });
    const selectedSnapshot = createSnapshot({ teamName: 'my-team', isAlive: true });
    const state = createState({
      selectedTeamName: 'my-team',
      selectedTeamData: selectedSnapshot,
      teamDataCacheByName: {
        'my-team': cachedSnapshot,
      },
    });

    expect(selectTeamDataForName(state, 'my-team')).toBe(selectedSnapshot);
  });

  it('falls back to cached team data outside the selected snapshot', () => {
    const cachedSnapshot = createSnapshot({ teamName: 'cached-team', isAlive: true });
    const state = createState({
      selectedTeamName: 'other-team',
      selectedTeamData: createSnapshot({ teamName: 'other-team' }),
      teamDataCacheByName: {
        'cached-team': cachedSnapshot,
      },
    });

    expect(selectTeamDataForName(state, 'cached-team')).toBe(cachedSnapshot);
  });

  it('returns stable empty arrays and scalar fields from team snapshots', () => {
    const task = { id: 'task-1', subject: 'Build', status: 'pending' as const };
    const member = { name: 'alice', role: 'developer', currentTaskId: null, taskCount: 0 };
    const state = createState({
      teamDataCacheByName: {
        'my-team': createSnapshot({
          members: [member],
          tasks: [task],
          isAlive: true,
        }),
      },
    });

    expect(selectTeamMemberSnapshotsForName(state, 'my-team')).toEqual([member]);
    expect(selectTeamTasksForName(state, 'my-team')).toEqual([task]);
    expect(selectTeamIsAliveForName(state, 'my-team')).toBe(true);

    expect(selectTeamMemberSnapshotsForName(state, 'missing-team')).toBe(
      selectTeamMemberSnapshotsForName(state, 'missing-team')
    );
    expect(selectTeamTasksForName(state, 'missing-team')).toBe(
      selectTeamTasksForName(state, 'missing-team')
    );
    expect(selectTeamIsAliveForName(state, 'missing-team')).toBeUndefined();
  });
});
