import { describe, expect, it } from 'vitest';

import { buildTaskTableRows } from '../../../../../../src/renderer/components/team/kanban/table/taskTableProjection';
import { projectTeamTasks } from '../../../../../../src/renderer/components/team/kanban/teamTaskProjection';

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

  it('handles empty blockers, needs-fix notices, and invalid timestamp fallbacks', () => {
    const amended: TeamTask = {
      ...tasks[0],
      blockedBy: [' ', 'dependency', ''],
      reviewState: 'needsFix',
      createdAt: '2026-11-07T11:30:00Z',
      updatedAt: 'invalid',
    };
    const rows = buildTaskTableRows([amended], [amended, tasks[1]], state, new Set());
    expect(rows[0].blockedByCount).toBe(1);
    expect(rows[0].needsFix).toBe(true);
    expect(rows[0].updatedAt).toBe(Date.parse(amended.createdAt!));
  });

  it('filters stale deleted Kanban entries before constructing table rows', () => {
    const deletedWithStaleOverlay = { ...tasks[4], id: 'deleted-review' };
    const stateWithStaleOverlay: KanbanState = {
      ...state,
      tasks: {
        ...state.tasks,
        'deleted-review': { column: 'review', movedAt: '2026-11-07T11:00:00Z' },
      },
    };
    const filtered = projectTeamTasks(
      [...tasks, deletedWithStaleOverlay],
      { sessionId: null, groupChatId: null, selectedOwners: new Set(), columns: new Set() },
      null
    );
    const rows = buildTaskTableRows(filtered, filtered, stateWithStaleOverlay, new Set());
    expect(rows.some((row) => row.task.id === 'deleted-review')).toBe(false);
  });

  it('respects status filters and excludes deleted tasks', () => {
    const rows = buildTaskTableRows(tasks, tasks, state, new Set(['review']));
    expect(rows.map((row) => row.task.id)).toEqual(['review']);
  });
});
