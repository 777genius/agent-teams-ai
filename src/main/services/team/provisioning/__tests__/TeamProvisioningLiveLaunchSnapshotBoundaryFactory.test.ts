import { describe, expect, it, vi } from 'vitest';

import {
  createTeamProvisioningLiveLaunchSnapshotBoundary,
  createTeamProvisioningLiveLaunchSnapshotBoundaryDepsFromService,
} from '../TeamProvisioningLiveLaunchSnapshotBoundaryFactory';

import type {
  TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost,
  TeamProvisioningLiveLaunchSnapshotRun,
} from '../TeamProvisioningLiveLaunchSnapshotBoundaryFactory';
import type { MemberSpawnStatusEntry } from '@shared/types';

const NOW = '2026-07-03T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry> = {}): MemberSpawnStatusEntry {
  return {
    status: 'online',
    launchState: 'confirmed_alive',
    updatedAt: NOW,
    runtimeAlive: true,
    bootstrapConfirmed: true,
    livenessSource: 'heartbeat',
    ...overrides,
  };
}

function run(
  overrides: Partial<TeamProvisioningLiveLaunchSnapshotRun> = {}
): TeamProvisioningLiveLaunchSnapshotRun {
  return {
    runId: 'run-1',
    teamName: 'team-a',
    expectedMembers: ['Builder'],
    detectedSessionId: 'session-1',
    isLaunch: true,
    provisioningComplete: false,
    memberSpawnStatuses: new Map([['Builder', status()]]),
    ...overrides,
  };
}

function createBoundary(
  overrides: Partial<Parameters<typeof createTeamProvisioningLiveLaunchSnapshotBoundary>[0]> = {}
) {
  return createTeamProvisioningLiveLaunchSnapshotBoundary({
    getPersistedLaunchMemberNames: (snapshot) => snapshot.expectedMembers,
    pauseMemberTaskActivityForRuntimeLoss: vi.fn(),
    buildMixedPersistedLaunchSnapshotForRun: vi.fn(() => null),
    buildRuntimeSpawnStatusRecord: (targetRun) => Object.fromEntries(targetRun.memberSpawnStatuses),
    invalidateMemberSpawnStatusesCache: vi.fn(),
    emitTeamChange: vi.fn(),
    getRun: vi.fn(),
    maybeFireTeamLaunchedNotificationWhenAllMembersJoined: vi.fn(),
    ...overrides,
  });
}

