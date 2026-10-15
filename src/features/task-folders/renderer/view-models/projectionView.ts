import type { Node, Projection } from './projection';
import type { GlobalTask } from '@shared/types';

export function applyVisibleTaskChildren(
  projection: Projection,
  tasks: readonly GlobalTask[],
  isVisible: (task: GlobalTask) => boolean,
  sortVisibleTasks: (tasks: readonly GlobalTask[]) => readonly GlobalTask[]
): Projection {
  const taskById = new Map<string, GlobalTask>(
    tasks.map((task) => [`task:${JSON.stringify([task.teamName, task.id])}`, task] as const)
  );
  const nodes = new Map<string, Node>();
  for (const [id, node] of projection.nodes) {
    const taskSlots = node.children.flatMap((childId, index) => {
      const child = projection.nodes.get(childId);
      return child?.kind === 'task' ? [index] : [];
    });
    if (taskSlots.length === 0) {
      nodes.set(id, node);
      continue;
    }
    const visibleTasks = node.children.flatMap((childId) => {
      const child = projection.nodes.get(childId);
      const task = child?.task ?? taskById.get(childId);
      return child?.kind === 'task' && task && isVisible(task) ? [task] : [];
    });
    const sortedVisibleTasks = sortVisibleTasks(visibleTasks);
    const taskSlotSet = new Set(taskSlots);
    let visibleIndex = 0;
    const children = node.children.flatMap((childId, index) => {
      if (!taskSlotSet.has(index)) return [childId];
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
  };
}
