import { describe, expect, it } from 'vitest';

import {
  buildAggregatePendingLaunchMessage,
  buildPendingBootstrapStatusMessage,
  countRunPermissionPendingMembers,
  countSnapshotPermissionPendingMembers,
  hasPendingLaunchMembers,
} from '../TeamProvisioningLaunchPendingMessage';

import type {
  MemberSpawnStatusEntry,
  PersistedTeamLaunchMemberState,
  PersistedTeamLaunchSnapshot,
} from '@shared/types';

const ISO = '2026-01-01T00:00:00.000Z';

function status(overrides: Partial<MemberSpawnStatusEntry>): MemberSpawnStatusEntry {
  return {
    status: 'waiting',
    launchState: 'starting',
    updatedAt: ISO,
    ...overrides,
  };
}

function persistedMember(
  name: string,
  overrides: Partial<PersistedTeamLaunchMemberState>
): PersistedTeamLaunchMemberState {
  return {
    name,
    launchState: 'starting',
    agentToolAccepted: false,
    runtimeAlive: false,
    bootstrapConfirmed: false,
    hardFailure: false,
    lastEvaluatedAt: ISO,
    ...overrides,
  };
}

function snapshot(params: {
  expectedMembers: string[];
  bootstrapExpectedMembers?: string[];
  members: Record<string, PersistedTeamLaunchMemberState>;
}): PersistedTeamLaunchSnapshot {
  return {
    version: 2,
    teamName: 'launch-team',
    updatedAt: ISO,
    launchPhase: 'active',
    expectedMembers: params.expectedMembers,
    bootstrapExpectedMembers: params.bootstrapExpectedMembers,
    members: params.members,
    summary: {
      confirmedCount: 0,
      pendingCount: 0,
      failedCount: 0,
      runtimeAlivePendingCount: 0,
    },
    teamLaunchState: 'partial_pending',
  };
}

describe('launch pending message helpers', () => {
  it('counts run and persisted permission-pending teammates', () => {
    const run = {
      expectedMembers: ['api', 'web', 'qa'],
      memberSpawnStatuses: new Map([
        ['api', status({ launchState: 'runtime_pending_permission' })],
        ['web', status({ launchState: 'runtime_pending_bootstrap' })],
      ]),
    };
    const persisted = snapshot({
      expectedMembers: ['api', 'web'],
      members: {
        api: persistedMember('api', { pendingPermissionRequestIds: ['perm-1'] }),
        web: persistedMember('web', { launchState: 'confirmed_alive' }),
      },
    });

    expect(countRunPermissionPendingMembers(run)).toBe(1);
    expect(countSnapshotPermissionPendingMembers(persisted)).toBe(1);
  });

  it('uses permission approval copy when every pending member is permission-blocked', () => {
    const message = buildPendingBootstrapStatusMessage({
      prefix: 'Finishing launch',
      run: {
        expectedMembers: ['api'],
        memberSpawnStatuses: new Map([
          [
            'api',
            status({
              launchState: 'runtime_pending_permission',
              runtimeAlive: true,
              pendingPermissionRequestIds: ['perm-1'],
            }),
          ],
        ]),
      },
      launchSummary: {
        confirmedCount: 0,
        pendingCount: 1,
        runtimeAlivePendingCount: 1,
        runtimeProcessPendingCount: 1,
      },
    });

    expect(message).toBe('Finishing launch — 1 teammate awaiting permission approval');
  });

  it('detects pending launch members from live or persisted expected member counts', () => {
    expect(
      hasPendingLaunchMembers({
        run: { expectedMembers: ['api'], memberSpawnStatuses: new Map() },
        launchSummary: { pendingCount: 1 },
      })
    ).toBe(true);
    expect(
      hasPendingLaunchMembers({
        run: { expectedMembers: [], memberSpawnStatuses: new Map() },
        launchSummary: { pendingCount: 1 },
        snapshot: snapshot({
          expectedMembers: ['api'],
          members: {},
        }),
      })
    ).toBe(true);
    expect(
      hasPendingLaunchMembers({
        run: { expectedMembers: ['api'], memberSpawnStatuses: new Map() },
        launchSummary: { pendingCount: 0 },
      })
    ).toBe(false);
  });

  it('uses persisted expected member count instead of stale run expected members', () => {
    const message = buildAggregatePendingLaunchMessage({
      prefix: 'Finishing launch',
      run: {
        expectedMembers: [],
        memberSpawnStatuses: new Map(),
      },
      launchSummary: {
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 1,
        runtimeProcessPendingCount: 1,
      },
      snapshot: snapshot({
        expectedMembers: ['api'],
        bootstrapExpectedMembers: ['api'],
        members: {
          api: persistedMember('api', {
            launchState: 'runtime_pending_bootstrap',
            runtimeAlive: true,
          }),
        },
      }),
    });

    expect(message).toBe('Finishing launch — teammates online');
    expect(message).not.toContain('/0');
  });

  it('reports pending secondary runtime lane members', () => {
    const message = buildAggregatePendingLaunchMessage({
      prefix: 'Finishing launch',
      run: {
        expectedMembers: ['api'],
        memberSpawnStatuses: new Map(),
        mixedSecondaryLanes: [{ laneId: 'secondary:opencode:web' }],
      },
      launchSummary: {
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      snapshot: snapshot({
        expectedMembers: ['api', 'web'],
        bootstrapExpectedMembers: ['api'],
        members: {
          api: persistedMember('api', { launchState: 'confirmed_alive' }),
          web: persistedMember('web', { launchState: 'starting' }),
        },
      }),
    });

    expect(message).toBe('Finishing launch - waiting for secondary runtime lane: web');
  });

  it('treats missing secondary-lane snapshot members as pending', () => {
    const message = buildAggregatePendingLaunchMessage({
      prefix: 'Finishing launch',
      run: {
        expectedMembers: ['api'],
        memberSpawnStatuses: new Map(),
        mixedSecondaryLanes: [{ laneId: 'secondary:opencode:web' }],
      },
      launchSummary: {
        confirmedCount: 1,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      snapshot: snapshot({
        expectedMembers: ['api', 'web'],
        bootstrapExpectedMembers: ['api'],
        members: {
          api: persistedMember('api', { launchState: 'confirmed_alive' }),
        },
      }),
    });

    expect(message).toBe('Finishing launch - waiting for secondary runtime lane: web');
  });
});
