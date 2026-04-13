import type { GraphNode } from '@claude-teams/agent-graph';

export interface OverflowCollapseResult {
  visibleNodes: GraphNode[];
  visibleNodeIdByTaskId: Map<string, string>;
}

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
  return collapseOverflowStacksWithMeta(taskNodes, teamName, maxVisibleRows).visibleNodes;
}

export function collapseOverflowStacksWithMeta(
  taskNodes: GraphNode[],
  teamName: string,
  maxVisibleRows: number
): OverflowCollapseResult {
  if (maxVisibleRows <= 1) {
    return {
      visibleNodes: taskNodes,
      visibleNodeIdByTaskId: new Map(
        taskNodes.flatMap((task) =>
          task.domainRef.kind === 'task' ? [[task.domainRef.taskId, task.id] as const] : []
        )
      ),
    };
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
  const visibleNodeIdByTaskId = new Map<string, string>();

  for (const groupKey of groupOrder) {
    const groupTasks = grouped.get(groupKey) ?? [];
    if (groupTasks.length <= maxVisibleRows) {
      visibleTasks.push(...groupTasks);
      for (const task of groupTasks) {
        if (task.domainRef.kind === 'task') {
          visibleNodeIdByTaskId.set(task.domainRef.taskId, task.id);
        }
      }
      continue;
    }

    const keptTasks = groupTasks.slice(0, maxVisibleRows - 1);
    const hiddenTasks = groupTasks.slice(maxVisibleRows - 1);
    const representative = hiddenTasks[0] ?? groupTasks[groupTasks.length - 1];
    const columnKey = resolveOverflowColumnKey(representative);
    const ownerMemberName = extractOwnerMemberName(representative, teamName);

    visibleTasks.push(...keptTasks);
    for (const task of keptTasks) {
      if (task.domainRef.kind === 'task') {
        visibleNodeIdByTaskId.set(task.domainRef.taskId, task.id);
      }
    }

    const stackNodeId = `task:${teamName}:overflow:${groupKey}`;
    const overflowTaskIds = hiddenTasks.flatMap((task) =>
      task.domainRef.kind === 'task' ? [task.domainRef.taskId] : []
    );
    for (const taskId of overflowTaskIds) {
      visibleNodeIdByTaskId.set(taskId, stackNodeId);
    }

    visibleTasks.push({
      id: `task:${teamName}:overflow:${groupKey}`,
      kind: 'task',
      label: `+${hiddenTasks.length}`,
      state: representative.state,
      displayId: `+${hiddenTasks.length}`,
      sublabel: `${hiddenTasks.length} more tasks`,
      ownerId: representative.ownerId ?? null,
      taskStatus: representative.taskStatus,
      reviewState: representative.reviewState,
      changePresence: hiddenTasks.some((task) => task.changePresence === 'has_changes')
        ? 'has_changes'
        : undefined,
      isBlocked: hiddenTasks.some((task) => task.isBlocked),
      isOverflowStack: true,
      overflowCount: hiddenTasks.length,
      overflowTaskIds,
      domainRef: {
        kind: 'task_overflow',
        teamName,
        ownerMemberName,
        columnKey,
      },
    });
  }

  return {
    visibleNodes: visibleTasks,
    visibleNodeIdByTaskId,
  };
}
