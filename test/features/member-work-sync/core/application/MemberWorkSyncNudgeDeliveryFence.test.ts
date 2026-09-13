import { isMemberWorkSyncNudgeDeliveryStale } from '@features/member-work-sync/core/application/MemberWorkSyncNudgeDispatchPolicy';
import { describe, expect, it } from 'vitest';

import type { MemberWorkSyncOutboxItem, MemberWorkSyncStatus } from '@features/member-work-sync/contracts';

const nowIso = '2026-04-29T00:00:00.000Z';

const item: MemberWorkSyncOutboxItem = {
  id: 'nudge-1',
  teamName: 'team-a',
  memberName: 'bob',
  agendaFingerprint: 'agenda-1',
  payloadHash: 'hash',
  payload: {
    from: 'system',
    to: 'bob',
    messageKind: 'member_work_sync_nudge',
    source: 'member-work-sync',
    actionMode: 'do',
    workSyncIntent: 'agenda_sync',
    text: 'nudge',
    taskRefs: [],
  },
  status: 'claimed',
  attemptGeneration: 1,
  createdAt: nowIso,
  updatedAt: nowIso,
};

const needsSync: MemberWorkSyncStatus = {
  teamName: 'team-a',
  memberName: 'bob',
  state: 'needs_sync',
  evaluatedAt: nowIso,
  diagnostics: ['no_current_report'],
  agenda: {
    teamName: 'team-a',
    memberName: 'bob',
    generatedAt: nowIso,
    fingerprint: 'agenda-1',
    items: [
      {
        taskId: 'task-1',
        subject: 'Ship',
        kind: 'work',
        assignee: 'bob',
        priority: 'normal',
        reason: 'owned_pending_task',
        evidence: { status: 'pending', owner: 'bob' },
      },
    ],
    diagnostics: [],
  },
};

describe('isMemberWorkSyncNudgeDeliveryStale', () => {
  it('keeps delivery when the member still needs a matching sync', () => {
    expect(
      isMemberWorkSyncNudgeDeliveryStale({ status: needsSync, item, nowIso })
    ).toEqual({ abort: false });
  });

  it('aborts when a still_working lease now covers the same agenda', () => {
    const status: MemberWorkSyncStatus = {
      ...needsSync,
      state: 'still_working',
      lastAcceptedReport: {
        state: 'still_working',
        agendaFingerprint: 'agenda-1',
        memberName: 'bob',
        teamName: 'team-a',
        reportedAt: nowIso,
        expiresAt: '2026-04-29T00:10:00.000Z',
        accepted: true,
      },
    };
    expect(isMemberWorkSyncNudgeDeliveryStale({ status, item, nowIso })).toEqual({
      abort: true,
      reason: 'status_no_longer_matches_outbox',
    });
  });

  it('aborts when auto-resume is stopped', () => {
    const status: MemberWorkSyncStatus = {
      ...needsSync,
      recoveryHealth: {
        schemaVersion: 1,
        episodes: [],
        autoResumeStopLatch: {
          stoppedAt: nowIso,
          reason: 'user_stop',
          controlRevision: 1,
        },
      },
    };
    expect(isMemberWorkSyncNudgeDeliveryStale({ status, item, nowIso })).toEqual({
      abort: true,
      reason: 'member_stopped',
    });
  });

  it('aborts when the reserved control revision is older than the current revision', () => {
    const status: MemberWorkSyncStatus = {
      ...needsSync,
      recoveryHealth: {
        schemaVersion: 1,
        episodes: [],
        unresolvedIntentId: item.id,
        controlRevision: 3,
        reservations: [
          {
            intentId: item.id,
            episodeId: 'episode-1',
            trigger: 'automatic',
            reservedAt: nowIso,
            state: 'reserved',
            payloadHash: 'hash',
            controlRevision: 1,
          },
        ],
      },
    };
    expect(isMemberWorkSyncNudgeDeliveryStale({ status, item, nowIso })).toEqual({
      abort: true,
      reason: 'stale_control_revision',
    });
  });
});
