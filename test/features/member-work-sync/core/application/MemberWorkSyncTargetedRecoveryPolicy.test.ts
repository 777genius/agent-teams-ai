import { decideMemberWorkSyncTargetedRecovery } from '@features/member-work-sync/core/application';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

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
          evidence: { status: 'pending' },
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

describe('MemberWorkSyncTargetedRecoveryPolicy', () => {
  it('allows OpenCode recovery through runtime delivery capability', () => {
    expect(decideMemberWorkSyncTargetedRecovery(status())).toEqual({
      active: true,
      capability: 'opencode_runtime_delivery',
      reason: 'opencode_targeted_shadow_collecting',
    });
  });

  it('allows lead recovery through lead inbox relay capability', () => {
    expect(
      decideMemberWorkSyncTargetedRecovery(status({ memberName: 'team-lead', providerId: 'codex' }))
    ).toEqual({
      active: true,
      capability: 'lead_inbox_relay',
      reason: 'lead_targeted_shadow_collecting',
    });
  });

  it('allows non-lead native teammates through inbox-watch targeted recovery', () => {
    expect(decideMemberWorkSyncTargetedRecovery(status({ providerId: 'codex' }))).toEqual({
      active: true,
      capability: 'native_inbox_watch',
      reason: 'native_targeted_shadow_collecting',
    });
  });

  it('does not allow unknown-provider teammates through targeted recovery', () => {
    expect(decideMemberWorkSyncTargetedRecovery(status({ providerId: undefined }))).toEqual({
      active: false,
    });
  });

  it('does not treat review pickup as generic targeted recovery', () => {
    expect(
      decideMemberWorkSyncTargetedRecovery(
        status({
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
        })
      )
    ).toEqual({ active: false });
  });

  it('requires shadow would-nudge evidence before targeted recovery', () => {
    expect(
      decideMemberWorkSyncTargetedRecovery(
        status({
          shadow: {
            reconciledBy: 'queue',
            wouldNudge: false,
            fingerprintChanged: false,
          },
        })
      )
    ).toEqual({ active: false });
  });
});
