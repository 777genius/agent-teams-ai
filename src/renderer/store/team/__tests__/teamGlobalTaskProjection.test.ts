import { describe, expect, it } from 'vitest';

import { projectTeamSnapshotOntoGlobalTasks } from '../teamGlobalTaskProjection';

import type { GlobalTask, TeamViewSnapshot } from '@shared/types';

function buildSnapshot(tasks: TeamViewSnapshot['tasks']): TeamViewSnapshot {
  return {
    teamName: 'team-a',
    config: {
      name: 'Team A',
      projectPath: '/repo/a',
    },
    tasks,
    members: [],
    kanbanState: {
      teamName: 'team-a',
      reviewers: [],
      tasks: {},
    },
    processes: [],
  };
}

describe('projectTeamSnapshotOntoGlobalTasks', () => {
  it('updates existing sidebar tasks from a fresh team snapshot', () => {
    const existingTask: GlobalTask = {
      id: 'task-1',
      subject: 'Old subject',
      owner: 'alice',
      status: 'in_progress',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:01:00.000Z',
      comments: [
        {
          id: 'comment-1',
          author: 'alice',
          text: 'old',
          createdAt: '2026-01-01T10:01:00.000Z',
          type: 'regular',
        },
      ],
      teamName: 'team-a',
      teamDisplayName: 'Old Team A',
      projectPath: '/repo/old',
    };
    const otherTask: GlobalTask = {
      id: 'task-2',
      subject: 'Other task',
      owner: 'bob',
      status: 'pending',
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
      teamName: 'team-b',
      teamDisplayName: 'Team B',
    };

    const next = projectTeamSnapshotOntoGlobalTasks(
      [existingTask, otherTask],
      'team-a',
      buildSnapshot([
        {
          id: 'task-1',
          subject: 'Review and verify /3233 calculator',
          owner: 'alice',
          status: 'completed',
          createdAt: '2026-01-01T10:00:00.000Z',
          updatedAt: '2026-01-01T10:05:00.000Z',
          comments: [
            {
              id: 'comment-2',
              author: 'alice',
              text: 'x'.repeat(140),
              createdAt: '2026-01-01T10:05:00.000Z',
              type: 'regular',
            },
          ],
        },
      ])
    );

    expect(next[0]).not.toBe(existingTask);
    expect(next[0]).toMatchObject({
      id: 'task-1',
      status: 'completed',
      subject: 'Review and verify /3233 calculator',
      teamName: 'team-a',
      teamDisplayName: 'Team A',
      projectPath: '/repo/a',
    });
    expect(next[0]?.comments?.[0]?.text).toHaveLength(120);
    expect(next[1]).toBe(otherTask);
  });

  it('removes stale sidebar tasks when the fresh team snapshot no longer contains them', () => {
    const removedTask: GlobalTask = {
      id: 'task-1',
      subject: 'Removed',
      status: 'completed',
      teamName: 'team-a',
      teamDisplayName: 'Team A',
    };
    const otherTask: GlobalTask = {
      id: 'task-2',
      subject: 'Other',
      status: 'pending',
      teamName: 'team-b',
      teamDisplayName: 'Team B',
    };

    const next = projectTeamSnapshotOntoGlobalTasks(
      [removedTask, otherTask],
      'team-a',
      buildSnapshot([])
    );

    expect(next).toEqual([otherTask]);
  });

  it('keeps the original array when the sidebar has no tasks for the refreshed team', () => {
    const task: GlobalTask = {
      id: 'task-2',
      subject: 'Other',
      status: 'pending',
      teamName: 'team-b',
      teamDisplayName: 'Team B',
    };
    const current = [task];

    expect(projectTeamSnapshotOntoGlobalTasks(current, 'team-a', buildSnapshot([]))).toBe(current);
  });
});
