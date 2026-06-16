import {
  isTaskBlocked,
  resolveTaskGraphColumn,
} from '@features/agent-graph/core/domain/taskGraphSemantics';
import { describe, expect, it } from 'vitest';

import type { TeamTaskWithKanban } from '@shared/types';

describe('taskGraphSemantics', () => {
  it('uses workflow column semantics for graph columns', () => {
    expect(resolveTaskGraphColumn({ status: 'in_progress', kanbanColumn: 'approved' })).toBe(
      'approved'
    );
    expect(resolveTaskGraphColumn({ status: 'pending', kanbanColumn: 'approved' })).toBe('todo');
    expect(resolveTaskGraphColumn({ status: 'pending', kanbanColumn: 'review' })).toBe('todo');
    expect(
      resolveTaskGraphColumn({
        status: 'in_progress',
        reviewState: 'needsFix',
        kanbanColumn: 'approved',
      })
    ).toBe('approved');
    expect(
      resolveTaskGraphColumn({
        status: 'in_progress',
        reviewState: 'review',
        kanbanColumn: 'approved',
      })
    ).toBe('approved');
    expect(
      resolveTaskGraphColumn({
        status: 'deleted',
        reviewState: 'approved',
        deletedAt: '2026-05-06T19:06:07.257Z',
      })
    ).toBe('todo');
    expect(resolveTaskGraphColumn({ status: 'pending', reviewState: 'needsFix' })).toBe('review');
  });

  it('treats approved blockers as finished dependencies', () => {
    const taskStateById = new Map<
      string,
      Pick<TeamTaskWithKanban, 'status' | 'reviewState' | 'kanbanColumn' | 'deletedAt'>
    >([
      ['completed', { status: 'completed' }],
      ['soft-deleted', { status: 'in_progress', deletedAt: '2026-05-06T19:06:07.257Z' }],
      ['review-approved', { status: 'in_progress', reviewState: 'approved' }],
      ['kanban-approved', { status: 'in_progress', kanbanColumn: 'approved' }],
    ]);

    expect(isTaskBlocked({ blockedBy: ['completed'] }, taskStateById)).toBe(false);
    expect(isTaskBlocked({ blockedBy: [' completed '] }, taskStateById)).toBe(false);
    expect(isTaskBlocked({ blockedBy: ['soft-deleted'] }, taskStateById)).toBe(false);
    expect(isTaskBlocked({ blockedBy: ['review-approved'] }, taskStateById)).toBe(false);
    expect(isTaskBlocked({ blockedBy: ['kanban-approved'] }, taskStateById)).toBe(false);
  });

  it('keeps blockers active while completed work is still in review', () => {
    const taskStateById = new Map<
      string,
      Pick<TeamTaskWithKanban, 'status' | 'reviewState' | 'kanbanColumn' | 'deletedAt'>
    >([
      [
        'completed-review',
        {
          status: 'completed',
          reviewState: 'review',
          kanbanColumn: 'review',
        },
      ],
    ]);

    expect(isTaskBlocked({ blockedBy: ['completed-review'] }, taskStateById)).toBe(true);
  });
});
