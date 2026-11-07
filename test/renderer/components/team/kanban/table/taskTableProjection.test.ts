import { describe, expect, it } from 'vitest';

import { buildTaskTableRows } from '../../../../../../src/renderer/components/team/kanban/table/taskTableProjection';

import type { KanbanState, TeamTask } from '../../../../../../src/shared/types';

const state: KanbanState = {
  teamName: 'example',
  reviewers: [],
  tasks: {
    review: { column: 'review', movedAt: '2026-11-07T11:00:00Z' },
    approved: { column: 'approved', movedAt: '2026-11-07T11:00:00Z' },
  },
};
const tasks: TeamTask[] = [
  { id: 'blocked', subject: 'Waiting', status: 'pending', blockedBy: ['dependency'] },
  { id: 'dependency', subject: 'Work', status: 'in_progress', owner: 'bob' },
  { id: 'review', subject: 'Check', status: 'completed' },
  { id: 'approved', subject: 'Approved', status: 'completed', comments: [{ id: 'a', author: 'user', createdAt: '2026-11-07T11:00:00Z', type: 'regular', text: 'Done' }] },
  { id: 'deleted', subject: 'Deleted', status: 'deleted' },
];

describe('task table projection', () => {
  it('uses Kanban review and approved state rather than completion status', () => {
    const rows = buildTaskTableRows(tasks, tasks, state, new Set());
    expect(rows.map((row) => [row.task.id, row.status])).toEqual([
      ['blocked', 'todo'],
      ['dependency', 'in_progress'],
      ['review', 'review'],
      ['approved', 'approved'],
    ]);
    expect(rows.find((row) => row.task.id === 'approved')?.commentCount).toBe(1);
  });

  it('keeps blockers in the full team snapshot when filtering the visible rows', () => {
    const rows = buildTaskTableRows([tasks[0]], tasks, state, new Set(['todo']));
    expect(rows).toHaveLength(1);
    expect(rows[0].blocked).toBe(true);
    expect(rows[0].blockedByCount).toBe(1);
  });

  it('recomputes live values from fresh snapshots without caching stale task objects', () => {
    const updated: TeamTask[] = tasks.map((task) =>
      task.id === 'dependency' ? { ...task, status: 'completed' } : task
    );
    const next = buildTaskTableRows([tasks[0]], updated, state, new Set());
    expect(next[0].blocked).toBe(false);
    expect(next[0].task.id).toBe('blocked');
  });

  it('respects status filters and excludes deleted tasks', () => {
    const rows = buildTaskTableRows(tasks, tasks, state, new Set(['review']));
    expect(rows.map((row) => row.task.id)).toEqual(['review']);
  });
});
