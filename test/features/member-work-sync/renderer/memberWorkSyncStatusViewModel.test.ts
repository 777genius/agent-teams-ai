import { toMemberWorkSyncStatusViewModel } from '@features/member-work-sync/renderer';
import { describe, expect, it } from 'vitest';

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

  it('projects durable recovery attention instead of a silent needs-sync badge', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [
            {
              episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
              workKey: 'task-1:bob',
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'attention',
              reason: 'no_start_unconfirmed',
            },
          ],
          attentionAt: '2026-04-29T00:20:00.000Z',
        },
      })
    );

    expect(viewModel).toMatchObject({
      label: 'Needs attention',
      tone: 'attention',
      attention: true,
    });
    expect(viewModel.attentionSummary).toContain('Start of work is not confirmed');
    expect(viewModel.tooltip).toContain('Start of work is not confirmed');
    expect(viewModel.canContinue).toBe(true);
    expect(viewModel.canStop).toBe(true);
    expect(viewModel.canResume).toBeUndefined();
  });

  it('does not offer Continue when attention survives a non-nudgeable state', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        state: 'still_working',
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [
            {
              episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
              workKey: 'task-1:bob',
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'attention',
              reason: 'no_progress_deadline',
            },
          ],
          attentionAt: '2026-04-29T00:20:00.000Z',
        },
      })
    );

    expect(viewModel.attentionSummary).toContain('No confirmed task progress');
    expect(viewModel.canContinue).toBeUndefined();
    expect(viewModel.canStop).toBe(true);
    expect(viewModel.canResume).toBeUndefined();
  });

  it('offers Resume instead of Stop or Continue when auto-resume is latched', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [
            {
              episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
              workKey: 'task-1:bob',
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'attention',
              reason: 'no_progress_deadline',
            },
          ],
          attentionAt: '2026-04-29T00:20:00.000Z',
          autoResumeStopLatch: {
            stoppedAt: '2026-04-29T00:21:00.000Z',
            reason: 'user_stop',
            controlRevision: 1,
          },
        },
      })
    );

    expect(viewModel.autoResumeStopped).toBe(true);
    expect(viewModel.canContinue).toBeUndefined();
    expect(viewModel.canStop).toBeUndefined();
    expect(viewModel.canResume).toBe(true);
  });

  it('keeps Resume available after attention clears while the stop latch remains', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [],
          autoResumeStopLatch: {
            stoppedAt: '2026-04-29T00:21:00.000Z',
            reason: 'user_stop',
            controlRevision: 1,
          },
        },
      })
    );

    expect(viewModel.attentionSummary).toBeUndefined();
    expect(viewModel.autoResumeStopped).toBe(true);
    expect(viewModel.canContinue).toBeUndefined();
    expect(viewModel.canStop).toBeUndefined();
    expect(viewModel.canResume).toBe(true);
  });

  it('offers Stop while automatic recovery is observing before attention', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [
            {
              episodeId: 'episode:task-1:bob:2026-04-29T00:00:00.000Z',
              workKey: 'task-1:bob',
              taskId: 'task-1',
              firstObservedAt: '2026-04-29T00:00:00.000Z',
              dueAt: '2026-04-29T00:20:00.000Z',
              phase: 'observing',
              reason: 'owned_pending_task',
            },
          ],
        },
      })
    );

    expect(viewModel.attentionSummary).toBeUndefined();
    expect(viewModel.canContinue).toBeUndefined();
    expect(viewModel.canStop).toBe(true);
    expect(viewModel.canResume).toBeUndefined();
  });

  it('does not present unknown runtime Stop as fully applied', () => {
    const viewModel = toMemberWorkSyncStatusViewModel(
      makeStatus({
        recoveryHealth: {
          schemaVersion: 1,
          episodes: [],
          autoResumeStopLatch: {
            stoppedAt: '2026-04-29T00:21:00.000Z',
            reason: 'user_stop',
            controlRevision: 2,
          },
          controlRevision: 2,
        },
        runtimeAdmission: { state: 'unknown' },
      })
    );
    expect(viewModel.autoResumeStopped).toBe(true);
    expect(viewModel.canResume).toBe(true);
    expect(viewModel.attention).toBe(true);
    expect(viewModel.tooltip).toContain('runtime admission is not fully confirmed');
  });
});

it('shows the accepted lease even when the last diagnostic report was rejected', () => {
  const accepted = {
    teamName: 'team-a',
    memberName: 'bob',
    state: 'still_working' as const,
    agendaFingerprint: 'agenda:v1:abc',
    reportedAt: '2026-04-29T00:00:00.000Z',
    expiresAt: '2026-04-29T00:10:00.000Z',
    accepted: true,
  };
  const status = makeStatus({
    state: 'still_working',
    lastAcceptedReport: accepted,
    report: {
      ...accepted,
      state: 'blocked',
      accepted: false,
      rejectionCode: 'blocked_without_evidence',
      expiresAt: undefined,
    },
  });
  expect(toMemberWorkSyncStatusViewModel(status)).toMatchObject({
    label: 'Working',
    reportState: 'still_working',
    leaseExpiresAt: accepted.expiresAt,
  });
});
