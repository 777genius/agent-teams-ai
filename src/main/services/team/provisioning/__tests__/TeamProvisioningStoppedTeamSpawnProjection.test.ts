import { describe, expect, it } from 'vitest';

import {
  applyStoppedTeamSpawnProjection,
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
});
