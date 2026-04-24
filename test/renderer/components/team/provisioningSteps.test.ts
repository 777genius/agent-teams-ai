import { describe, expect, it } from 'vitest';

import { getLaunchJoinMilestonesFromMembers } from '@renderer/components/team/provisioningSteps';

const members = [{ name: 'alice' }, { name: 'bob' }, { name: 'tom' }, { name: 'jane' }];

describe('getLaunchJoinMilestonesFromMembers', () => {
  it('does not count shell-only liveness as process alive', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessSource: 'process',
          livenessKind: 'shell_only',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessSource: 'process',
          livenessKind: 'runtime_process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessSource: 'process',
          livenessKind: 'runtime_process_candidate',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessSource: 'process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.processOnlyAliveCount).toBe(1);
    expect(milestones.pendingSpawnCount).toBe(3);
  });

  it('does not count missing liveness kind as process alive', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessSource: 'process',
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.processOnlyAliveCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(4);
  });

  it('uses runtimeProcessPendingCount instead of legacy runtimeAlivePendingCount for snapshot pending math', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob', 'tom', 'jane'],
        summary: {
          confirmedCount: 0,
          pendingCount: 4,
          failedCount: 0,
          runtimeAlivePendingCount: 3,
          runtimeProcessPendingCount: 1,
          shellOnlyPendingCount: 1,
          runtimeCandidatePendingCount: 1,
          permissionPendingCount: 1,
        },
      },
    });

    expect(milestones.processOnlyAliveCount).toBe(1);
    expect(milestones.pendingSpawnCount).toBe(3);
  });

  it('does not trust legacy runtimeAlivePendingCount without runtime process count', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob', 'tom', 'jane'],
        summary: {
          confirmedCount: 0,
          pendingCount: 4,
          failedCount: 0,
          runtimeAlivePendingCount: 3,
        },
      },
    });

    expect(milestones.processOnlyAliveCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(4);
  });

  it('counts skipped teammates separately from pending and failed launch members', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'skipped',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.skippedSpawnCount).toBe(1);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(3);
  });
});
