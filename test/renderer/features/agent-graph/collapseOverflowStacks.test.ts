import { describe, expect, it } from 'vitest';

import { collapseOverflowStacks } from '@renderer/features/agent-graph/utils/collapseOverflowStacks';

import type { GraphNode } from '@claude-teams/agent-graph';

function makeTaskNode(taskId: string, ownerName: string | null = 'alice'): GraphNode {
  return {
    id: `task:my-team:${taskId}`,
    kind: 'task',
    label: `#${taskId}`,
    displayId: `#${taskId}`,
    sublabel: `Task ${taskId}`,
    state: 'waiting',
    taskStatus: 'pending',
    reviewState: 'none',
    ownerId: ownerName ? `member:my-team:${ownerName}` : null,
    domainRef: { kind: 'task', teamName: 'my-team', taskId },
  };
}

describe('collapseOverflowStacks', () => {
  it('keeps all tasks visible when the column fits within the max row count', () => {
    const nodes = Array.from({ length: 6 }, (_, index) => makeTaskNode(`task-${index + 1}`));

    const result = collapseOverflowStacks(nodes, 'my-team', 6);

    expect(result).toHaveLength(6);
    expect(result.every((node) => !node.isOverflowStack)).toBe(true);
  });

  it('replaces the hidden tail with a single overflow stack node while preserving visible order', () => {
    const nodes = Array.from({ length: 7 }, (_, index) => makeTaskNode(`task-${index + 1}`));

    const result = collapseOverflowStacks(nodes, 'my-team', 6);

    expect(result).toHaveLength(6);
    expect(result.slice(0, 5).map((node) => node.domainRef.kind === 'task' && node.domainRef.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
    ]);
    expect(result[5]).toMatchObject({
      isOverflowStack: true,
      overflowCount: 2,
      overflowTaskIds: ['task-6', 'task-7'],
      domainRef: {
        kind: 'task_overflow',
        teamName: 'my-team',
        ownerMemberName: 'alice',
        columnKey: 'todo',
      },
    });
  });

  it('applies the same stack rules to unassigned task columns', () => {
    const nodes = Array.from({ length: 7 }, (_, index) => makeTaskNode(`task-${index + 1}`, null));

    const result = collapseOverflowStacks(nodes, 'my-team', 6);
    const stack = result.find((node) => node.isOverflowStack);

    expect(stack).toMatchObject({
      overflowCount: 2,
      overflowTaskIds: ['task-6', 'task-7'],
      ownerId: null,
      domainRef: {
        kind: 'task_overflow',
        teamName: 'my-team',
        ownerMemberName: null,
        columnKey: 'todo',
      },
    });
  });
});
