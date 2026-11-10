import { getLaunchJoinMilestonesFromMembers } from '@renderer/components/team/provisioningSteps';
import { describe, expect, it } from 'vitest';

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

  it('keeps bootstrap-stalled runtime processes out of process-alive progress', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: true,
          livenessKind: 'runtime_process',
          bootstrapStalled: true,
          updatedAt: '2026-04-24T12:05:00.000Z',
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

  it('counts bootstrap-confirmed provisioned-but-not-alive entries as joined', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(1);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(0);
  });

  it('counts bootstrap-confirmed native bootstrap-control entries as joined', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'cody' }],
      memberSpawnStatuses: {
        cody: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'persisted runtime pid is not alive',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        cody: {
          memberName: 'cody',
          alive: false,
          restartable: true,
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic: 'persisted runtime pid is not alive',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(1);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(0);
  });

  it('uses spawn process-table proof when runtime registered metadata has no diagnostic text', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(1);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(0);
  });

  it('uses spawn process-table proof when runtime metadata has no liveness or diagnostic text', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(1);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(0);
  });

  it('counts unsafe bootstrap-confirmed provisioned-but-not-alive entries as failed', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime is no longer registered',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(0);
    expect(milestones.failedSpawnCount).toBe(1);
    expect(milestones.pendingSpawnCount).toBe(0);
  });

  it('keeps ambiguous runtime-offline entries pending even when provisioned-but-not-alive spawn evidence is safe', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'registered_only',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          runtimeDiagnostic: 'Runtime heartbeat is not alive',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(0);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(1);
  });

  it('does not count safe provisioned-but-not-alive spawn evidence as joined when live runtime evidence is an error', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members: [{ name: 'tom' }],
      memberSpawnStatuses: {
        tom: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          livenessKind: 'confirmed_bootstrap',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'warning',
          updatedAt: '2026-05-25T20:14:02.147Z',
        },
      },
      memberRuntimeEntries: {
        tom: {
          memberName: 'tom',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic:
            'runtime pid could not be verified because process table is unavailable',
          runtimeDiagnosticSeverity: 'error',
          updatedAt: '2026-05-25T20:14:03.317Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(0);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.pendingSpawnCount).toBe(1);
  });

  it('does not let a stale clean snapshot hide live registered-only members', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'waiting',
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: false,
          bootstrapConfirmed: false,
          livenessKind: 'registered_only',
          updatedAt: '2026-04-24T12:00:01.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
      memberSpawnSnapshot: {
        expectedMembers: ['alice', 'bob', 'tom', 'jane'],
        summary: {
          confirmedCount: 4,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(3);
    expect(milestones.pendingSpawnCount).toBe(1);
    expect(milestones.expectedTeammateCount).toBe(4);
  });

  it('does not count confirmed spawn as joined when runtime snapshot is unavailable', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:01.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
      memberRuntimeEntries: {
        bob: {
          memberName: 'bob',
          alive: false,
          restartable: true,
          livenessKind: 'registered_only',
          runtimeDiagnostic: 'registered runtime metadata without live process',
          updatedAt: '2026-04-24T12:00:02.000Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(3);
    expect(milestones.pendingSpawnCount).toBe(1);
    expect(milestones.expectedTeammateCount).toBe(4);
  });

  it('does not count confirmed spawn as joined when spawn metadata carries runtime error evidence', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          livenessKind: 'not_found',
          runtimeDiagnostic: 'Runtime process crashed',
          runtimeDiagnosticSeverity: 'error',
          updatedAt: '2026-04-24T12:00:01.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(3);
    expect(milestones.pendingSpawnCount).toBe(1);
    expect(milestones.expectedTeammateCount).toBe(4);
  });

  it('does not count confirmed spawn as joined when stopped spawn metadata has no liveness kind', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:01.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(3);
    expect(milestones.pendingSpawnCount).toBe(1);
    expect(milestones.expectedTeammateCount).toBe(4);
  });

  it('counts process-table-unavailable provisioned-but-not-alive spawn without liveness kind as joined', () => {
    const milestones = getLaunchJoinMilestonesFromMembers({
      members,
      memberSpawnStatuses: {
        alice: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        bob: {
          status: 'error',
          launchState: 'failed_to_start',
          runtimeAlive: false,
          bootstrapConfirmed: true,
          hardFailure: true,
          hardFailureReason:
            'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
          updatedAt: '2026-04-24T12:00:01.000Z',
        },
        tom: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
        jane: {
          status: 'online',
          launchState: 'confirmed_alive',
          runtimeAlive: true,
          bootstrapConfirmed: true,
          updatedAt: '2026-04-24T12:00:00.000Z',
        },
      },
    });

    expect(milestones.heartbeatConfirmedCount).toBe(4);
    expect(milestones.pendingSpawnCount).toBe(0);
    expect(milestones.failedSpawnCount).toBe(0);
    expect(milestones.expectedTeammateCount).toBe(4);
  });
});
