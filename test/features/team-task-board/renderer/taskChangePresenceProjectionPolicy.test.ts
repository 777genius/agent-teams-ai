import { describe, expect, it } from 'vitest';

import {
  collectTaskChangeInvalidation,
  preserveKnownTaskChangePresence,
} from '../../../../src/features/team-task-board/renderer';

import type { TeamTaskWithKanban } from '../../../../src/shared/types';

function task(id: string, input: Partial<TeamTaskWithKanban> = {}): TeamTaskWithKanban {
  return {
    id,
    subject: id,
    status: 'in_progress',
    owner: 'alice',
    createdAt: '2026-07-24T10:00:00.000Z',
    updatedAt: '2026-07-24T10:00:00.000Z',
    comments: [],
    attachments: [],
    historyEvents: [],
    ...input,
  };
}

describe('task change presence projection policy', () => {
  it('preserves known presence when the task change signature is unchanged', () => {
    const previous = task('task-1', { changePresence: 'has_changes' });
    const incoming = task('task-1', { changePresence: 'unknown' });
    const nextTasks = [incoming];

    const projected = preserveKnownTaskChangePresence('team-a', [previous], nextTasks);

    expect(projected).not.toBe(nextTasks);
    expect(projected[0]).toEqual({
      ...incoming,
      changePresence: 'has_changes',
    });
  });

  it('does not preserve stale presence after the task change signature changes', () => {
    const previous = task('task-1', {
      owner: 'alice',
      changePresence: 'needs_attention',
    });
    const incoming = task('task-1', {
      owner: 'bob',
      changePresence: 'unknown',
    });
    const nextTasks = [incoming];

    expect(preserveKnownTaskChangePresence('team-a', [previous], nextTasks)).toBe(nextTasks);
  });

  it('invalidates only task signatures missing from the next snapshot', () => {
    const stable = task('task-stable');
    const changedBefore = task('task-changed', { owner: 'alice' });
    const changedAfter = task('task-changed', { owner: 'bob' });

    const invalidation = collectTaskChangeInvalidation(
      'team-a',
      [stable, changedBefore],
      [stable, changedAfter]
    );

    expect(invalidation.taskIds).toEqual(['task-changed']);
    expect(invalidation.cacheKeys).toHaveLength(1);
    expect(invalidation.cacheKeys[0]).toContain('team-a:task-changed:');
  });
});
