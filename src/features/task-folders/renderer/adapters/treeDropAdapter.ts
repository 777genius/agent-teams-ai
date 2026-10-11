import { append, canMoveFolder, isIdentity, taskKey } from '../../core/domain/folders';
import { nodeChild, ROOT, UNFILED } from '../view-models/projection';

import type { FolderController } from '../../core/application/folderController';
import type { Anchor, Command, TaskIdentity } from '../../core/domain/folders';
import type { Node, Projection } from '../view-models/projection';
import type { PanelController } from './panelController';
import type { DragTarget } from '@headless-tree/core';
export const TASK_MIME = 'application/x-agent-teams-task-v1';
export function translateTarget(
  projection: Projection,
  parentId: string,
  index: number | undefined,
  source: Node,
  foreign = false
): { parent: string | null; anchor: Anchor } {
  const target = projection.nodes.get(parentId);
  if (!target || target.kind === 'task') throw new Error('invalid-target');
  if (target.kind === 'unfiled' && index !== undefined) throw new Error('unordered-target');
  if (
    source.kind === 'folder' &&
    (target.kind === 'unfiled' ||
      !canMoveFolder(projection.snapshot, source.folderId!, target.folderId ?? null))
  )
    throw new Error('cycle');
  if (target.id === ROOT || target.id === UNFILED) {
    if (source.kind === 'task') return { parent: null, anchor: append };
  }
  const siblings = target.children.filter((id) => id !== source.id && id !== UNFILED);
  let insertion = index;
  if (foreign && insertion !== undefined) {
    const old = target.children.indexOf(source.id);
    if (old >= 0 && old < insertion) insertion--;
  }
  const next = insertion === undefined ? undefined : siblings[insertion];
  const anchor: Anchor = next ? { before: nodeChild(projection.nodes.get(next)!) } : append;
  return { parent: target.folderId ?? null, anchor };
}
export class TreeDropAdapter {
  constructor(
    private projection: () => Projection,
    private folders: FolderController,
    private panel: PanelController
  ) {}
  private command(source: Node, target: DragTarget<Node>, foreign: boolean): Command {
    const destination = translateTarget(
      this.projection(),
      target.item.getId(),
      'insertionIndex' in target ? target.insertionIndex : undefined,
      source,
      foreign
    );
    return source.kind === 'folder'
      ? { type: 'moveFolder', id: source.folderId!, ...destination }
      : { type: 'moveTask', identity: source.identity!, ...destination };
  }
  private foreignSource(transfer: DataTransfer, parse: boolean): Node | undefined {
    const state = this.panel.getSnapshot();
    if (!state.dragSource?.startsWith('task:') || !Array.from(transfer.types).includes(TASK_MIME))
      return undefined;
    const source = this.projection().nodes.get(state.dragSource);
    if (!source?.identity || !this.folders.hasTask(source.identity)) return undefined;
    if (parse) {
      try {
        const data: unknown = JSON.parse(transfer.getData(TASK_MIME));
        const payload = data as { version?: unknown; identity?: unknown };
        if (
          payload.version !== 1 ||
          !isIdentity(payload.identity) ||
          taskKey(payload.identity) !== taskKey(source.identity)
        )
          return undefined;
      } catch {
        return undefined;
      }
    }
    return source;
  }
  canForeign = (transfer: DataTransfer, target: DragTarget<Node>, parse: boolean): boolean => {
    if (this.folders.getSnapshot().status !== 'ready') return false;
    const source = this.foreignSource(transfer, parse);
    if (!source) return false;
    try {
      this.command(source, target, true);
      return true;
    } catch {
      return false;
    }
  };
  dropForeign = async (transfer: DataTransfer, target: DragTarget<Node>): Promise<void> => {
    if (!this.canForeign(transfer, target, true)) throw new Error('invalid-drop');
    const source = this.foreignSource(transfer, true)!;
    const session = this.panel.getSnapshot().session;
    try {
      await this.folders.execute(this.command(source, target, true));
    } finally {
      this.panel.end(session);
    }
  };
  canInternal = (sources: Node[], target: DragTarget<Node>): boolean => {
    if (sources.length !== 1 || this.folders.getSnapshot().status !== 'ready') return false;
    const source = this.projection().nodes.get(sources[0].id);
    if (!source || (source.kind !== 'task' && source.kind !== 'folder')) return false;
    try {
      this.command(source, target, false);
      return true;
    } catch {
      return false;
    }
  };
  dropInternal = async (sources: Node[], target: DragTarget<Node>): Promise<void> => {
    if (!this.canInternal(sources, target)) throw new Error('invalid-drop');
    await this.folders.execute(
      this.command(this.projection().nodes.get(sources[0].id)!, target, false)
    );
  };
}
export function writeTaskDrag(transfer: DataTransfer, identity: TaskIdentity): void {
  transfer.effectAllowed = 'move';
  transfer.dropEffect = 'move';
  transfer.setData(TASK_MIME, JSON.stringify({ version: 1, identity }));
}
