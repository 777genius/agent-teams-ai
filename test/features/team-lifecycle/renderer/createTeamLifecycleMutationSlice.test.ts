import {
  createTeamLifecycleMutationCleanup,
  createTeamLifecycleMutationSlice,
  type TeamLifecycleMutationKind,
  type TeamLifecycleMutationSelectionState,
} from '@features/team-lifecycle/renderer';
import { describe, expect, it, vi } from 'vitest';

interface TestState extends TeamLifecycleMutationSelectionState {
  cacheState: 'present' | 'cleared';
  tombstoneState: 'missing' | 'set';
}

interface AnalyticsContext {
  teamName: string;
}

function createState(overrides: Partial<TestState> = {}): TestState {
  return {
    cacheState: 'present',
    selectedTeamData: { teamName: 'sandbox-team' },
    selectedTeamError: 'Old error',
    selectedTeamLoading: true,
    selectedTeamName: 'sandbox-team',
    tombstoneState: 'missing',
    ...overrides,
  };
}

describe('createTeamLifecycleMutationCleanup', () => {
  it('clears the selected loading surface only for soft delete', () => {
    const cleanup = createTeamLifecycleMutationCleanup<TestState>({
      buildProgressTombstones: () => ({ tombstoneState: 'set' }),
      collectStateRemovals: () => ({ cacheState: 'cleared' }),
      resetScope: vi.fn(),
    });
    const state = createState();

    const softDelete = cleanup.projectState(
      state,
      'sandbox-team',
      'soft-delete',
      '2026-07-23T10:00:00.000Z'
    );
    const permanentDelete = cleanup.projectState(
      state,
      'sandbox-team',
      'permanent-delete',
      '2026-07-23T10:00:00.000Z'
    );

    expect(softDelete).toEqual({
      cacheState: 'cleared',
      selectedTeamData: null,
      selectedTeamError: null,
      selectedTeamLoading: false,
      selectedTeamName: null,
      tombstoneState: 'set',
    });
    expect(permanentDelete).toEqual({
      cacheState: 'cleared',
      selectedTeamData: null,
      selectedTeamError: null,
      selectedTeamName: null,
      tombstoneState: 'set',
    });
    expect(permanentDelete).not.toHaveProperty('selectedTeamLoading');
  });

  it('keeps restore selection intact and returns tombstones when no scoped state exists', () => {
    const cleanup = createTeamLifecycleMutationCleanup<TestState>({
      buildProgressTombstones: () => ({ tombstoneState: 'set' }),
      collectStateRemovals: () => ({}),
      resetScope: vi.fn(),
    });

    const patch = cleanup.projectState(
      createState(),
      'sandbox-team',
      'restore',
      '2026-07-23T10:00:00.000Z'
    );

    expect(patch).toEqual({ tombstoneState: 'set' });
    expect(patch).not.toHaveProperty('selectedTeamName');
  });
});

