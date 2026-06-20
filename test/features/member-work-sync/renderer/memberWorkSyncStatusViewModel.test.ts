import { describe, expect, it } from 'vitest';

import { toMemberWorkSyncStatusViewModel } from '@features/member-work-sync/renderer';

import type { MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

function makeStatus(overrides: Partial<MemberWorkSyncStatus>): MemberWorkSyncStatus {
  return {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'needs_sync',
    agenda: {
      teamName: 'team-a',
      memberName: 'bob',
      generatedAt: '2026-04-29T00:00:00.000Z',
      fingerprint: 'agenda:v1:abc',
      items: [
        {
          taskId: 'task-1',
          displayId: '11111111',
          subject: 'Ship UI',
          kind: 'work',
          assignee: 'bob',
          priority: 'normal',
          reason: 'owned_pending_task',
          evidence: { status: 'pending', owner: 'bob' },
        },
      ],
      diagnostics: [],
    },
    evaluatedAt: '2026-04-29T00:00:00.000Z',
    diagnostics: [],
    ...overrides,
  };
}

describe('memberWorkSyncStatusViewModel', () => {
  it('maps shadow needs-sync to a neutral diagnostic tooltip without warning copy', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({ shadow: { reconciledBy: 'queue', wouldNudge: true, fingerprintChanged: false } })
    );

    expect(viewModel).toMatchObject({
      label: 'Needs sync',
      tone: 'attention',
      actionableCount: 1,
      wouldNudge: true,
    });
    expect(viewModel.tooltip).toContain('Shadow status only');
  });

  it('surfaces suppressed work-sync nudges in the needs-sync tooltip', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        diagnostics: ['work_sync_suppressed_no_accepted_report'],
        shadow: { reconciledBy: 'queue', wouldNudge: false, fingerprintChanged: false },
      })
    );

    expect(viewModel).toMatchObject({
      label: 'Needs sync',
      tone: 'attention',
      wouldNudge: false,
    });
    expect(viewModel.tooltip).toContain('Automatic work-sync nudges are paused');
  });

  it('maps valid leases and caught-up states without exposing raw diagnostics', () => {
    expect(
      toMemberWorkSyncStatusViewModel(
        makeStatus({
          state: 'still_working',
          report: {
            teamName: 'team-a',
            memberName: 'bob',
            state: 'still_working',
            agendaFingerprint: 'agenda:v1:abc',
            reportedAt: '2026-04-29T00:00:00.000Z',
            expiresAt: '2026-04-29T00:10:00.000Z',
            accepted: true,
          },
        })
      )
    ).toMatchObject({
      label: 'Working',
      tone: 'working',
      leaseExpiresAt: '2026-04-29T00:10:00.000Z',
    });

    expect(
      toMemberWorkSyncStatusViewModel(
        makeStatus({
          state: 'caught_up',
          agenda: {
            teamName: 'team-a',
            memberName: 'bob',
            generatedAt: '2026-04-29T00:00:00.000Z',
            fingerprint: 'agenda:v1:empty',
            items: [],
            diagnostics: [],
          },
        })
      )
    ).toMatchObject({ label: 'Synced', tone: 'success', actionableCount: 0 });
  });
});
