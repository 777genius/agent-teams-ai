import {
  createTeamProvisioningControlSlice,
  type TeamProvisioningControlStoreState,
  type TeamProvisioningControlTransportPort,
} from '@features/team-provisioning/renderer';
import { describe, expect, it, vi } from 'vitest';

import type { TeamProvisioningProgress } from '@shared/types';

const progress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'sandbox-team',
  state: 'spawning',
  message: 'Starting',
  startedAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:01.000Z',
};

function createState(
  overrides: Partial<TeamProvisioningControlStoreState> = {}
): TeamProvisioningControlStoreState {
  return {
    activeToolsByTeam: {},
    currentProvisioningRunIdByTeam: {},
    currentRuntimeRunIdByTeam: {},
    finishedVisibleByTeam: {},
    ignoredProvisioningRunIds: {},
    ignoredRuntimeRunIds: {},
    memberSpawnSnapshotsByTeam: {},
    memberSpawnStatusesByTeam: {},
    provisioningProgressUnsubscribe: null,
    provisioningRuns: {},
    teamAgentRuntimeByTeam: {},
    toolHistoryByTeam: {},
    ...overrides,
  };
}

function createHarness(
  initialState = createState(),
  transportOverrides: Partial<TeamProvisioningControlTransportPort> = {}
) {
  let state = initialState;
  const applyProgress = vi.fn();
  const clearLaunchTracking = vi.fn();
  const clearRuntimeFreshness = vi.fn();
  const transport: TeamProvisioningControlTransportPort = {
    cancel: vi.fn().mockResolvedValue(undefined),
    getStatus: vi.fn().mockResolvedValue(progress),
    subscribe: vi.fn().mockReturnValue(null),
    ...transportOverrides,
  };
  const slice = createTeamProvisioningControlSlice({
    effects: {
      applyProgress,
      clearLaunchTracking,
      clearRuntimeFreshness,
    },
    state: {
      getState: () => state,
      setState: (update) => {
        const patch = typeof update === 'function' ? update(state) : update;
        state = { ...state, ...patch };
      },
    },
    transport,
  });
  state = { ...state, provisioningProgressUnsubscribe: slice.provisioningProgressUnsubscribe };

  return {
    applyProgress,
    clearLaunchTracking,
    clearRuntimeFreshness,
    getState: () => state,
    slice,
    transport,
  };
}

describe('createTeamProvisioningControlSlice', () => {
  it('loads status through the transport and applies the returned progress', async () => {
    const harness = createHarness();

    await expect(harness.slice.getProvisioningStatus('run-1')).resolves.toBe(progress);

    expect(harness.transport.getStatus).toHaveBeenCalledWith('run-1');
    expect(harness.applyProgress).toHaveBeenCalledWith(progress);
  });

  it('forwards cancellation without owning provisioning policy', async () => {
    const harness = createHarness();

    await harness.slice.cancelProvisioning('run-1');

    expect(harness.transport.cancel).toHaveBeenCalledWith('run-1');
  });

  it('clears canonical runtime state and tombstones late progress', () => {
    const harness = createHarness(
      createState({
        activeToolsByTeam: { 'sandbox-team': { lead: {} } },
        currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
        currentRuntimeRunIdByTeam: { 'sandbox-team': 'run-1' },
        finishedVisibleByTeam: { 'sandbox-team': { lead: {} } },
        memberSpawnSnapshotsByTeam: {
          'sandbox-team': { runId: 'run-1', statuses: {} },
        },
        memberSpawnStatusesByTeam: { 'sandbox-team': {} },
        provisioningRuns: { 'run-1': progress },
        teamAgentRuntimeByTeam: {
          'sandbox-team': {
            runId: 'run-1',
            teamName: 'sandbox-team',
            updatedAt: '2026-07-23T10:00:01.000Z',
            members: {},
          },
        },
        toolHistoryByTeam: { 'sandbox-team': { lead: [] } },
      })
    );

    harness.slice.clearMissingProvisioningRun('run-1');

    expect(harness.clearLaunchTracking).toHaveBeenCalledWith('run-1');
    expect(harness.clearRuntimeFreshness).toHaveBeenCalledWith('sandbox-team');
    expect(harness.getState()).toEqual(
      expect.objectContaining({
        activeToolsByTeam: {},
        currentProvisioningRunIdByTeam: {},
        currentRuntimeRunIdByTeam: {},
        finishedVisibleByTeam: {},
        ignoredProvisioningRunIds: { 'run-1': 'sandbox-team' },
        ignoredRuntimeRunIds: { 'run-1': 'sandbox-team' },
        memberSpawnSnapshotsByTeam: {},
        memberSpawnStatusesByTeam: {},
        provisioningRuns: {},
        teamAgentRuntimeByTeam: {},
        toolHistoryByTeam: {},
      })
    );
  });

  it('preserves current runtime state when clearing a stale provisioning run', () => {
    const harness = createHarness(
      createState({
        currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-current' },
        memberSpawnStatusesByTeam: { 'sandbox-team': {} },
        provisioningRuns: {
          'run-1': progress,
          'run-current': { ...progress, runId: 'run-current' },
        },
      })
    );

    harness.slice.clearMissingProvisioningRun('run-1');

    expect(harness.getState().currentProvisioningRunIdByTeam).toEqual({
      'sandbox-team': 'run-current',
    });
    expect(harness.getState().memberSpawnStatusesByTeam).toEqual({
      'sandbox-team': {},
    });
    expect(harness.clearRuntimeFreshness).not.toHaveBeenCalled();
  });

  it('subscribes idempotently, applies events, and unsubscribes once', () => {
    const unsubscribe = vi.fn();
    let listener: ((nextProgress: TeamProvisioningProgress) => void) | undefined;
    const subscribe = vi.fn((nextListener) => {
      listener = nextListener;
      return unsubscribe;
    });
    const harness = createHarness(createState(), { subscribe });

    harness.slice.subscribeProvisioningProgress();
    harness.slice.subscribeProvisioningProgress();
    listener?.(progress);
    harness.slice.unsubscribeProvisioningProgress();
    harness.slice.unsubscribeProvisioningProgress();

    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(harness.applyProgress).toHaveBeenCalledWith(progress);
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(harness.getState().provisioningProgressUnsubscribe).toBeNull();
  });
});
