import { describe, expect, it } from 'vitest';

import {
  applyStoppedTeamSpawnProjection,
  maybeProjectStoppedCachedSpawnSnapshot,
  projectStoppedTeamSpawnStatuses,
  shouldProjectStoppedTeamSpawn,
} from '../TeamProvisioningStoppedTeamSpawnProjection';

import type { MemberSpawnStatusEntry } from '@shared/types';

function entry(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    agentToolAccepted: true,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    hardFailure: false,
    updatedAt: '2026-09-17T04:49:00.000Z',
    livenessSource: 'process',
    ...overrides,
  };
}

describe('TeamProvisioningStoppedTeamSpawnProjection', () => {
  it('projects only when freshness is stop and no run is tracked', () => {
    expect(shouldProjectStoppedTeamSpawn({ hasTrackedRun: false, freshnessKind: 'stop' })).toBe(
      true
    );
    expect(shouldProjectStoppedTeamSpawn({ hasTrackedRun: true, freshnessKind: 'stop' })).toBe(
      false
    );
    expect(
      shouldProjectStoppedTeamSpawn({
        hasTrackedRun: true,
        trackedRunId: 'run-1',
        freshnessKind: 'stop',
        stoppedRunId: 'run-1',
      })
    ).toBe(true);
    expect(
      shouldProjectStoppedTeamSpawn({
        hasTrackedRun: true,
        trackedRunId: 'run-2',
        freshnessKind: 'stop',
        stoppedRunId: 'run-1',
      })
    ).toBe(false);
    expect(shouldProjectStoppedTeamSpawn({ hasTrackedRun: false, freshnessKind: 'launch' })).toBe(
      false
    );
    expect(shouldProjectStoppedTeamSpawn({ hasTrackedRun: false, freshnessKind: null })).toBe(
      false
    );
  });

  it('forces leftover live members offline after stop', () => {
    const projected = projectStoppedTeamSpawnStatuses({
      alice: entry(),
      cody: entry({ status: 'waiting', launchState: 'runtime_pending_bootstrap' }),
      oscar: entry({
        status: 'skipped',
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
      }),
    });

    expect(projected.alice).toMatchObject({
      status: 'offline',
      runtimeAlive: false,
      livenessSource: undefined,
    });
    expect(projected.cody).toMatchObject({
      status: 'offline',
      runtimeAlive: false,
    });
    expect(projected.oscar).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      skippedForLaunch: true,
      runtimeAlive: false,
    });
  });

  it('applies the stop projection from freshness without a tracked run', async () => {
    const result = await applyStoppedTeamSpawnProjection(
      'mixed-v2150-20260917',
      false,
      { alice: entry() },
      async () => ({
        version: 1,
        teamName: 'mixed-v2150-20260917',
        kind: 'stop',
        stopId: 'stop-1',
      })
    );

    expect(result.stopped).toBe(true);
    expect(result.statuses.alice).toMatchObject({ status: 'offline', runtimeAlive: false });
  });

  it('does not project when a launch run is already tracked', async () => {
    const live = { alice: entry() };
    const result = await applyStoppedTeamSpawnProjection(
      'mixed-v2150-20260917',
      true,
      live,
      async () => ({
        version: 1,
        teamName: 'mixed-v2150-20260917',
        kind: 'stop',
        stopId: 'stop-1',
      })
    );

    expect(result).toEqual({ statuses: live, stopped: false });
  });

  it('projects leftover live members offline when the tracked run is the stopped run', async () => {
    const result = await applyStoppedTeamSpawnProjection(
      'mixed-v2150-20260917',
      true,
      { alice: entry() },
      async () => ({
        version: 1,
        teamName: 'mixed-v2150-20260917',
        kind: 'stop',
        stopId: 'stop-1',
        stoppedRunId: 'run-1',
      }),
      'run-1'
    );

    expect(result.stopped).toBe(true);
    expect(result.statuses.alice).toMatchObject({ status: 'offline', runtimeAlive: false });
  });

  it('does not project a new live run over a previous stop', async () => {
    const live = { alice: entry() };
    const result = await applyStoppedTeamSpawnProjection(
      'mixed-v2150-20260917',
      true,
      live,
      async () => ({
        version: 1,
        teamName: 'mixed-v2150-20260917',
        kind: 'stop',
        stopId: 'stop-1',
        stoppedRunId: 'run-1',
      }),
      'run-2'
    );

    expect(result).toEqual({ statuses: live, stopped: false });
  });

  it('projects a cached live snapshot offline after Stop without a run object', async () => {
    const snapshot = await maybeProjectStoppedCachedSpawnSnapshot({
      teamName: 'mixed-v2150-20260917',
      hasTrackedRun: false,
      snapshot: {
        statuses: { alice: entry() },
        runId: 'run-1',
        source: 'live',
        expectedMembers: ['alice'],
        teamLaunchState: 'clean_success',
      },
      readLaunchFreshness: async () => ({
        version: 1,
        teamName: 'mixed-v2150-20260917',
        kind: 'stop',
        stopId: 'stop-1',
      }),
      summarize: () => ({
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 0,
        skippedCount: 0,
        runtimeAlivePendingCount: 0,
        shellOnlyPendingCount: 0,
        runtimeProcessPendingCount: 0,
        runtimeCandidatePendingCount: 0,
        noRuntimePendingCount: 0,
        permissionPendingCount: 0,
      }),
      deriveTeamLaunchAggregateState: () => 'partial_pending',
    });

    expect(snapshot.statuses.alice).toMatchObject({ status: 'offline', runtimeAlive: false });
    expect(snapshot.teamLaunchState).toBe('partial_pending');
    expect(snapshot.runId).toBe('run-1');
  });
});
