import {
  createTeamProvisioningProgressSlice,
  type TeamProvisioningProgressStoreState,
  type TeamProvisioningSurfaceSnapshot,
} from '@features/team-provisioning/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { MemberSpawnStatusEntry, TeamProvisioningProgress, TeamSummary } from '@shared/types';

const activeProgress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'sandbox-team',
  state: 'spawning',
  message: 'Starting',
  startedAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:01.000Z',
};

function createState(
  overrides: Partial<TeamProvisioningProgressStoreState> = {}
): TeamProvisioningProgressStoreState {
  return {
    currentProvisioningRunIdByTeam: {},
    currentRuntimeRunIdByTeam: {},
    ignoredProvisioningRunIds: {},
    ignoredRuntimeRunIds: {},
    memberSpawnSnapshotsByTeam: {},
    memberSpawnStatusesByTeam: {},
    provisioningErrorByTeam: {},
    provisioningRuns: {},
    provisioningSnapshotByTeam: {},
    provisioningStartedAtFloorByTeam: {},
    teamAgentRuntimeByTeam: {},
    ...overrides,
  };
}

function summary(): TeamSummary {
  return {
    teamName: 'sandbox-team',
    displayName: 'Sandbox Team',
    description: 'Test-only team',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
  };
}

function spawnStatus(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    updatedAt: '2026-07-23T10:00:01.000Z',
    ...overrides,
  };
}

function createHarness(
  initialState: TeamProvisioningProgressStoreState,
  surface: TeamProvisioningSurfaceSnapshot = {
    hasSelectedTeamData: false,
    selected: false,
    visible: false,
  }
) {
  let state = initialState;
  const analytics = {
    noteRefreshFanout: vi.fn(),
    recordStepTransition: vi.fn(),
    recordTerminalProgress: vi.fn(),
  };
  const refresh = {
    fetchMemberSpawnStatuses: vi.fn().mockResolvedValue(undefined),
    fetchTeamAgentRuntime: vi.fn().mockResolvedValue(undefined),
    fetchTeams: vi.fn().mockResolvedValue(undefined),
    getSurface: vi.fn(() => surface),
    refreshTeamData: vi.fn().mockResolvedValue(undefined),
    selectTeam: vi.fn().mockResolvedValue(undefined),
  };
  const runtime = {
    clearFreshness: vi.fn(),
  };
  const slice = createTeamProvisioningProgressSlice({
    analytics,
    refresh,
    runtime,
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
  });

  return {
    analytics,
    getState: () => state,
    refresh,
    runtime,
    slice,
  };
}

describe('createTeamProvisioningProgressSlice', () => {
  it('hydrates a visible team once and refreshes terminal runtime evidence', () => {
    const harness = createHarness(
      createState({
        currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
        provisioningRuns: { 'run-1': activeProgress },
      }),
      {
        hasSelectedTeamData: false,
        selected: true,
        visible: true,
      }
    );
    const ready = {
      ...activeProgress,
      state: 'ready' as const,
      configReady: true,
      message: 'Ready',
      updatedAt: '2026-07-23T10:00:02.000Z',
    };

    harness.slice.onProvisioningProgress(ready);

    expect(harness.analytics.recordStepTransition).toHaveBeenCalledWith(activeProgress, ready);
    expect(harness.analytics.recordTerminalProgress).toHaveBeenCalledWith(ready);
    expect(harness.refresh.selectTeam).toHaveBeenCalledTimes(1);
    expect(harness.refresh.selectTeam).toHaveBeenCalledWith('sandbox-team', {
      allowReloadWhileProvisioning: true,
    });
    expect(harness.refresh.refreshTeamData).not.toHaveBeenCalled();
    expect(harness.refresh.fetchTeams).toHaveBeenCalledTimes(1);
    expect(harness.refresh.fetchMemberSpawnStatuses).toHaveBeenCalledWith('sandbox-team');
    expect(harness.refresh.fetchTeamAgentRuntime).toHaveBeenCalledWith('sandbox-team');
    expect(harness.analytics.noteRefreshFanout).toHaveBeenCalledWith(
      expect.objectContaining({
        operation: 'refreshTeamData',
        phase: 'skipped',
        reason: 'provisioning:already-hydrated-visible-team',
      })
    );
  });

  it('retains only failed member evidence on terminal failure', () => {
    const errorStatus = spawnStatus({
      status: 'error',
      launchState: 'failed_to_start',
      error: 'Bootstrap failed',
    });
    const harness = createHarness(
      createState({
        currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
        memberSpawnSnapshotsByTeam: {
          'sandbox-team': {
            runId: 'run-1',
            statuses: {
              alice: errorStatus,
              bob: spawnStatus(),
            },
          },
        },
        memberSpawnStatusesByTeam: {
          'sandbox-team': {
            alice: errorStatus,
            bob: spawnStatus(),
          },
        },
        provisioningRuns: { 'run-1': activeProgress },
        provisioningSnapshotByTeam: { 'sandbox-team': summary() },
        teamAgentRuntimeByTeam: {
          'sandbox-team': {
            teamName: 'sandbox-team',
            updatedAt: '2026-07-23T10:00:01.000Z',
            runId: 'run-1',
            members: {},
          },
        },
      })
    );

    harness.slice.onProvisioningProgress({
      ...activeProgress,
      state: 'failed',
      message: 'Failed',
      updatedAt: '2026-07-23T10:00:02.000Z',
    });

    expect(harness.getState().memberSpawnStatusesByTeam).toEqual({
      'sandbox-team': { alice: errorStatus },
    });
    expect(harness.getState().memberSpawnSnapshotsByTeam).toHaveProperty('sandbox-team');
    expect(harness.getState().teamAgentRuntimeByTeam).toEqual({});
    expect(harness.getState().provisioningSnapshotByTeam).toEqual({});
    expect(harness.runtime.clearFreshness).toHaveBeenCalledWith('sandbox-team');
    expect(harness.refresh.fetchTeams).not.toHaveBeenCalled();
  });

  it('removes a stale run without firing analytics or refresh effects', () => {
    const current = { ...activeProgress, runId: 'run-current' };
    const harness = createHarness(
      createState({
        currentProvisioningRunIdByTeam: {
          'sandbox-team': current.runId,
        },
        provisioningRuns: {
          [current.runId]: current,
          'run-1': activeProgress,
        },
      })
    );

    harness.slice.onProvisioningProgress({
      ...activeProgress,
      message: 'Late stale event',
    });

    expect(harness.getState().provisioningRuns).toEqual({
      [current.runId]: current,
    });
    expect(harness.analytics.recordStepTransition).not.toHaveBeenCalled();
    expect(harness.analytics.recordTerminalProgress).not.toHaveBeenCalled();
    expect(harness.refresh.fetchTeams).not.toHaveBeenCalled();
  });
});