describe('TeamProvisioningLiveLaunchSnapshotBoundaryFactory', () => {
  it('syncs live run member statuses from persisted snapshots and preserves pending restarts', () => {
    const targetRun = run({
      expectedMembers: ['Old'],
      memberSpawnStatuses: new Map([
        ['Builder', status({ runtimeAlive: true })],
        ['Reviewer', status({ runtimeAlive: true, updatedAt: 'before' })],
      ]),
      pendingMemberRestarts: new Map([['Reviewer', { reason: 'manual' }]]),
    });
    const pauseMemberTaskActivityForRuntimeLoss = vi.fn();
    const boundary = createBoundary({
      pauseMemberTaskActivityForRuntimeLoss,
      getPersistedLaunchMemberNames: () => ['Builder', 'Reviewer'],
    });
    const snapshot = boundary.buildLiveLaunchSnapshotForRun(
      run({
        expectedMembers: ['Builder', 'Reviewer'],
        memberSpawnStatuses: new Map([
          [
            'Builder',
            status({
              status: 'spawning',
              launchState: 'starting',
              runtimeAlive: false,
              bootstrapConfirmed: false,
              livenessSource: undefined,
              updatedAt: 'snapshot-time',
            }),
          ],
          ['Reviewer', status({ updatedAt: 'snapshot-reviewer' })],
        ]),
      }),
      'active'
    )!;

    boundary.syncRunMemberSpawnStatusesFromSnapshot(targetRun, snapshot);

    expect(targetRun.expectedMembers).toEqual(['Builder', 'Reviewer']);
    expect(targetRun.memberSpawnStatuses.get('Builder')).toMatchObject({
      launchState: 'starting',
      runtimeAlive: false,
    });
    expect(targetRun.memberSpawnStatuses.get('Reviewer')?.updatedAt).toBe('before');
    expect(pauseMemberTaskActivityForRuntimeLoss).toHaveBeenCalledWith(
      targetRun,
      'Builder',
      expect.objectContaining({ runtimeAlive: true }),
      expect.any(String)
    );
  });

  it('prefers mixed launch snapshots before building from runtime statuses', () => {
    const runtimeRun = run();
    const boundary = createBoundary();
    const mixedSnapshot = boundary.buildLiveLaunchSnapshotForRun(runtimeRun, 'active');
    const buildRuntimeSpawnStatusRecord = vi.fn();
    const buildMixedPersistedLaunchSnapshotForRun = vi.fn(() => mixedSnapshot);
    const mixedBoundary = createBoundary({
      buildMixedPersistedLaunchSnapshotForRun,
      buildRuntimeSpawnStatusRecord,
    });

    expect(mixedBoundary.buildLiveLaunchSnapshotForRun(runtimeRun, 'finished')).toBe(mixedSnapshot);
    expect(buildMixedPersistedLaunchSnapshotForRun).toHaveBeenCalledWith(runtimeRun, 'finished');
    expect(buildRuntimeSpawnStatusRecord).not.toHaveBeenCalled();
  });

  it('builds runtime snapshots only for launches with expected members', () => {
    const buildRuntimeSpawnStatusRecord = vi.fn((targetRun) =>
      Object.fromEntries(targetRun.memberSpawnStatuses)
    );
    const boundary = createBoundary({ buildRuntimeSpawnStatusRecord });

    expect(boundary.buildLiveLaunchSnapshotForRun(run({ isLaunch: false }), 'active')).toBeNull();
    expect(
      boundary.buildLiveLaunchSnapshotForRun(run({ expectedMembers: [] }), 'active')
    ).toBeNull();

    const snapshot = boundary.buildLiveLaunchSnapshotForRun(run(), 'finished');

    expect(snapshot).toMatchObject({
      teamName: 'team-a',
      leadSessionId: 'session-1',
      launchPhase: 'finished',
      expectedMembers: ['Builder'],
    });
    expect(buildRuntimeSpawnStatusRecord).toHaveBeenCalledTimes(1);
  });

  it('emits member spawn changes and checks launch notification readiness for the tracked run', () => {
    const trackedRun = run();
    const invalidateMemberSpawnStatusesCache = vi.fn();
    const emitTeamChange = vi.fn();
    const getRun = vi.fn(() => trackedRun);
    const maybeFireTeamLaunchedNotificationWhenAllMembersJoined = vi.fn(async () => undefined);
    const boundary = createBoundary({
      invalidateMemberSpawnStatusesCache,
      emitTeamChange,
      getRun,
      maybeFireTeamLaunchedNotificationWhenAllMembersJoined,
    });

    boundary.emitMemberSpawnChange({ teamName: 'team-a', runId: 'run-1' }, 'Builder');

    expect(invalidateMemberSpawnStatusesCache).toHaveBeenCalledWith('team-a');
    expect(emitTeamChange).toHaveBeenCalledWith({
      type: 'member-spawn',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'Builder',
    });
    expect(getRun).toHaveBeenCalledWith('run-1');
    expect(maybeFireTeamLaunchedNotificationWhenAllMembersJoined).toHaveBeenCalledWith(trackedRun);
  });

  it('does not check launch notification readiness for a different tracked team', () => {
    const maybeFireTeamLaunchedNotificationWhenAllMembersJoined = vi.fn(async () => undefined);
    const boundary = createBoundary({
      getRun: vi.fn(() => run({ teamName: 'other-team' })),
      maybeFireTeamLaunchedNotificationWhenAllMembersJoined,
    });

    boundary.emitMemberSpawnChange({ teamName: 'team-a', runId: 'run-1' }, 'Builder');

    expect(maybeFireTeamLaunchedNotificationWhenAllMembersJoined).not.toHaveBeenCalled();
  });

  it('builds boundary deps from service-shaped host wiring', async () => {
    const trackedRun = run();
    const teamChanges: Array<{
      type: 'member-spawn';
      teamName: string;
      runId: string;
      detail: string;
    }> = [];
    const service = {
      runs: new Map([[trackedRun.runId, trackedRun]]),
      pauseMemberTaskActivityForRuntimeLoss: vi.fn(),
      buildMixedPersistedLaunchSnapshotForRun: vi.fn(() => null),
      runtimeSnapshotCacheBoundary: {
        invalidateMemberSpawnStatusesCache: vi.fn(),
      },
      teamChangeEmitter: vi.fn((event) => {
        teamChanges.push(event);
      }),
      maybeFireTeamLaunchedNotificationWhenAllMembersJoined: vi.fn(async () => undefined),
    } as unknown as TeamProvisioningLiveLaunchSnapshotBoundaryServiceHost<TeamProvisioningLiveLaunchSnapshotRun>;
    const getPersistedLaunchMemberNames = vi.fn(() => ['Builder']);
    const buildRuntimeSpawnStatusRecord = vi.fn(
      (targetRun: TeamProvisioningLiveLaunchSnapshotRun) =>
        Object.fromEntries(targetRun.memberSpawnStatuses)
    );

    const deps = createTeamProvisioningLiveLaunchSnapshotBoundaryDepsFromService(service, {
      getPersistedLaunchMemberNames,
      buildRuntimeSpawnStatusRecord,
    });

    expect(deps.getPersistedLaunchMemberNames({ expectedMembers: ['Builder'] } as never)).toEqual([
      'Builder',
    ]);
    deps.pauseMemberTaskActivityForRuntimeLoss(
      trackedRun,
      'Builder',
      status(),
      '2026-07-03T00:01:00.000Z'
    );
    expect(deps.buildMixedPersistedLaunchSnapshotForRun(trackedRun, 'active')).toBeNull();
    expect(deps.buildRuntimeSpawnStatusRecord(trackedRun)).toEqual(
      Object.fromEntries(trackedRun.memberSpawnStatuses)
    );
    deps.invalidateMemberSpawnStatusesCache('team-a');
    deps.emitTeamChange({
      type: 'member-spawn',
      teamName: 'team-a',
      runId: 'run-1',
      detail: 'Builder',
    });
    await deps.maybeFireTeamLaunchedNotificationWhenAllMembersJoined(trackedRun);

    expect(deps.getRun(trackedRun.runId)).toBe(trackedRun);
    expect(service.pauseMemberTaskActivityForRuntimeLoss).toHaveBeenCalledWith(
      trackedRun,
      'Builder',
      expect.objectContaining({ status: 'online' }),
      '2026-07-03T00:01:00.000Z'
    );
    expect(
      service.runtimeSnapshotCacheBoundary.invalidateMemberSpawnStatusesCache
    ).toHaveBeenCalledWith('team-a');
    expect(teamChanges).toEqual([
      { type: 'member-spawn', teamName: 'team-a', runId: 'run-1', detail: 'Builder' },
    ]);
    expect(service.maybeFireTeamLaunchedNotificationWhenAllMembersJoined).toHaveBeenCalledWith(
      trackedRun
    );
  });
});
