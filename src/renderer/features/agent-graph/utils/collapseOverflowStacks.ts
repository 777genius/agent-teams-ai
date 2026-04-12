import type { GraphNode } from '@claude-teams/agent-graph';

function resolveOverflowColumnKey(task: GraphNode): string {
  if (task.reviewState === 'approved') return 'approved';
  if (task.reviewState === 'review' || task.reviewState === 'needsFix') return 'review';
  if (task.taskStatus === 'completed') return 'done';
  if (task.taskStatus === 'in_progress') return 'wip';
  return 'todo';
}

function extractOwnerMemberName(task: GraphNode, teamName: string): string | null {
  if (!task.ownerId) return null;
  const prefix = `member:${teamName}:`;
  return task.ownerId.startsWith(prefix) ? task.ownerId.slice(prefix.length) : null;
}

export function collapseOverflowStacks(
  taskNodes: GraphNode[],
  teamName: string,
  maxVisibleRows: number
): GraphNode[] {
  if (maxVisibleRows <= 1) {
    return taskNodes;
  }

  const grouped = new Map<string, GraphNode[]>();
  const groupOrder: string[] = [];

  for (const task of taskNodes) {
    const groupKey = `${task.ownerId ?? '__unassigned__'}:${resolveOverflowColumnKey(task)}`;
    const current = grouped.get(groupKey);
    if (current) {
      current.push(task);
    } else {
      grouped.set(groupKey, [task]);
      groupOrder.push(groupKey);
    }
  }

  const visibleTasks: GraphNode[] = [];

  for (const groupKey of groupOrder) {
    const groupTasks = grouped.get(groupKey) ?? [];
    if (groupTasks.length <= maxVisibleRows) {
      visibleTasks.push(...groupTasks);
      continue;
    }

    const keptTasks = groupTasks.slice(0, maxVisibleRows - 1);
    const hiddenTasks = groupTasks.slice(maxVisibleRows - 1);
    const representative = hiddenTasks[0] ?? groupTasks[groupTasks.length - 1];
    const columnKey = resolveOverflowColumnKey(representative);
    const ownerMemberName = extractOwnerMemberName(representative, teamName);

    visibleTasks.push(...keptTasks);
    visibleTasks.push({
      id: `task:${teamName}:overflow:${groupKey}`,
      kind: 'task',
      label: `+${hiddenTasks.length}`,
      state: 'waiting',
      displayId: `+${hiddenTasks.length}`,
      sublabel: `${hiddenTasks.length} more tasks`,
      ownerId: representative.ownerId ?? null,
      taskStatus: representative.taskStatus,
      reviewState: representative.reviewState,
      isOverflowStack: true,
      overflowCount: hiddenTasks.length,
      overflowTaskIds: hiddenTasks.flatMap((task) =>
        task.domainRef.kind === 'task' ? [task.domainRef.taskId] : []
      ),
      domainRef: {
        kind: 'task_overflow',
        teamName,
        ownerMemberName,
        columnKey,
      },
    });
  }

  return visibleTasks;
}
