import type { Projection } from './projection';
import type { GlobalTask } from '@shared/types';

/** Count unread tasks, rather than comments, across canonical folder descendants. */
export function countUnreadTasksByNode(
  projection: Projection,
  isTaskUnread: (task: GlobalTask) => boolean
): ReadonlyMap<string, number> {
  const descendants = new Map<string, ReadonlySet<string>>();
  const collect = (id: string): ReadonlySet<string> => {
    const cached = descendants.get(id);
    if (cached) return cached;
    const unread = new Set<string>();
    const node = projection.nodes.get(id);
    if (node?.kind === 'task') {
      if (!node.hidden && node.task && isTaskUnread(node.task)) unread.add(node.id);
    } else if (node) {
      // The synthetic root also owns Unfiled, which is not a persisted root folder.
      const children =
        node.kind === 'root'
          ? node.children
          : (projection.canonicalChildren.get(id) ?? node.children);
      for (const child of children) {
        for (const taskId of collect(child)) unread.add(taskId);
      }
    }
    descendants.set(id, unread);
    return unread;
  };
  const counts = new Map<string, number>();
  for (const id of projection.nodes.keys()) counts.set(id, collect(id).size);
  return counts;
}
