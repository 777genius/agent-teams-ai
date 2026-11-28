import { describe, expect, it } from 'vitest';

import { projectTeamTask } from '../../../src/features/agent-backend/main/adapters/output/projectTeamSnapshot';

const at = '2026-11-08T12:00:00.000Z';
const later = '2026-11-08T12:15:00.000Z';

const events = [
  { id: 'e1', type: 'task_created', timestamp: at, actor: 'lead', status: 'pending' },
  { id: 'e2', type: 'status_changed', timestamp: later, from: 'pending', to: 'in_progress' },
  { id: 'e3', type: 'owner_changed', timestamp: later, from: 'lead', to: 'alice' },
  { id: 'e4', type: 'review_requested', timestamp: later, from: 'none', to: 'review', reviewer: 'bob', note: 'Please review' },
  { id: 'e5', type: 'review_changes_requested', timestamp: later, from: 'review', to: 'needsFix', note: 'Follow up' },
  { id: 'e6', type: 'review_started', timestamp: later, from: 'needsFix', to: 'review' },
  { id: 'e7', type: 'review_approved', timestamp: later, from: 'review', to: 'approved', note: 'Accepted' },
  { id: 'e8', type: 'review_disapproved', timestamp: later, from: 'approved', to: 'none' },
];
const sourceTask = {
  id: 'TEST-task',
  subject: 'Preserve original workflow history',
  status: 'in_progress',
  workIntervals: [{ startedAt: at, completedAt: later }],
  reviewIntervals: [{ reviewer: 'bob', startedAt: later }],
  historyEvents: events,
};

describe('Host task snapshot projection preserves visible workflow evidence', () => {
  it('projects all eight canonical transitions and both time interval types without private extras', () => {
    const result = projectTeamTask({
      ...sourceTask,
      privateNativePath: 'SECRET-NATIVE-PATH',
      historyEvents: events.map((entry) => ({ ...entry, privateReceipt: 'SECRET-RECEIPT' })),
      workIntervals: [{ ...sourceTask.workIntervals[0], privateJournal: 'SECRET-JOURNAL' }],
      reviewIntervals: [{ ...sourceTask.reviewIntervals[0], privateJournal: 'SECRET-JOURNAL' }],
    }, 'TEST-team');
    expect(result.historyEvents).toEqual(events);
    expect(result.workIntervals).toEqual(sourceTask.workIntervals);
    expect(result.reviewIntervals).toEqual(sourceTask.reviewIntervals);
    expect(result.id).toBe(sourceTask.id);
    expect(result.status).toBe(sourceTask.status);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('does not invent workflow history for canonical tasks without recorded events', () => {
    const result = projectTeamTask({ id: sourceTask.id, subject: sourceTask.subject, status: 'pending' }, 'TEST-team');
    expect(result).not.toHaveProperty('historyEvents');
    expect(result).not.toHaveProperty('workIntervals');
    expect(result).not.toHaveProperty('reviewIntervals');
  });

  it('fails closed on invalid workflow identity, status transitions or intervals', () => {
    const changes = [
      { historyEvents: [{ ...events[0], timestamp: null }] },
      { historyEvents: [{ ...events[1], to: 'unknown' }] },
      { historyEvents: [{ ...events[3], to: 'approved' }] },
      { historyEvents: [{ ...events[7], from: 'pending' }] },
      { historyEvents: [{ ...events[0], type: 'unknown' }] },
      { historyEvents: {} },
      { workIntervals: [{ startedAt: null }] },
      { reviewIntervals: [{ reviewer: null, startedAt: later }] },
    ];
    for (const fields of changes)
      expect(() => projectTeamTask({ ...sourceTask, ...fields }, 'TEST-team')).toThrow();
  });
});
