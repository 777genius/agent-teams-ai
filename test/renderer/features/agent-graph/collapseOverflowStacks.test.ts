import { type GraphNode, TASK_COLUMN_MAX_VISIBLE_ROWS } from '@claude-teams/agent-graph';
import {
  collapseOverflowStacks,
  collapseOverflowStacksWithMeta,
} from '@features/agent-graph/core/domain/collapseOverflowStacks';
import { describe, expect, it } from 'vitest';

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
    const nodes = Array.from({ length: 8 }, (_, index) => makeTaskNode(`task-${index + 1}`));

    const result = collapseOverflowStacks(nodes, 'my-team', 6);

    expect(result).toHaveLength(7);
    expect(result.slice(0, 6).map((node) => node.domainRef.kind === 'task' && node.domainRef.taskId)).toEqual([
      'task-1',
      'task-2',
      'task-3',
      'task-4',
      'task-5',
      'task-6',
    ]);
    expect(result[6]).toMatchObject({
      isOverflowStack: true,
      overflowCount: 2,
      overflowTaskIds: ['task-7', 'task-8'],
      domainRef: {
        kind: 'task_overflow',
        teamName: 'my-team',
        ownerMemberName: 'alice',
        columnKey: 'todo',
      },
    });
  });

  it('uses the graph column row budget so task columns stay inside the stable slot', () => {
    const nodes = Array.from({ length: 5 }, (_, index) => makeTaskNode(`task-${index + 1}`));

    const result = collapseOverflowStacks(nodes, 'my-team', TASK_COLUMN_MAX_VISIBLE_ROWS);

    expect(result).toHaveLength(TASK_COLUMN_MAX_VISIBLE_ROWS + 1);
    expect(
      result.slice(0, 3).map((node) => node.domainRef.kind === 'task' && node.domainRef.taskId)
    ).toEqual(['task-1', 'task-2', 'task-3']);
    expect(result[3]).toMatchObject({
      isOverflowStack: true,
      label: '+2 more',
      overflowCount: 2,
      overflowTaskIds: ['task-4', 'task-5'],
    });
  });

  it('applies the same stack rules to unassigned task columns', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => makeTaskNode(`task-${index + 1}`, null));

    const result = collapseOverflowStacks(nodes, 'my-team', 6);
    const stack = result.find((node) => node.isOverflowStack);

    expect(stack).toMatchObject({
      overflowCount: 2,
      overflowTaskIds: ['task-7', 'task-8'],
      ownerId: null,
      domainRef: {
        kind: 'task_overflow',
        teamName: 'my-team',
        ownerMemberName: null,
        columnKey: 'todo',
      },
    });
  });

  it('returns a visible-node mapping for hidden tasks behind the stack', () => {
    const nodes = Array.from({ length: 8 }, (_, index) => makeTaskNode(`task-${index + 1}`));

    const result = collapseOverflowStacksWithMeta(nodes, 'my-team', 6);
    const stackNode = result.visibleNodes.find((node) => node.isOverflowStack);

    expect(stackNode).toBeDefined();
    expect(result.visibleNodeIdByTaskId.get('task-1')).toBe('task:my-team:task-1');
    expect(result.visibleNodeIdByTaskId.get('task-6')).toBe('task:my-team:task-6');
    expect(result.visibleNodeIdByTaskId.get('task-7')).toBe(stackNode?.id);
    expect(result.visibleNodeIdByTaskId.get('task-8')).toBe(stackNode?.id);
  });
});
