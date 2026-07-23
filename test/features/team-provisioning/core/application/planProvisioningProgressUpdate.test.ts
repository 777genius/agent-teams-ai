import {
  planProvisioningProgressUpdate,
  type TeamProvisioningProgressState,
} from '@features/team-provisioning';
import { describe, expect, it } from 'vitest';

import type { TeamProvisioningProgress, TeamSummary } from '@shared/types';

const baseProgress: TeamProvisioningProgress = {
  runId: 'run-1',
  teamName: 'sandbox-team',
  state: 'spawning',
  message: 'Starting',
  startedAt: '2026-07-23T10:00:00.000Z',
  updatedAt: '2026-07-23T10:00:01.000Z',
};

function createState(
  overrides: Partial<TeamProvisioningProgressState> = {}
): TeamProvisioningProgressState {
  return {
    currentProvisioningRunIdByTeam: {},
    currentRuntimeRunIdByTeam: {},
    ignoredProvisioningRunIds: {},
    ignoredRuntimeRunIds: {},
    provisioningErrorByTeam: {},
    provisioningRuns: {},
    provisioningSnapshotByTeam: {},
    provisioningStartedAtFloorByTeam: {},
    ...overrides,
  };
}

function teamSummary(): TeamSummary {
  return {
    teamName: 'sandbox-team',
    displayName: 'Sandbox Team',
    description: 'Test-only team',
    memberCount: 1,
    taskCount: 0,
    lastActivity: null,
  };
}

describe('planProvisioningProgressUpdate', () => {
  it.each([
    {
      label: 'provisioning tombstone',
      state: createState({
        ignoredProvisioningRunIds: { 'run-1': 'sandbox-team' },
      }),
    },
    {
      label: 'runtime tombstone',
      state: createState({
        ignoredRuntimeRunIds: { 'run-1': 'sandbox-team' },
      }),
    },
    {
      label: 'launch timestamp floor',
      state: createState({
        provisioningStartedAtFloorByTeam: {
          'sandbox-team': '2026-07-23T10:00:01.000Z',
        },
      }),
    },
  ])('ignores progress rejected by the $label', ({ state }) => {
    expect(planProvisioningProgressUpdate(state, baseProgress)).toEqual({
      kind: 'ignored',
    });
  });

  it('suppresses duplicate payloads even when only updatedAt changes', () => {
    const state = createState({
      currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
      provisioningRuns: { 'run-1': baseProgress },
    });

    expect(
      planProvisioningProgressUpdate(state, {
        ...baseProgress,
        updatedAt: '2026-07-23T10:00:02.000Z',
      })
    ).toEqual({ kind: 'ignored' });
  });

  it('prevents terminal state regression for the canonical run', () => {
    const ready = { ...baseProgress, state: 'ready' as const };
    const state = createState({
      currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
      provisioningRuns: { 'run-1': ready },
    });

    expect(planProvisioningProgressUpdate(state, baseProgress)).toEqual({
      kind: 'ignored',
    });
  });

  it('atomically replaces an optimistic pending run with the real run', () => {
    const pending = { ...baseProgress, runId: 'pending:sandbox-team:1' };
    const state = createState({
      currentProvisioningRunIdByTeam: {
        'sandbox-team': pending.runId,
      },
      provisioningRuns: { [pending.runId]: pending },
    });

    const plan = planProvisioningProgressUpdate(state, baseProgress);

    expect(plan.kind).toBe('canonical-progress');
    if (plan.kind !== 'canonical-progress') return;
    expect(plan.stateUpdate.currentProvisioningRunIdByTeam).toEqual({
      'sandbox-team': 'run-1',
    });
    expect(plan.stateUpdate.provisioningRuns).toEqual({
      'run-1': baseProgress,
    });
  });

  it('removes stale stored progress without changing the canonical run', () => {
    const current = { ...baseProgress, runId: 'run-current' };
    const state = createState({
      currentProvisioningRunIdByTeam: {
        'sandbox-team': current.runId,
      },
      provisioningRuns: {
        [current.runId]: current,
        'run-1': baseProgress,
      },
    });

    expect(
      planProvisioningProgressUpdate(state, {
        ...baseProgress,
        message: 'Late stale event',
      })
    ).toEqual({
      kind: 'stale-run-removed',
      stateUpdate: {
        provisioningRuns: { [current.runId]: current },
      },
    });
  });

  it('records failure and removes the synthetic provisioning snapshot', () => {
    const state = createState({
      provisioningSnapshotByTeam: {
        'sandbox-team': teamSummary(),
      },
    });
    const failed = {
      ...baseProgress,
      state: 'failed' as const,
      error: 'Launch failed',
    };

    const plan = planProvisioningProgressUpdate(state, failed);

    expect(plan.kind).toBe('canonical-progress');
    if (plan.kind !== 'canonical-progress') return;
    expect(plan.stateUpdate.provisioningErrorByTeam).toEqual({
      'sandbox-team': 'Launch failed',
    });
    expect(plan.stateUpdate.provisioningSnapshotByTeam).toEqual({});
  });

  it('reports config readiness only on the transition to ready evidence', () => {
    const state = createState({
      currentProvisioningRunIdByTeam: { 'sandbox-team': 'run-1' },
      provisioningRuns: { 'run-1': baseProgress },
    });

    const plan = planProvisioningProgressUpdate(state, {
      ...baseProgress,
      configReady: true,
    });

    expect(plan).toMatchObject({
      kind: 'canonical-progress',
      becameConfigReady: true,
    });
  });
});
