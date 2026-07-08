import {
  buildTaskCountsByOwner,
  buildTaskCountsByProject,
  normalizePath,
} from '@renderer/utils/pathNormalize';
import { describe, expect, it } from 'vitest';

describe('pathNormalize task counts', () => {
  it('normalizes Windows paths case-insensitively but keeps POSIX casing', () => {
    expect(normalizePath('C:\\Users\\Alice\\Repo\\')).toBe('c:/users/alice/repo');
    expect(normalizePath('/Users/Alice/Repo/')).toBe('/Users/Alice/Repo');
    expect(normalizePath('/Users/Alice/repo/')).toBe('/Users/Alice/repo');
  });

  it('keeps project counts separate for POSIX paths that differ only by case', () => {
    const counts = buildTaskCountsByProject([
      {
        projectPath: '/Users/Alice/Repo',
        status: 'pending',
      },
      {
        projectPath: '/Users/Alice/repo',
        status: 'completed',
      },
    ] as Parameters<typeof buildTaskCountsByProject>[0]);

    expect(counts.size).toBe(2);
    expect(counts.get('/Users/Alice/Repo')).toEqual({
      pending: 1,
      inProgress: 0,
      completed: 0,
    });
    expect(counts.get('/Users/Alice/repo')).toEqual({
      pending: 0,
      inProgress: 0,
      completed: 1,
    });
  });

  it('counts approved tasks as completed instead of in-progress', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'in_progress',
        kanbanColumn: 'approved',
      },
      {
        owner: 'jack',
        status: 'in_progress',
        reviewState: 'approved',
      },
    ]);

    expect(counts.get('jack')).toEqual({
      pending: 0,
      inProgress: 0,
      completed: 2,
    });
  });

  it('ignores soft-deleted tasks even when status is stale', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'in_progress',
        deletedAt: '2026-05-06T19:06:07.257Z',
      },
    ]);

    expect(counts.get('jack')).toBeUndefined();
  });

  it('keeps reopened pending tasks pending when kanban approved is stale', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'pending',
        kanbanColumn: 'approved',
      },
    ]);

    expect(counts.get('jack')).toEqual({
      pending: 1,
      inProgress: 0,
      completed: 0,
    });
  });

  it('counts needsFix tasks as actionable instead of completed', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'completed',
        reviewState: 'needsFix',
      },
      {
        owner: 'jack',
        status: 'in_progress',
        reviewState: 'needsFix',
      },
    ]);

    expect(counts.get('jack')).toEqual({
      pending: 1,
      inProgress: 1,
      completed: 0,
    });
  });

  it('does not count review workflow tasks as completed owner progress', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'completed',
        reviewState: 'review',
        kanbanColumn: 'review',
      },
    ]);

    expect(counts.get('jack')).toBeUndefined();
  });

  it('lets current approved overlay win over stale needsFix in task counts', () => {
    const counts = buildTaskCountsByOwner([
      {
        owner: 'jack',
        status: 'in_progress',
        reviewState: 'needsFix',
        kanbanColumn: 'approved',
      },
    ]);

    expect(counts.get('jack')).toEqual({
      pending: 0,
      inProgress: 0,
      completed: 1,
    });
  });
});