function createHarness(
  options: {
    failMutation?: TeamLifecycleMutationKind;
    failRefresh?: boolean;
  } = {}
) {
  let state = createState({
    selectedTeamData: null,
    selectedTeamError: null,
    selectedTeamLoading: false,
    selectedTeamName: null,
  });
  const events: string[] = [];
  const analytics = {
    captureSoftDelete: vi.fn((teamName: string): AnalyticsContext => {
      events.push('analytics:capture');
      return { teamName };
    }),
    recordSoftDeleteFailure: vi.fn(() => {
      events.push('analytics:failure');
    }),
    recordSoftDeleteSuccess: vi.fn(() => {
      events.push('analytics:success');
    }),
  };
  const mutationFailure = new Error('mutation failed');
  const refreshFailure = new Error('team refresh failed');
  const transportCall = (mutation: TeamLifecycleMutationKind) => {
    events.push(`transport:${mutation}`);
    return options.failMutation === mutation ? Promise.reject(mutationFailure) : Promise.resolve();
  };
  const cleanup = {
    projectState: vi.fn(
      (
        _state: TestState,
        _teamName: string,
        mutation: TeamLifecycleMutationKind
      ): Partial<TestState> => {
        events.push(`cleanup:project:${mutation}`);
        return { cacheState: 'cleared', tombstoneState: 'set' };
      }
    ),
    resetScope: vi.fn((_teamName: string, mutation: TeamLifecycleMutationKind) => {
      events.push(`cleanup:reset:${mutation}`);
    }),
  };
  const fetchAllTasks = vi.fn(() => {
    events.push('refresh:tasks');
    return Promise.resolve();
  });
  const fetchTeams = vi.fn(() => {
    events.push('refresh:teams');
    return options.failRefresh ? Promise.reject(refreshFailure) : Promise.resolve();
  });
  const slice = createTeamLifecycleMutationSlice<TestState, AnalyticsContext>({
    analytics,
    cleanup,
    clock: {
      nowIso: () => {
        events.push('clock');
        return '2026-07-23T10:00:00.000Z';
      },
    },
    refresh: {
      fetchAllTasks,
      fetchTeams,
    },
    state: {
      setState: (update) => {
        const patch = update(state);
        events.push('state');
        state = { ...state, ...patch };
      },
    },
    transport: {
      permanentlyDelete: () => transportCall('permanent-delete'),
      restore: () => transportCall('restore'),
      softDelete: () => transportCall('soft-delete'),
    },
  });

  return {
    analytics,
    events,
    fetchAllTasks,
    fetchTeams,
    getState: () => state,
    mutationFailure,
    refreshFailure,
    slice,
  };
}

describe('createTeamLifecycleMutationSlice', () => {
  it('runs soft-delete analytics, cleanup, state, and refresh in the legacy order', async () => {
    const harness = createHarness();

    await harness.slice.deleteTeam('sandbox-team');

    expect(harness.events).toEqual([
      'analytics:capture',
      'transport:soft-delete',
      'analytics:success',
      'cleanup:reset:soft-delete',
      'clock',
      'cleanup:project:soft-delete',
      'state',
      'refresh:teams',
      'refresh:tasks',
    ]);
    expect(harness.getState()).toEqual(
      expect.objectContaining({
        cacheState: 'cleared',
        tombstoneState: 'set',
      })
    );
  });

  it('does not clean up or refresh when soft-delete transport fails', async () => {
    const harness = createHarness({ failMutation: 'soft-delete' });

    await expect(harness.slice.deleteTeam('sandbox-team')).rejects.toBe(harness.mutationFailure);

    expect(harness.events).toEqual([
      'analytics:capture',
      'transport:soft-delete',
      'analytics:failure',
    ]);
    expect(harness.getState().cacheState).toBe('present');
    expect(harness.fetchTeams).not.toHaveBeenCalled();
    expect(harness.fetchAllTasks).not.toHaveBeenCalled();
  });

  it.each(['restore', 'permanent-delete'] as const)(
    'uses the same post-success pipeline for %s',
    async (mutation) => {
      const harness = createHarness();

      if (mutation === 'restore') {
        await harness.slice.restoreTeam('sandbox-team');
      } else {
        await harness.slice.permanentlyDeleteTeam('sandbox-team');
      }

      expect(harness.events).toEqual([
        `transport:${mutation}`,
        `cleanup:reset:${mutation}`,
        'clock',
        `cleanup:project:${mutation}`,
        'state',
        'refresh:teams',
        'refresh:tasks',
      ]);
      expect(harness.analytics.captureSoftDelete).not.toHaveBeenCalled();
    }
  );

  it('does not run the task refresh or failure analytics when team refresh fails', async () => {
    const harness = createHarness({ failRefresh: true });

    await expect(harness.slice.deleteTeam('sandbox-team')).rejects.toBe(harness.refreshFailure);

    expect(harness.analytics.recordSoftDeleteSuccess).toHaveBeenCalledTimes(1);
    expect(harness.analytics.recordSoftDeleteFailure).not.toHaveBeenCalled();
    expect(harness.fetchAllTasks).not.toHaveBeenCalled();
    expect(harness.getState().cacheState).toBe('cleared');
  });
});
