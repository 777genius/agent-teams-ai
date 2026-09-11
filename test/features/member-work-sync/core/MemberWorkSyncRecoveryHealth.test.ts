import {
  MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS,
  observeMemberWorkSyncRecoveryHealth,
  readMemberWorkSyncRecoveryHealth,
  recoveryWorkKey,
} from '@features/member-work-sync/core/domain/MemberWorkSyncRecoveryHealth';
import { describe, expect, it } from 'vitest';

const work = {
  taskId: 'task-a',
  assignee: 'alice',
  kind: 'work',
  reason: 'owned_pending_task',
};

describe('member work sync recovery health observation', () => {
  it('keeps the original observation clock when later ticks only see reports', () => {
    const first = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z'),
      items: [work],
      expectedWaiting: false,
    });
    expect(first?.episodes).toHaveLength(1);
    expect(first?.episodes[0]?.phase).toBe('observing');
    expect(first?.episodes[0]?.workKey).toBe(recoveryWorkKey(work));
    expect(first?.unresolvedIntentId).toBeUndefined();
    const later = observeMemberWorkSyncRecoveryHealth({
      previous: first,
      nowIso: '2026-09-11T00:10:00.000Z',
      nowMs: Date.parse('2026-09-11T00:10:00.000Z'),
      items: [work, { ...work, taskId: 'task-b', reason: 'owned_pending_task' }],
      expectedWaiting: false,
    });
    expect(later?.episodes[0]?.firstObservedAt).toBe('2026-09-11T00:00:00.000Z');
    expect(later?.episodes[0]?.episodeId).toBe(first?.episodes[0]?.episodeId);
    expect(later?.episodes).toHaveLength(2);
    expect(later?.unresolvedIntentId).toBeUndefined();
  });

  it('promotes to attention after the no-progress deadline without allocating a reservation', () => {
    const first = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z'),
      items: [work],
      expectedWaiting: false,
    });
    const due = Date.parse('2026-09-11T00:00:00.000Z') + MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS;
    const attention = observeMemberWorkSyncRecoveryHealth({
      previous: first,
      nowIso: new Date(due).toISOString(),
      nowMs: due,
      items: [work],
      expectedWaiting: false,
    });
    expect(attention?.episodes[0]?.phase).toBe('attention');
    expect(attention?.attentionAt).toBe(new Date(due).toISOString());
    expect(attention?.unresolvedIntentId).toBeUndefined();
    expect(readMemberWorkSyncRecoveryHealth(JSON.parse(JSON.stringify(attention)))).toEqual(
      attention
    );
  });

  it('does not treat expected waiting as a stall and never invents a reservation', () => {
    const health = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z') + MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS,
      items: [{ ...work, kind: 'blocked_dependency', reason: 'blocked_by_dependency' }],
      expectedWaiting: true,
    });
    expect(health?.episodes[0]?.phase).toBe('expected_wait');
    expect(health?.unresolvedIntentId).toBeUndefined();
  });

  it('treats pending work as queued when the same assignee already has in-progress work', () => {
    const health = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z'),
      items: [
        {
          ...work,
          taskId: 'task-a',
          evidenceStatus: 'in_progress',
          reason: 'owned_in_progress_task',
        },
        { ...work, taskId: 'task-b', evidenceStatus: 'pending', reason: 'owned_pending_task' },
      ],
      expectedWaiting: false,
      memberBusy: true,
      instrumentationKnown: true,
    });
    expect(health?.episodes.find((episode) => episode.taskId === 'task-b')?.reason).toBe('queued');
    expect(health?.episodes.find((episode) => episode.taskId === 'task-b')?.phase).toBe(
      'expected_wait'
    );
    expect(health?.unresolvedIntentId).toBeUndefined();
  });

  it('records unconfirmed no-start when native instrumentation is unknown', () => {
    const health = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z'),
      items: [{ ...work, evidenceStatus: 'pending' }],
      expectedWaiting: false,
      memberBusy: 'unknown',
      instrumentationKnown: false,
    });
    expect(health?.episodes[0]?.reason).toBe('no_start_unconfirmed');
    expect(health?.episodes[0]?.phase).toBe('observing');
  });

  it('restarts the no-progress deadline when a pending task starts making progress', () => {
    const first = observeMemberWorkSyncRecoveryHealth({
      nowIso: '2026-09-11T00:00:00.000Z',
      nowMs: Date.parse('2026-09-11T00:00:00.000Z'),
      items: [{ ...work, evidenceStatus: 'pending' }],
      expectedWaiting: false,
    });
    const almostDue =
      Date.parse('2026-09-11T00:00:00.000Z') + MEMBER_WORK_SYNC_RECOVERY_ATTENTION_MS - 60_000;
    const started = observeMemberWorkSyncRecoveryHealth({
      previous: first,
      nowIso: new Date(almostDue).toISOString(),
      nowMs: almostDue,
      items: [{ ...work, evidenceStatus: 'in_progress', reason: 'owned_in_progress_task' }],
      expectedWaiting: false,
    });
    expect(started?.episodes[0]?.firstObservedAt).toBe(new Date(almostDue).toISOString());
    expect(started?.episodes[0]?.lastProgressAt).toBe(new Date(almostDue).toISOString());
    expect(started?.episodes[0]?.lastEvidenceId).toBe('in_progress');
    expect(started?.episodes[0]?.phase).toBe('observing');
    const stillWorking = Date.parse(started!.episodes[0]!.firstObservedAt) + 60_000;
    const later = observeMemberWorkSyncRecoveryHealth({
      previous: started,
      nowIso: new Date(stillWorking).toISOString(),
      nowMs: stillWorking,
      items: [{ ...work, evidenceStatus: 'in_progress', reason: 'owned_in_progress_task' }],
      expectedWaiting: false,
    });
    expect(later?.episodes[0]?.firstObservedAt).toBe(started?.episodes[0]?.firstObservedAt);
    expect(later?.episodes[0]?.phase).toBe('observing');
  });
});
