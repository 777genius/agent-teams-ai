import type { Node, Projection, TaskOrder } from './projection';
import type { GlobalTask } from '@shared/types';

export function applyVisibleTaskChildren(
  projection: Projection,
  tasks: readonly GlobalTask[],
  isVisible: (task: GlobalTask) => boolean,
  sortVisibleTasks: (tasks: readonly GlobalTask[]) => readonly GlobalTask[],
  taskOrder: TaskOrder = 'manual'
): Projection {
  const taskById = new Map<string, GlobalTask>(
    tasks.map((task) => [`task:${JSON.stringify([task.teamName, task.id])}`, task] as const)
  );
  const nodes = new Map<string, Node>();
  for (const [id, node] of projection.nodes) {
    if (!node.children.some((childId) => projection.nodes.get(childId)?.kind === 'task')) {
      nodes.set(id, node);
      continue;
    }
    const visibleTasks: GlobalTask[] = [];
    const visibleChildren = node.children.filter((childId) => {
      const child = projection.nodes.get(childId);
      if (child?.kind !== 'task') return true;
      const task = child.task ?? taskById.get(childId);
      if (!task || !isVisible(task)) return false;
      visibleTasks.push(task);
      return true;
    });
    const sortedVisibleTasks = sortVisibleTasks(visibleTasks);
    let visibleIndex = 0;
    const children = visibleChildren.flatMap((childId) => {
      if (projection.nodes.get(childId)?.kind !== 'task') return [childId];
      const task = sortedVisibleTasks[visibleIndex];
      if (!task) return [];
      visibleIndex += 1;
      return [`task:${JSON.stringify([task.teamName, task.id])}`];
    });
    nodes.set(id, { ...node, children });
  }
  return {
    nodes,
    snapshot: projection.snapshot,
    canonicalChildren: projection.canonicalChildren,
    taskOrder,
  };
}
