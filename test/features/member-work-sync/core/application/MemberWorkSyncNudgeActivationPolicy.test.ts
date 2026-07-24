import { decideMemberWorkSyncNudgeActivation } from '@features/member-work-sync/core/application';
import { describe, expect, it } from 'vitest';

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
    deliveryReadiness: {
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
      diagnostics: ['delivery_readiness:insufficient_status_events'],
    },
    ...overrides,
  };
}

function nativeStaleInProgressStatus(
  overrides: Partial<MemberWorkSyncStatus> = {}
): MemberWorkSyncStatus {
  const base = status({
    providerId: 'codex',
    diagnostics: ['no_current_report'],
    agenda: {
      ...status().agenda,
      fingerprint: 'agenda:v1:native-stale',
      items: [
        {
          taskId: 'task-1',
          displayId: '#1',
          subject: 'Review landing',
          kind: 'work',
          assignee: 'alice',
          priority: 'normal',
          reason: 'owned_in_progress_task',
          evidence: {
            status: 'in_progress',
            owner: 'alice',
          },
        },
      ],
    },
  });
  return { ...base, ...overrides };
}

function staleMetrics(
  overrides: Partial<MemberWorkSyncTeamMetrics> = {}
): MemberWorkSyncTeamMetrics {
  return metrics({
    generatedAt: '2026-05-06T00:06:00.000Z',
    deliveryReadiness: {
      ...metrics().deliveryReadiness,
      state: 'blocked',
      reasons: ['would_nudge_rate_high', 'fingerprint_churn_high', 'report_rejection_rate_high'],
    },
    recentEvents: [
      {
        id: 'status-stale',
        teamName: 'team-a',
        memberName: 'alice',
        kind: 'status_evaluated',
        state: 'needs_sync',
        agendaFingerprint: 'agenda:v1:native-stale',
        recordedAt: '2026-05-06T00:00:00.000Z',
        actionableCount: 1,
        providerId: 'codex',
      },
    ],
    ...overrides,
  });
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

  it('activates native inbox-watch nudges while shadow data is still collecting', () => {
    for (const providerId of ['anthropic', 'codex', 'gemini'] as const) {
      expect(
        decideMemberWorkSyncNudgeActivation({
          status: status({ providerId }),
          metrics: metrics(),
        })
      ).toEqual({ active: true, reason: 'native_targeted_shadow_collecting' });
    }
  });

  it('keeps unknown-provider teammates behind delivery readiness while collecting', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: undefined }),
        metrics: metrics(),
      })
    ).toEqual({ active: false, reason: 'delivery_not_ready' });
  });

  it('allows strict review pickup nudges through delivery readiness collection before delivery capability is checked', () => {
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
                  canBypassDeliveryReadiness: true,
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

  it('does not bypass delivery readiness for review pickup when shadow would not nudge', () => {
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
                  canBypassDeliveryReadiness: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: metrics(),
      })
    ).toEqual({ active: false, reason: 'delivery_not_ready' });
  });

  it('does not bypass delivery readiness for ambiguous review pickup evidence', () => {
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
                  canBypassDeliveryReadiness: false,
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
        canBypassDeliveryReadiness: true,
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
                  canBypassDeliveryReadiness: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            state: 'collecting_shadow_data',
            reasons: ['insufficient_status_events', 'would_nudge_rate_high'],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'review_pickup_required' });
  });

  it('activates targeted OpenCode nudges even when global blocking metrics are noisy', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status(),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            state: 'blocked',
            reasons: ['would_nudge_rate_high', 'fingerprint_churn_high'],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'opencode_targeted_shadow_collecting' });
  });

  it('activates targeted lead nudges even when global blocking metrics are noisy', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'codex', memberName: 'team-lead' }),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            state: 'blocked',
            reasons: ['would_nudge_rate_high', 'fingerprint_churn_high'],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'lead_targeted_shadow_collecting' });
  });

  it('keeps native targeted recovery active when agenda telemetry is self-noisy', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'codex' }),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            reasons: [
              'insufficient_status_events',
              'would_nudge_rate_high',
              'fingerprint_churn_high',
            ],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'native_targeted_shadow_collecting' });
  });

  it('keeps native targeted recovery blocked for a high report rejection rate', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'codex' }),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            state: 'blocked',
            reasons: [
              'would_nudge_rate_high',
              'fingerprint_churn_high',
              'report_rejection_rate_high',
            ],
          },
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('activates Codex task protocol repair after a settled native turn despite blocking metrics', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          diagnostics: [
            'no_current_report',
            'runtime_stall:same_agenda_still_needs_sync',
            'runtime_stall:trigger=turn_settled',
          ],
          shadow: {
            reconciledBy: 'queue',
            wouldNudge: true,
            fingerprintChanged: false,
            triggerReasons: ['turn_settled'],
          },
        }),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:01:00.000Z',
        }),
      })
    ).toEqual({ active: true, reason: 'native_task_protocol_repair' });
  });

  it('does not activate Codex task protocol repair before the worker turn settles', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          shadow: {
            reconciledBy: 'queue',
            wouldNudge: true,
            fingerprintChanged: false,
            triggerReasons: ['runtime_activity', 'task_changed'],
          },
        }),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:01:00.000Z',
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('does not use Codex task protocol repair for lead, OpenCode, or non-Codex native providers', () => {
    const repairReady = nativeStaleInProgressStatus({
      diagnostics: [
        'no_current_report',
        'runtime_stall:same_agenda_still_needs_sync',
        'runtime_stall:trigger=turn_settled',
      ],
      shadow: {
        reconciledBy: 'queue',
        wouldNudge: true,
        fingerprintChanged: false,
        triggerReasons: ['turn_settled'],
      },
    });
    const earlyBlockingMetrics = staleMetrics({
      generatedAt: '2026-05-06T00:01:00.000Z',
    });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: { ...repairReady, memberName: 'team-lead' },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: true, reason: 'lead_targeted_shadow_collecting' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: { ...repairReady, providerId: 'opencode' },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: true, reason: 'opencode_targeted_shadow_collecting' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: { ...repairReady, providerId: 'anthropic' },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('keeps Codex task protocol repair scoped to one owned in-progress work item without an active lease', () => {
    const base = nativeStaleInProgressStatus({
      diagnostics: [
        'no_current_report',
        'runtime_stall:same_agenda_still_needs_sync',
        'runtime_stall:trigger=turn_settled',
      ],
      shadow: {
        reconciledBy: 'queue',
        wouldNudge: true,
        fingerprintChanged: false,
        triggerReasons: ['turn_settled'],
      },
    });
    const earlyBlockingMetrics = staleMetrics({
      generatedAt: '2026-05-06T00:01:00.000Z',
    });
    const baseItem = base.agenda.items[0]!;

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: {
          ...base,
          agenda: {
            ...base.agenda,
            items: [baseItem, { ...baseItem, taskId: 'task-2' }],
          },
        },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: {
          ...base,
          agenda: {
            ...base.agenda,
            items: [
              {
                ...baseItem,
                reason: 'owned_pending_task',
                evidence: { status: 'pending', owner: 'alice' },
              },
            ],
          },
        },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: {
          ...base,
          report: {
            accepted: true,
            state: 'still_working',
            agendaFingerprint: base.agenda.fingerprint,
            memberName: 'alice',
            teamName: 'team-a',
            reportedAt: '2026-05-06T00:00:30.000Z',
            expiresAt: '2026-05-06T00:02:00.000Z',
          },
        },
        metrics: earlyBlockingMetrics,
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('activates stale native single in-progress recovery despite blocking metrics', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });
  });

  it('does not activate stale native in-progress recovery before the quiet window elapses', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:05:59.000Z',
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('does not activate stale native in-progress recovery after an accepted report for the fingerprint', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          recentEvents: [
            ...staleMetrics().recentEvents,
            {
              id: 'report-accepted',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'report_accepted',
              state: 'still_working',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:03:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('activates stale native in-progress recovery when an old accepted report is followed by a new needs_sync window', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:10:01.000Z',
          recentEvents: [
            {
              id: 'old-report-accepted',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'report_accepted',
              state: 'still_working',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:01:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
            {
              id: 'needs-sync-after-old-report',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:04:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });
  });

  it('activates stale native in-progress recovery when an attached accepted report is expired', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          evaluatedAt: '2026-05-06T00:10:01.000Z',
          diagnostics: ['report_lease_expired'],
          report: {
            accepted: true,
            state: 'still_working',
            agendaFingerprint: 'agenda:v1:native-stale',
            memberName: 'alice',
            teamName: 'team-a',
            reportedAt: '2026-05-06T00:01:00.000Z',
            expiresAt: '2026-05-06T00:02:00.000Z',
          },
        }),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:10:01.000Z',
          recentEvents: [
            {
              id: 'needs-sync-after-expired-report',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:04:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });
  });

  it('activates stale native in-progress recovery when a legacy accepted report has no lease', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          diagnostics: ['report_lease_missing'],
        }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });
  });

  it('does not activate stale native in-progress recovery when the accepted report state is still current', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          state: 'still_working',
          report: {
            state: 'still_working',
            agendaFingerprint: 'agenda:v1:native-stale',
            memberName: 'alice',
            teamName: 'team-a',
            reportedAt: '2026-05-06T00:03:00.000Z',
            accepted: true,
          },
        }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: false, reason: 'status_not_nudgeable' });
  });

  it('resets the stale native in-progress quiet window after a fingerprint change', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:08:59.000Z',
          recentEvents: [
            {
              id: 'old-same-fingerprint',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:00:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
            {
              id: 'fingerprint-returned',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'fingerprint_changed',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              previousFingerprint: 'agenda:v1:other',
              recordedAt: '2026-05-06T00:03:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
            {
              id: 'current-after-change',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              previousFingerprint: 'agenda:v1:other',
              recordedAt: '2026-05-06T00:03:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('activates stale native in-progress recovery after a returned fingerprint is stable long enough', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          generatedAt: '2026-05-06T00:09:00.000Z',
          recentEvents: [
            {
              id: 'old-same-fingerprint',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:00:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
            {
              id: 'fingerprint-returned',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'fingerprint_changed',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              previousFingerprint: 'agenda:v1:other',
              recordedAt: '2026-05-06T00:03:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
            {
              id: 'current-after-change',
              teamName: 'team-a',
              memberName: 'alice',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              previousFingerprint: 'agenda:v1:other',
              recordedAt: '2026-05-06T00:03:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });
  });

  it('does not activate stale native in-progress recovery from another member stale event', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus(),
        metrics: staleMetrics({
          recentEvents: [
            {
              id: 'other-member-status-stale',
              teamName: 'team-a',
              memberName: 'bob',
              kind: 'status_evaluated',
              state: 'needs_sync',
              agendaFingerprint: 'agenda:v1:native-stale',
              recordedAt: '2026-05-06T00:00:00.000Z',
              actionableCount: 1,
              providerId: 'codex',
            },
          ],
        }),
      })
    ).toEqual({ active: false, reason: 'blocking_metrics' });
  });

  it('does not use native stale recovery for OpenCode or lead members', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({ providerId: 'opencode' }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'opencode_targeted_shadow_collecting' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({ memberName: 'team-lead' }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'lead_targeted_shadow_collecting' });
  });

  it('activates stale native assigned-work recovery for pending and multi-item safe agendas', () => {
    const baseItem = nativeStaleInProgressStatus().agenda.items[0]!;

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          agenda: {
            ...nativeStaleInProgressStatus().agenda,
            items: [
              baseItem,
              {
                ...baseItem,
                taskId: 'task-2',
              },
            ],
          },
        }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'native_stale_in_progress' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          agenda: {
            ...nativeStaleInProgressStatus().agenda,
            items: [
              {
                ...baseItem,
                reason: 'owned_pending_task',
                evidence: {
                  status: 'pending',
                  owner: 'alice',
                },
              },
            ],
          },
        }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'native_stale_assigned_work' });

    expect(
      decideMemberWorkSyncNudgeActivation({
        status: nativeStaleInProgressStatus({
          agenda: {
            ...nativeStaleInProgressStatus().agenda,
            items: [
              baseItem,
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
                  canBypassDeliveryReadiness: true,
                  historyEventIds: ['evt-review-request'],
                },
              },
            ],
          },
        }),
        metrics: staleMetrics(),
      })
    ).toEqual({ active: true, reason: 'native_stale_assigned_work' });
  });

  it('does not activate stale native in-progress recovery for needsFix, review, blocked dependency, or clarification agenda items', () => {
    const baseItem = nativeStaleInProgressStatus().agenda.items[0]!;
    const cases = [
      {
        ...baseItem,
        evidence: {
          status: 'needsFix',
          owner: 'alice',
        },
      },
      {
        ...baseItem,
        kind: 'review' as const,
        priority: 'review_requested' as const,
        reason: 'current_cycle_review_assigned',
        evidence: {
          status: 'completed',
          owner: 'bob',
          reviewer: 'alice',
          reviewState: 'review',
          reviewCycleId: 'evt-review-request',
          reviewRequestEventId: 'evt-review-request',
          reviewObligation: 'review_pickup_required' as const,
          canBypassDeliveryReadiness: true,
          historyEventIds: ['evt-review-request'],
        },
      },
      {
        ...baseItem,
        kind: 'blocked_dependency' as const,
        priority: 'blocked' as const,
        reason: 'blocked_by_incomplete_task',
        evidence: {
          status: 'in_progress',
          owner: 'alice',
          blockerTaskIds: ['task-blocker'],
        },
      },
      {
        ...baseItem,
        kind: 'clarification' as const,
        priority: 'needs_clarification' as const,
        reason: 'lead_clarification_required',
        evidence: {
          status: 'in_progress',
          owner: 'alice',
          needsClarification: 'lead' as const,
        },
      },
    ];

    for (const item of cases) {
      expect(
        decideMemberWorkSyncNudgeActivation({
          status: nativeStaleInProgressStatus({
            agenda: {
              ...nativeStaleInProgressStatus().agenda,
              items: [item],
            },
          }),
          metrics: staleMetrics(),
        })
      ).toEqual({ active: false, reason: 'blocking_metrics' });
    }
  });

  it('keeps existing shadow_ready behavior for all providers', () => {
    expect(
      decideMemberWorkSyncNudgeActivation({
        status: status({ providerId: 'codex' }),
        metrics: metrics({
          deliveryReadiness: {
            ...metrics().deliveryReadiness,
            state: 'shadow_ready',
            reasons: [],
          },
        }),
      })
    ).toEqual({ active: true, reason: 'shadow_ready' });
  });
});
