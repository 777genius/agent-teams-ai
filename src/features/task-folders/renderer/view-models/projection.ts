import { childKey, taskKey } from '../../core/domain/folders';

import type { Child, Snapshot, TaskIdentity } from '../../core/domain/folders';
import type { GlobalTask } from '@shared/types';
export const ROOT = 'root';
export const UNFILED = 'unfiled';
export type TaskOrder = 'manual' | 'computed';
export interface Node {
  id: string;
  name: string;
  kind: 'root' | 'unfiled' | 'folder' | 'task';
  children: string[];
  folderId?: string;
  identity?: TaskIdentity;
  task?: GlobalTask;
  archived?: boolean;
  active: number;
  archivedCount: number;
  unavailable: number;
}
export interface Projection {
  nodes: Map<string, Node>;
  snapshot: Snapshot;
  /** Canonical sibling membership/order used to map visible drop indices back to Snapshot anchors. */
  canonicalChildren: ReadonlyMap<string, readonly string[]>;
  taskOrder: TaskOrder;
}
export function projectFolders(
  snapshot: Snapshot,
  tasks: GlobalTask[],
  isArchived: (team: string, id: string) => boolean,
  subject: (team: string, id: string) => string | undefined,
  showArchived: boolean
): Projection {
  const catalog = new Map(
    tasks.map((task) => [taskKey({ teamName: task.teamName, taskId: task.id }), task])
  );
  const nodes = new Map<string, Node>();
  const canonicalChildren = new Map<string, readonly string[]>();
  const placed = new Set<string>();
  const node = (id: string, name: string, kind: Node['kind']): Node => ({
    id,
    name,
    kind,
    children: [],
    active: 0,
    archivedCount: 0,
    unavailable: 0,
  });
  const taskNode = (identity: TaskIdentity): Node | undefined => {
    const task = catalog.get(taskKey(identity));
    if (!task) return undefined;
    const archived = isArchived(identity.teamName, identity.taskId);
    const n = {
      ...node(
        childKey({ kind: 'task', identity }),
        subject(identity.teamName, identity.taskId) ?? task.subject,
        'task'
      ),
      identity,
      task,
      archived,
      active: archived ? 0 : 1,
      archivedCount: archived ? 1 : 0,
    };
    nodes.set(n.id, n);
    return n;
  };
  snapshot.folders.forEach((f) =>
    nodes.set(`folder:${f.id}`, { ...node(`folder:${f.id}`, f.name, 'folder'), folderId: f.id })
  );
  snapshot.folders.forEach((folder) =>
    canonicalChildren.set(
      `folder:${folder.id}`,
      folder.children.map((child) => childKey(child))
    )
  );
  const fill = (id: string): Node => {
    const n = nodes.get(`folder:${id}`)!;
    const f = snapshot.folders.find((f) => f.id === id)!;
    for (const child of f.children) {
      let c: Node | undefined;
      if (child.kind === 'folder') c = fill(child.id);
      else {
        placed.add(taskKey(child.identity));
        c = taskNode(child.identity);
      }
      if (!c) {
        n.unavailable++;
        continue;
      }
      n.active += c.active;
      n.archivedCount += c.archivedCount;
      n.unavailable += c.unavailable;
      if (c.kind !== 'task' || showArchived || !c.archived) n.children.push(c.id);
    }
    return n;
  };
  const root = node(ROOT, '', 'root');
  canonicalChildren.set(
    ROOT,
    snapshot.rootFolderIds.map((id) => `folder:${id}`)
  );
  for (const id of snapshot.rootFolderIds) root.children.push(fill(id).id);
  const unfiled = node(UNFILED, '', 'unfiled');
  const unfiledChildren: string[] = [];
  for (const task of tasks) {
    const identity = { teamName: task.teamName, taskId: task.id };
    if (placed.has(taskKey(identity))) continue;
    const c = taskNode(identity)!;
    unfiledChildren.push(c.id);
    unfiled.active += c.active;
    unfiled.archivedCount += c.archivedCount;
    if (showArchived || !c.archived) unfiled.children.push(c.id);
  }
  root.children.push(UNFILED);
  canonicalChildren.set(UNFILED, unfiledChildren);
  nodes.set(ROOT, root);
  nodes.set(UNFILED, unfiled);
  return { nodes, snapshot, canonicalChildren, taskOrder: 'manual' };
}
export function nodeChild(node: Node): Child {
  if (node.kind === 'folder') return { kind: 'folder', id: node.folderId! };
  if (node.kind === 'task') return { kind: 'task', identity: node.identity! };
  throw new Error('system-node');
}
