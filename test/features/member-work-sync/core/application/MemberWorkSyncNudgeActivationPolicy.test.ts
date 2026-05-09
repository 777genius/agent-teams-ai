import { describe, expect, it } from 'vitest';

import { decideMemberWorkSyncNudgeActivation } from '@features/member-work-sync/core/application';

import type {
  MemberWorkSyncStatus,
  MemberWorkSyncTeamMetrics,
} from '@features/member-work-sync/contracts';

function status(overrides: Partial<MemberWorkSyncStatus> = {}): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'alice',
    state: 'needs_sync',
    agenda: {
      teamName: 'team-a',
      memberName: 'alice',
      generatedAt: '2026-05-06T00:00:00.000Z',
      fingerprint: 'agenda:v1:test',
      items: [
        {
          taskId: 'task-1',
          displayId: '#1',
          subject: 'Do work',
          kind: 'work',
          assignee: 'alice',
          priority: 'normal',
          reason: 'assigned',
          evidence: { status: 'in_progress' },
        },
      ],
      diagnostics: [],
    },
    shadow: {
      reconciledBy: 'queue',
      wouldNudge: true,
      fingerprintChanged: false,
    },
    evaluatedAt: '2026-05-06T00:00:00.000Z',
    diagnostics: [],
    providerId: 'opencode',
    ...overrides,
  };
}

function metrics(overrides: Partial<MemberWorkSyncTeamMetrics> = {}): MemberWorkSyncTeamMetrics {
  return {
    teamName: 'team-a',
    generatedAt: '2026-05-06T00:00:00.000Z',
    memberCount: 1,
    stateCounts: {
      caught_up: 0,
      needs_sync: 1,
      still_working: 0,
      blocked: 0,
      inactive: 0,
      unknown: 0,
    },
    actionableItemCount: 1,
    wouldNudgeCount: 1,
    fingerprintChangeCount: 0,
    reportAcceptedCount: 0,
    reportRejectedCount: 0,
    recentEvents: [],
    phase2Readiness: {
      state: 'collecting_shadow_data',
      reasons: ['insufficient_status_events'],
      thresholds: {
        minObservedMembers: 1,
        minStatusEvents: 20,
        minObservationHours: 1,
        maxWouldNudgesPerMemberHour: 2,
        maxFingerprintChangesPerMemberHour: 1,
        maxReportRejectionRate: 0.2,
      },
      rates: {
        observationHours: 0,
        statusEventCount: 1,
        wouldNudgesPerMemberHour: 1,
        fingerprintChangesPerMemberHour: 0,
        reportRejectionRate: 0,
      },
      diagnostics: ['phase2_readiness:insufficient_status_events'],
    },
    ...overrides,
  };
}

