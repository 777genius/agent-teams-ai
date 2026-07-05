import { describe, expect, it } from 'vitest';

import {
  choosePreferredLaunchStateSummary,
  createPersistedLaunchSummaryProjection,
  shouldSuppressLegacyLaunchArtifactHeuristic,
} from '../../../../src/main/services/team/TeamLaunchSummaryProjection';

describe('TeamLaunchSummaryProjection', () => {
  it('ignores stale terminal bootstrap-only pending summaries when canonical launch truth is missing', () => {
    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: {
        version: 2,
        teamName: 'atlas-hq-2',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'finished',
        expectedMembers: ['alice', 'jack'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
          jack: {
            name: 'jack',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      } as never,
      launchSummaryProjection: null,
    });

    expect(summary).toBeNull();
  });

  it('ignores stale terminal launch-state pending summaries before projecting renderer copy', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'atlas-hq-2',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'finished',
        expectedMembers: ['alice', 'jack'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
          jack: {
            name: 'jack',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      } as never,
      bootstrapSnapshot: null,
      launchSummaryProjection: null,
    });

    expect(summary).toBeNull();
  });

  it('ignores stale active launch-state pending summaries without outstanding permissions', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'vector-room-13',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'active',
        expectedMembers: ['alice', 'bob'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'starting',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
          bob: {
            name: 'bob',
            launchState: 'runtime_pending_bootstrap',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 2,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          permissionPendingCount: 0,
        },
        teamLaunchState: 'partial_pending',
      } as never,
      launchSummaryProjection: null,
    });

    expect(summary).toBeNull();
  });

  it('keeps stale launch-state pending summaries when permission approval is outstanding', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'permission-team',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'active',
        expectedMembers: ['alice'],
        members: {
          alice: {
            name: 'alice',
            launchState: 'permission_pending',
            agentToolAccepted: false,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: false,
            lastEvaluatedAt: '2026-04-09T20:35:57.962Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 1,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
          permissionPendingCount: 1,
        },
        teamLaunchState: 'partial_pending',
      } as never,
      launchSummaryProjection: null,
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'partial_pending',
      permissionPendingCount: 1,
    });
  });

  it('ignores stale pending launch-summary projections when canonical launch truth is missing', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSummaryProjection: {
        version: 1,
        teamName: 'atlas-hq-2',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchUpdatedAt: '2026-04-09T20:35:57.962Z',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 2,
        confirmedCount: 0,
        pendingCount: 2,
        failedCount: 0,
        runtimeProcessPendingCount: 0,
        permissionPendingCount: 0,
      },
    });

    expect(summary).toBeNull();
  });

  it('ignores stale active pending launch-summary projections without outstanding permissions', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSummaryProjection: {
        version: 1,
        teamName: 'vector-room-13',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchUpdatedAt: '2026-04-09T20:35:57.962Z',
        launchPhase: 'active',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 2,
        confirmedCount: 0,
        pendingCount: 2,
        failedCount: 0,
        runtimeProcessPendingCount: 0,
        permissionPendingCount: 0,
      },
    });

    expect(summary).toBeNull();
  });

  it('keeps stale pending launch-summary projections when permission approval is outstanding', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSummaryProjection: {
        version: 1,
        teamName: 'permission-team',
        updatedAt: '2026-04-09T20:35:57.962Z',
        launchUpdatedAt: '2026-04-09T20:35:57.962Z',
        teamLaunchState: 'partial_pending',
        expectedMemberCount: 1,
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        permissionPendingCount: 1,
      },
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'partial_pending',
      permissionPendingCount: 1,
    });
  });

  it('projects provisioned-but-not-alive failures with bootstrap proof as confirmed', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic:
              'runtime pid could not be verified because process table is unavailable',
            runtimeDiagnosticSeverity: 'warning',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'clean_success',
      confirmedMemberCount: 1,
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 0,
    });
    expect(summary).not.toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
    });
  });

  it('projects Windows process-table-unavailable provisioned-but-not-alive metadata as confirmed', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason:
              'CLI process exited (code 1) - team provisioned but not alive; process table unavailable',
            livenessKind: 'registered_only',
            runtimeDiagnostic:
              'runtime pid could not be verified because process table is unavailable',
            runtimeDiagnosticSeverity: 'warning',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'clean_success',
      confirmedMemberCount: 1,
      confirmedCount: 1,
      failedCount: 0,
    });
  });

  it('projects confirmed native bootstrap-control metadata as confirmed', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['cody'],
        members: {
          cody: {
            name: 'cody',
            providerId: 'codex',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason:
              '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic:
              '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
            runtimeDiagnosticSeverity: 'warning',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'clean_success',
      confirmedMemberCount: 1,
      confirmedCount: 1,
      failedCount: 0,
    });
  });

  it('keeps confirmed native bootstrap-control metadata failed with runtime error evidence', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['cody'],
        members: {
          cody: {
            name: 'cody',
            providerId: 'codex',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason:
              '<agent_teams_native_bootstrap_control>\nSystem-level bootstrap rules:\n- This is a private startup context handoff.',
            livenessKind: 'not_found',
            runtimeDiagnostic: 'Runtime process crashed',
            runtimeDiagnosticSeverity: 'error',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['cody'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('keeps provisioned-but-not-alive failures with runtime error evidence as failed', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) - team provisioned but not alive',
            livenessKind: 'confirmed_bootstrap',
            runtimeDiagnostic: 'Runtime process crashed',
            runtimeDiagnosticSeverity: 'error',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('reconciles unhealed launch-summary projections with bootstrap proof', () => {
    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:13:56.110Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            livenessKind: 'confirmed_bootstrap',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastHeartbeatAt: '2026-05-25T20:13:56.110Z',
            lastEvaluatedAt: '2026-05-25T20:13:56.110Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      } as never,
      launchSummaryProjection: {
        version: 1,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchUpdatedAt: '2026-05-25T20:14:02.147Z',
        teamLaunchState: 'partial_failure',
        partialLaunchFailure: true,
        expectedMemberCount: 1,
        confirmedMemberCount: 0,
        missingMembers: ['tom'],
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
    });

    expect(summary).toMatchObject({
      teamLaunchState: 'clean_success',
      confirmedMemberCount: 1,
      confirmedCount: 1,
      failedCount: 0,
      pendingCount: 0,
    });
    expect(summary).not.toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
    });
  });

  it('does not reconcile launch-summary projections from stale bootstrap proof', () => {
    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:10:10.000Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            livenessKind: 'confirmed_bootstrap',
            firstSpawnAcceptedAt: '2026-05-25T20:10:00.000Z',
            lastHeartbeatAt: '2026-05-25T20:10:05.000Z',
            lastEvaluatedAt: '2026-05-25T20:10:10.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      } as never,
      launchSummaryProjection: {
        version: 1,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchUpdatedAt: '2026-05-25T20:14:02.147Z',
        teamLaunchState: 'partial_failure',
        partialLaunchFailure: true,
        expectedMemberCount: 1,
        confirmedMemberCount: 0,
        missingMembers: ['tom'],
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('does not reconcile launch-summary projections from stopped bootstrap proof', () => {
    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:13:56.110Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: true,
            hardFailure: false,
            livenessKind: 'not_found',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastEvaluatedAt: '2026-05-25T20:13:56.110Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      } as never,
      launchSummaryProjection: {
        version: 1,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchUpdatedAt: '2026-05-25T20:14:02.147Z',
        teamLaunchState: 'partial_failure',
        partialLaunchFailure: true,
        expectedMemberCount: 1,
        confirmedMemberCount: 0,
        missingMembers: ['tom'],
        confirmedCount: 0,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('keeps provisioned-but-not-alive failures without bootstrap proof as failed', () => {
    const summary = choosePreferredLaunchStateSummary({
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('does not project provisioned-but-not-alive from stale bootstrap proof before spawn acceptance', () => {
    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:10:10.000Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'confirmed_alive',
            agentToolAccepted: true,
            runtimeAlive: true,
            bootstrapConfirmed: true,
            hardFailure: false,
            firstSpawnAcceptedAt: '2026-05-25T20:10:00.000Z',
            lastHeartbeatAt: '2026-05-25T20:10:05.000Z',
            lastEvaluatedAt: '2026-05-25T20:10:10.000Z',
          },
        },
        summary: {
          confirmedCount: 1,
          pendingCount: 0,
          failedCount: 0,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'clean_success',
      } as never,
      launchSnapshot: {
        version: 2,
        teamName: 'signal-ops',
        updatedAt: '2026-05-25T20:14:02.147Z',
        launchPhase: 'finished',
        expectedMembers: ['tom'],
        members: {
          tom: {
            name: 'tom',
            providerId: 'anthropic',
            launchState: 'failed_to_start',
            agentToolAccepted: true,
            runtimeAlive: false,
            bootstrapConfirmed: false,
            hardFailure: true,
            hardFailureReason: 'CLI process exited (code 1) \u2014 team provisioned but not alive',
            firstSpawnAcceptedAt: '2026-05-25T20:13:46.326Z',
            lastEvaluatedAt: '2026-05-25T20:14:02.147Z',
          },
        },
        summary: {
          confirmedCount: 0,
          pendingCount: 0,
          failedCount: 1,
          runtimeAlivePendingCount: 0,
        },
        teamLaunchState: 'partial_failure',
      } as never,
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      missingMembers: ['tom'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 0,
      failedCount: 1,
    });
  });

  it('prefers a mixed-aware persisted summary projection over a newer but poorer bootstrap snapshot', () => {
    const bootstrapSnapshot = {
      version: 2,
      teamName: 'mixed-team',
      updatedAt: '2026-04-22T12:05:00.000Z',
      launchPhase: 'active',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'codex',
          launchState: 'starting',
          agentToolAccepted: false,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:05:00.000Z',
        },
      },
      summary: {
        confirmedCount: 0,
        pendingCount: 1,
        failedCount: 0,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_pending',
    } as const;

    const mixedSnapshot = {
      version: 2,
      teamName: 'mixed-team',
      updatedAt: '2026-04-22T12:00:00.000Z',
      launchPhase: 'finished',
      expectedMembers: ['alice', 'bob'],
      bootstrapExpectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'codex',
          laneId: 'primary',
          laneKind: 'primary',
          laneOwnerProviderId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
        bob: {
          name: 'bob',
          providerId: 'opencode',
          laneId: 'secondary:opencode:bob',
          laneKind: 'secondary',
          laneOwnerProviderId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Side lane failed',
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
      },
      summary: {
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_failure',
    } as const;

    const summary = choosePreferredLaunchStateSummary({
      bootstrapSnapshot: bootstrapSnapshot as never,
      launchSummaryProjection: createPersistedLaunchSummaryProjection(mixedSnapshot as never),
    });

    expect(summary).toMatchObject({
      partialLaunchFailure: true,
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      missingMembers: ['bob'],
      teamLaunchState: 'partial_failure',
      confirmedCount: 1,
      pendingCount: 0,
      failedCount: 1,
    });
  });

  it('suppresses legacy artifact-count launch heuristics for mixed-aware desired rosters', () => {
    expect(
      shouldSuppressLegacyLaunchArtifactHeuristic({
        leadProviderId: 'codex',
        members: [
          { name: 'alice', providerId: 'codex' },
          { name: 'tom', providerId: 'opencode' },
        ],
      })
    ).toBe(true);

    expect(
      shouldSuppressLegacyLaunchArtifactHeuristic({
        leadProviderId: 'opencode',
        members: [{ name: 'alice', providerId: 'codex' }],
      })
    ).toBe(true);

    expect(
      shouldSuppressLegacyLaunchArtifactHeuristic({
        leadProviderId: 'codex',
        members: [
          { name: 'alice', providerId: 'opencode' },
          { name: 'tom', providerId: 'opencode' },
        ],
      })
    ).toBe(true);

    expect(
      shouldSuppressLegacyLaunchArtifactHeuristic({
        leadProviderId: 'codex',
        members: [{ name: 'alice', providerId: 'codex' }],
      })
    ).toBe(false);
  });

  it('uses the union of expectedMembers and persisted members for summary projection', () => {
    const summary = createPersistedLaunchSummaryProjection({
      version: 2,
      teamName: 'mixed-team',
      updatedAt: '2026-04-22T12:00:00.000Z',
      launchPhase: 'finished',
      expectedMembers: ['alice'],
      members: {
        alice: {
          name: 'alice',
          providerId: 'codex',
          launchState: 'confirmed_alive',
          agentToolAccepted: true,
          runtimeAlive: true,
          bootstrapConfirmed: true,
          hardFailure: false,
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
        bob: {
          name: 'bob',
          providerId: 'opencode',
          launchState: 'failed_to_start',
          agentToolAccepted: true,
          runtimeAlive: false,
          bootstrapConfirmed: false,
          hardFailure: true,
          hardFailureReason: 'Side lane failed',
          lastEvaluatedAt: '2026-04-22T12:00:00.000Z',
        },
      },
      summary: {
        confirmedCount: 1,
        pendingCount: 0,
        failedCount: 1,
        runtimeAlivePendingCount: 0,
      },
      teamLaunchState: 'partial_failure',
    } as never);

    expect(summary).toMatchObject({
      expectedMemberCount: 2,
      confirmedMemberCount: 1,
      missingMembers: ['bob'],
      failedCount: 1,
      launchPhase: 'finished',
      teamLaunchState: 'partial_failure',
    });
  });
});
