import { describe, expect, it } from 'vitest';

import {
  normalizeLaunchFailureReasonText,
  normalizePersistedLaunchSnapshot,
  snapshotToMemberSpawnStatuses,
  summarizePersistedLaunchMembers,
} from '../../../../src/main/services/team/TeamLaunchStateEvaluator';

describe('TeamLaunchStateEvaluator', () => {
  it('normalizes message_send tool result JSON in persisted hard failure reasons', () => {
    const reason = normalizeLaunchFailureReasonText(
      JSON.stringify({
        success: true,
        message: "Message sent to team-lead's inbox",
        routing: {
          sender: 'tom',
          target: '@team-lead',
          summary: 'Bootstrap failed - no member_briefing tool',
          content: 'Не могу выполнить member_briefing: tool not found.',
        },
      })
    );

    expect(reason).toBe(
      'Bootstrap failed - no member_briefing tool: Не могу выполнить member_briefing: tool not found.'
    );
  });

  it('normalizes truncated message_send tool result JSON in persisted hard failure reasons', () => {
    const reason = normalizeLaunchFailureReasonText(
      `{"success":true,"message":"Message sent to team-lead's inbox","routing":{"sender":"tom","summary":"Bootstrap failed - no member_briefing tool","content":"Не могу выполнить member_briefing`
    );

    expect(reason).toBe('Bootstrap failed - no member_briefing tool: Не могу выполнить member_briefing');
  });

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
      status: 'waiting',
      runtimeAlive: false,
      pendingPermissionRequestIds: ['req-1'],
    });
  });

  it('does not count weak persisted runtimeAlive without strong liveness evidence', () => {
    const summary = summarizePersistedLaunchMembers(['alice'], {
      alice: {
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
      },
      bob: {
        launchState: 'runtime_pending_permission',
        runtimeAlive: true,
      },
    } as any);

    expect(summary).toEqual({
      confirmedCount: 0,
      pendingCount: 2,
      failedCount: 0,
      skippedCount: 0,
      runtimeAlivePendingCount: 0,
      shellOnlyPendingCount: 0,
      runtimeProcessPendingCount: 0,
      runtimeCandidatePendingCount: 0,
      noRuntimePendingCount: 0,
      permissionPendingCount: 1,
    });
  });

  it('keeps skipped members terminal and out of pending counts', () => {
    const summary = summarizePersistedLaunchMembers(['alice', 'bob'], {
      alice: {
        launchState: 'skipped_for_launch',
        skippedForLaunch: true,
        runtimeAlive: false,
        bootstrapConfirmed: false,
        hardFailure: false,
      },
      bob: {
        launchState: 'confirmed_alive',
        runtimeAlive: true,
        bootstrapConfirmed: true,
        hardFailure: false,
      },
    } as any);

    expect(summary).toMatchObject({
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
      skippedCount: 1,
    });
  });

  it('does not preserve runtimeAlive for skipped persisted members', () => {
    const snapshot = normalizePersistedLaunchSnapshot('demo', {
      version: 2,
      teamName: 'demo',
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'finished',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          launchState: 'skipped_for_launch',
          skippedForLaunch: true,
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          livenessKind: 'runtime_process',
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
    });

    expect(snapshot?.members.alice).toMatchObject({
      launchState: 'skipped_for_launch',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      agentToolAccepted: false,
      skippedForLaunch: true,
    });

    const statuses = snapshotToMemberSpawnStatuses(snapshot!);
    expect(statuses.alice).toMatchObject({
      status: 'skipped',
      launchState: 'skipped_for_launch',
      runtimeAlive: false,
      bootstrapConfirmed: false,
      agentToolAccepted: false,
      skippedForLaunch: true,
    });
  });

  it('counts registered-only persisted liveness as no-runtime pending', () => {
    const summary = summarizePersistedLaunchMembers(['alice'], {
      alice: {
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: false,
        livenessKind: 'registered_only',
      },
    } as any);

    expect(summary).toMatchObject({
      pendingCount: 1,
      runtimeAlivePendingCount: 0,
      noRuntimePendingCount: 1,
    });
  });

  it('preserves persisted runtimeAlive only with strong liveness evidence', () => {
    const summary = summarizePersistedLaunchMembers(['alice', 'bob', 'cara'], {
      alice: {
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        livenessKind: 'runtime_process',
      },
      bob: {
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        bootstrapConfirmed: true,
      },
      cara: {
        launchState: 'runtime_pending_bootstrap',
        runtimeAlive: true,
        livenessKind: 'runtime_process_candidate',
      },
    } as any);

    expect(summary).toMatchObject({
      pendingCount: 3,
      runtimeAlivePendingCount: 2,
      runtimeCandidatePendingCount: 1,
    });
  });

  it('keeps bootstrap-stalled runtime processes pending instead of online', () => {
    const snapshot = normalizePersistedLaunchSnapshot('my-team', {
      version: 2,
      teamName: 'my-team',
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'runtime_process',
          bootstrapStalled: true,
          runtimeDiagnostic: 'Runtime process is alive, but no bootstrap check-in after 5 min.',
          runtimeDiagnosticSeverity: 'warning',
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
    });

    expect(snapshot?.members.alice.bootstrapStalled).toBe(true);
    expect(snapshot?.teamLaunchState).toBe('partial_pending');

    const statuses = snapshotToMemberSpawnStatuses(snapshot);
    expect(statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: undefined,
      livenessKind: 'runtime_process',
      bootstrapStalled: true,
    });
  });

  it('keeps bootstrap-stalled OpenCode registered sessions pending even without strong runtime liveness', () => {
    const snapshot = normalizePersistedLaunchSnapshot('my-team', {
      version: 2,
      teamName: 'my-team',
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'registered_only',
          runtimeSessionId: 'ses_alice_partial_bootstrap',
          bootstrapStalled: true,
          runtimeDiagnostic:
            'OpenCode member_briefing completed, but runtime_bootstrap_checkin did not complete after 5 min.',
          runtimeDiagnosticSeverity: 'warning',
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
    });

    expect(snapshot?.members.alice.bootstrapStalled).toBe(true);

    const statuses = snapshotToMemberSpawnStatuses(snapshot);
    expect(statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      livenessSource: undefined,
      livenessKind: 'registered_only',
      bootstrapStalled: true,
    });
  });

  it('keeps OpenCode secondary runtime processes pending before bootstrap stalls', () => {
    const snapshot = normalizePersistedLaunchSnapshot('my-team', {
      version: 2,
      teamName: 'my-team',
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'opencode',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          laneId: 'secondary:opencode:alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'runtime_process',
          runtimeDiagnostic: 'OpenCode runtime process detected',
          runtimeDiagnosticSeverity: 'info',
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
    });

    const statuses = snapshotToMemberSpawnStatuses(snapshot);
    expect(statuses.alice).toMatchObject({
      status: 'waiting',
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: true,
      livenessSource: undefined,
      livenessKind: 'runtime_process',
      bootstrapStalled: false,
    });
  });

  it('normalizes stale persisted runtimeAlive to false without strong liveness evidence', () => {
    const snapshot = normalizePersistedLaunchSnapshot('demo', {
      version: 2,
      teamName: 'demo',
      updatedAt: '2026-04-23T00:00:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          launchState: 'runtime_pending_bootstrap',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: false,
          hardFailure: false,
          livenessKind: 'runtime_process_candidate',
          sources: {
            processAlive: true,
          },
          lastEvaluatedAt: '2026-04-23T00:00:00.000Z',
        },
      },
    });

    expect(snapshot?.members.alice).toMatchObject({
      launchState: 'runtime_pending_bootstrap',
      runtimeAlive: false,
      livenessKind: 'runtime_process_candidate',
    });
    expect(snapshot?.members.alice.sources?.processAlive).toBeUndefined();
  });
});