describe('MemberWorkSyncNudgeActivationPolicy', () => {
  it('activates OpenCode targeted nudges while shadow data is still collecting', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status(),
        metrics: metrics(),
      })
    ).toEqual({ active: true, reason: 'opencode_targeted_shadow_collecting' });
  });

  it('keeps non-OpenCode providers behind phase2 readiness while collecting', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'anthropic' }),
        metrics: metrics(),
      })
    ).toEqual({ active: false, reason: 'phase2_not_ready' });
  });

  it('allows strict review pickup nudges through phase2 collection before delivery capability is checked', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({
          providerId: 'anthropic',
          agenda: {
            ...status().agenda,
            items: [
              {
                taskId: 'task-review',
                displayId: '#2',
                subject: 'Review current request',
                kind: 'review',
                assignee: 'alice',
                priority: 'review_requested',
                reason: 'current_cycle_review_assigned',
                evidence: {
                  status: 'completed',
                  owner: 'bob',
                  reviewer: 'alice',
                  reviewState: 'review',
                  reviewCycleId: 'evt-review-request',
                  reviewRequestEventId: 'evt-review-request',
                  reviewObligation: 'review_pickup_required',
                  canBypassPhase2: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: metrics(),
      })
    ).toEqual({ active: true, reason: 'review_pickup_required' });
  });

  it('does not bypass phase2 for review pickup when shadow would not nudge', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({
          providerId: 'anthropic',
          shadow: {
            reconciledBy: 'queue',
            wouldNudge: false,
            fingerprintChanged: false,
          },
          agenda: {
            ...status().agenda,
            items: [
              {
                taskId: 'task-review',
                displayId: '#2',
                subject: 'Review current request',
                kind: 'review',
                assignee: 'alice',
                priority: 'review_requested',
                reason: 'current_cycle_review_assigned',
                evidence: {
                  status: 'completed',
                  owner: 'bob',
                  reviewer: 'alice',
                  reviewState: 'review',
                  reviewCycleId: 'evt-review-request',
                  reviewRequestEventId: 'evt-review-request',
                  reviewObligation: 'review_pickup_required',
                  canBypassPhase2: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: metrics(),
      })
    ).toEqual({ active: false, reason: 'phase2_not_ready' });
  });

  it('does not bypass phase2 for ambiguous review pickup evidence', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({
          agenda: {
            ...status().agenda,
            items: [
              {
                taskId: 'task-review',
                displayId: '#2',
                subject: 'Review current request',
                kind: 'review',
                assignee: 'alice',
                priority: 'review_requested',
                reason: 'current_cycle_review_assigned',
                evidence: {
                  status: 'completed',
                  owner: 'bob',
                  reviewer: 'alice',
                  reviewState: 'review',
                  reviewCycleId: 'kanban:alice',
                  reviewObligation: 'review_pickup_required',
                  canBypassPhase2: false,
                  reviewDiagnostics: ['review_request_event_id_missing'],
                },
              },
            ],
          },
        }),
        metrics: metrics(),
      })
    ).toEqual({ active: true, reason: 'opencode_targeted_shadow_collecting' });
  });

  it('allows multiple strict review pickup requests through the review pickup path', () => {
    const reviewItem = {
      taskId: 'task-review-a',
      displayId: '#2',
      subject: 'Review current request',
      kind: 'review' as const,
      assignee: 'alice',
      priority: 'review_requested' as const,
      reason: 'current_cycle_review_assigned',
      evidence: {
        status: 'completed',
        owner: 'bob',
        reviewer: 'alice',
        reviewState: 'review',
        reviewCycleId: 'evt-review-request-a',
        reviewRequestEventId: 'evt-review-request-a',
        reviewObligation: 'review_pickup_required' as const,
        canBypassPhase2: true,
        historyEventIds: ['evt-review-request-a'],
      },
    };

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({
          agenda: {
            ...status().agenda,
            items: [
              reviewItem,
              {
                ...reviewItem,
                taskId: 'task-review-b',
                evidence: {
                  ...reviewItem.evidence,
                  reviewCycleId: 'evt-review-request-b',
                  reviewRequestEventId: 'evt-review-request-b',
                  historyEventIds: ['evt-review-request-b'],
                },
              },
            ],
          },
        }),
        metrics: metrics(),
      })
    ).toEqual({ active: true, reason: 'review_pickup_required' });
  });

  it('allows strict review pickup while shadow data is collecting even when short-window nudge rate is high', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({
          agenda: {
            ...status().agenda,
            items: [
              {
                taskId: 'task-review',
                displayId: '#2',
                subject: 'Review current request',
                kind: 'review',
                assignee: 'alice',
                priority: 'review_requested',
                reason: 'current_cycle_review_assigned',
                evidence: {
                  status: 'completed',
                  owner: 'bob',
                  reviewer: 'alice',
                  reviewState: 'review',
                  reviewCycleId: 'evt-review-request',
                  reviewRequestEventId: 'evt-review-request',
                  reviewObligation: 'review_pickup_required',
                  canBypassPhase2: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: metrics({
          phase2Readiness: {
            ...metrics().phase2Readiness,
            state: 'collecting_shadow_data',
            reasons: ['insufficient_status_events', 'would_nudge_rate_high'],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'review_pickup_required' });
  });

  it('does not activate when blocking safety metrics are present', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status(),
        metrics: metrics({
          phase2Readiness: {
            ...metrics().phase2Readiness,
            reasons: ['insufficient_status_events', 'would_nudge_rate_high'],
          },
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('keeps existing shadow_ready behavior for all providers', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'codex' }),
        metrics: metrics({
          phase2Readiness: {
            ...metrics().phase2Readiness,
            state: 'shadow_ready',
            reasons: [],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'shadow_ready' });
  });
});
