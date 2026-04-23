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
      teamLaunchState: 'partial_failure',
    });
  });
});
