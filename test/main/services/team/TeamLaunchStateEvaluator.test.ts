import { describe, expect, it } from 'vitest';

import {
  snapshotToMemberSpawnStatuses,
  summarizePersistedLaunchMembers,
} from '../../../../src/main/services/team/TeamLaunchStateEvaluator';

describe('TeamLaunchStateEvaluator', () => {
  it('keeps member spawn statuses for persisted members even when expectedMembers is stale', () => {
    const statuses = snapshotToMemberSpawnStatuses({
      version: 1,
      teamName: 'my-team',
      runId: 'run-1',
      leadSessionId: 'lead-session',
      expectedMembers: ['alice'],
      bootstrapExpectedMembers: ['alice'],
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'active',
      teamLaunchState: 'partial_pending',
      summary: {
        confirmedCount: 0,
        pendingCount: 2,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      members: {
        alice: {
          launchState: 'runtime_pending_bootstrap',
          diagnostics: ['waiting for teammate check-in'],
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
          sources: {},
        },
        bob: {
          launchState: 'runtime_pending_permission',
          diagnostics: ['waiting for permission approval'],
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          pendingPermissionRequestIds: ['req-1'],
          lastEvaluatedAt: '2026-04-23T00:00:01.000Z',
          sources: {},
        },
      },
    } as any);

    expect(statuses.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      status: 'waiting',
    });
    expect(statuses.bob).toMatchObject({
      launchState: 'runtime_pending_permission',
      status: 'online',
      pendingPermissionRequestIds: ['req-1'],
    });
  });

  it('counts persisted members in launch summary even when expectedMembers is stale', () => {
    const summary = summarizePersistedLaunchMembers(
      ['alice'],
      {
        alice: {
          launchState: 'runtime_pending_bootstrap',
          runtimeAlive: false,
        },
        bob: {
          launchState: 'runtime_pending_permission',
          runtimeAlive: true,
        },
      } as any
    );

    expect(summary).toEqual({
      confirmedCount: 0,
      pendingCount: 2,
      failedCount: 0,
      runtimeAlivePendingCount: 1,
    });
  });
});
