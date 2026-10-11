import { createTree, dragAndDropFeature, syncDataLoaderFeature } from '@headless-tree/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { FolderController } from '../../../src/features/task-folders/core/application/folderController';
import {
  append,
  applyCommand,
  childKey,
  emptySnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import { createEdgeScroll } from '../../../src/features/task-folders/renderer/adapters/edgeScroll';
import { PanelController } from '../../../src/features/task-folders/renderer/adapters/panelController';
import { clearTreeDrag } from '../../../src/features/task-folders/renderer/adapters/treeDragLifecycle';
import {
  TASK_MIME,
  translateTarget,
  TreeDropAdapter,
} from '../../../src/features/task-folders/renderer/adapters/treeDropAdapter';
import { projectFolders } from '../../../src/features/task-folders/renderer/view-models/projection';

import type { Node } from '../../../src/features/task-folders/renderer/view-models/projection';
import type { DndDataRef, DragTarget } from '@headless-tree/core';
import type { GlobalTask } from '@shared/types';
const identity = { teamName: 't', taskId: '1' };
const tasks = [{ teamName: 't', id: '1', subject: 'Task' }] as GlobalTask[];
const folder = applyCommand(emptySnapshot(), { type: 'create', id: 'a', parent: null, name: 'A' });
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('host lifecycle and vendor drop boundary', () => {
  it('keeps a new drag active when an earlier drop finishes after event propagation', async () => {
    const panel = new PanelController();
    panel.begin('task:a');
    panel.endAfterDrop();
    panel.begin('task:b');
    await Promise.resolve();
    expect(panel.getSnapshot().dragSource).toBe('task:b');
    panel.endAfterDrop();
    await Promise.resolve();
    expect(panel.getSnapshot().dragSource).toBeNull();
    panel.dispose();
  });
  it('gives the last hold a full grace period and prevents duplicate end/stale timer closure', () => {
    vi.useFakeTimers();
    const panel = new PanelController();
    const first = panel.begin('task:a');
    panel.end(first);
    vi.advanceTimersByTime(1999);
    expect(panel.getSnapshot().open).toBe(true);
    const second = panel.begin('task:b');
    panel.end(first);
    vi.advanceTimersByTime(5000);
    expect(panel.getSnapshot().dragSource).toBe('task:b');
    panel.hold('pointer', true);
    panel.end(second);
    panel.end(second);
    vi.advanceTimersByTime(5000);
    panel.hold('dialog', true);
    panel.hold('pointer', false);
    vi.advanceTimersByTime(5000);
    expect(panel.getSnapshot().open).toBe(true);
    panel.hold('dialog', false);
    vi.advanceTimersByTime(1999);
    expect(panel.getSnapshot().open).toBe(true);
    vi.advanceTimersByTime(1);
    expect(panel.getSnapshot().open).toBe(false);
    panel.begin('folder:a');
    panel.dispose();
    vi.runAllTimers();
    expect(panel.getSnapshot().open).toBe(false);
  });
  it('keeps canDrop pure, rejects forged/cross-window data and commits exactly once on drop', async () => {
    const save = vi.fn(async () => undefined);
    const folders = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: folder }),
      save,
    });
    folders.setCatalog([identity]);
    await folders.load();
    let projection = projectFolders(
      folder,
      tasks,
      () => false,
      () => undefined,
      true
    );
    const panel = new PanelController();
    const adapter = new TreeDropAdapter(() => projection, folders, panel);
    const source = childKey({ kind: 'task', identity });
    const target = { item: { getId: () => 'folder:a' } } as DragTarget<Node>;
    const getData = vi.fn(() => JSON.stringify({ version: 1, identity }));
    const transfer = { types: [TASK_MIME], getData } as unknown as DataTransfer;
    expect(adapter.canForeign(transfer, target, false)).toBe(false);
    panel.begin(source);
    expect(adapter.canForeign(transfer, target, false)).toBe(true);
    expect(getData).not.toHaveBeenCalled();
    expect(adapter.canForeign(transfer, target, true)).toBe(true);
    expect(adapter.canForeign(transfer, target, true)).toBe(true);
    expect(save).not.toHaveBeenCalled();
    getData.mockReturnValue(
      JSON.stringify({ version: 1, identity: { teamName: 't:1', taskId: '' } })
    );
    expect(adapter.canForeign(transfer, target, true)).toBe(false);
    getData.mockReturnValue(JSON.stringify({ version: 1, identity }));
    await adapter.dropForeign(transfer, target);
    expect(save).toHaveBeenCalledTimes(1);
    expect(adapter.canForeign(transfer, target, true)).toBe(false);
    panel.begin(source);
    projection = projectFolders(
      folders.getSnapshot().snapshot,
      [],
      () => false,
      () => undefined,
      true
    );
    folders.setCatalog([]);
    expect(adapter.canForeign(transfer, target, true)).toBe(false);
  });
  it('converts same-parent vendor insertion indices once and preserves hidden archived anchors', () => {
    let s = folder;
    for (const id of ['1', '2', '3'])
      s = applyCommand(s, {
        type: 'moveTask',
        identity: { teamName: 't', taskId: id },
        parent: 'a',
        anchor: append,
      });
    const all = ['1', '2', '3'].map((id) => ({ teamName: 't', id, subject: id })) as GlobalTask[];
    const projection = projectFolders(
      s,
      all,
      (_team, id) => id === '2',
      () => undefined,
      true
    );
    const source = projection.nodes.get('task:["t","1"]')!;
    const internal = translateTarget(projection, 'folder:a', 1, source);
    expect(internal.anchor).toEqual({
      before: { kind: 'task', identity: { teamName: 't', taskId: '3' } },
    });
    const result = applyCommand(s, { type: 'moveTask', identity, ...internal });
    expect(result.folders[0].children.map(childKey)).toEqual([
      'task:["t","2"]',
      'task:["t","1"]',
      'task:["t","3"]',
    ]);
    expect(translateTarget(projection, 'folder:a', 2, source, true)).toEqual(internal);
    const hidden = projectFolders(
      s,
      all,
      (_team, id) => id === '2',
      () => undefined,
      false
    );
    const move = translateTarget(hidden, 'folder:a', 0, hidden.nodes.get('task:["t","3"]')!);
    expect(
      applyCommand(s, {
        type: 'moveTask',
        identity: { teamName: 't', taskId: '3' },
        ...move,
      }).folders[0].children.map(childKey)
    ).toEqual(['task:["t","3"]', 'task:["t","1"]', 'task:["t","2"]']);
  });
  it('rejects reorder slots in freshness-sorted Unfiled while accepting unassignment on its node', async () => {
    const placed = applyCommand(folder, { type: 'moveTask', identity, parent: 'a', anchor: append });
    const save = vi.fn(async () => undefined);
    const folders = new FolderController({
      load: async () => ({ kind: 'valid', snapshot: placed }),
      save,
    });
    folders.setCatalog([identity]);
    await folders.load();
    const projection = projectFolders(placed, tasks, () => false, () => undefined, true);
    const adapter = new TreeDropAdapter(() => projection, folders, new PanelController());
    const source = projection.nodes.get(childKey({ kind: 'task', identity }))!;
    const target = { item: { getId: () => 'unfiled' } } as DragTarget<Node>;
    const ordered = { ...target, insertionIndex: 0 } as DragTarget<Node>;
    expect(adapter.canInternal([source], ordered)).toBe(false);
    await expect(adapter.dropInternal([source], ordered)).rejects.toThrow('invalid-drop');
    expect(save).not.toHaveBeenCalled();
    expect(adapter.canInternal([source], target)).toBe(true);
    await adapter.dropInternal([source], target);
    expect(folders.getSnapshot().snapshot.folders[0].children).toEqual([]);
    expect(save).toHaveBeenCalledTimes(1);
  });
});

describe('cancellation and edge scroll cleanup', () => {
  it('clears real vendor foreign hover and cancels expansion without relying on dragend', () => {
    vi.useFakeTimers();
    const tree = createTree({
      rootItemId: 'root',
      features: [syncDataLoaderFeature, dragAndDropFeature],
      dataLoader: { getItem: () => 'folder', getChildren: () => [] },
      getItemName: () => 'folder',
      isItemFolder: () => true,
    });
    tree.setMounted(true);
    const expand = vi.fn();
    tree.getDataRef<DndDataRef>().current.autoExpandTimeout = setTimeout(expand, 600);
    tree.setState((state) => ({ ...state, dnd: { dragTarget: { item: tree.getRootItem() } } }));
    clearTreeDrag(tree);
    vi.advanceTimersByTime(1000);
    expect(expand).not.toHaveBeenCalled();
    expect(tree.getDragTarget()).toBeNull();
    tree.setMounted(false);
  });
  it('scrolls while stationary at the edge, clamps bounds and cancels the only RAF on stop', () => {
    let next: FrameRequestCallback | undefined;
    const cancel = vi.fn(() => {
      next = undefined;
    });
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      next = callback;
      return 1;
    });
    vi.stubGlobal('cancelAnimationFrame', cancel);
    const element = {
      scrollTop: 0,
      scrollHeight: 1000,
      clientHeight: 200,
      getBoundingClientRect: () => ({ top: 0, bottom: 200 }),
    } as HTMLElement;
    const edge = createEdgeScroll(element);
    edge.over(199);
    next!(0);
    next!(100);
    expect(element.scrollTop).toBeCloseTo(46.5);
    next!(10000);
    expect(element.scrollTop).toBe(800);
    edge.stop();
    expect(next).toBeUndefined();
    expect(cancel).toHaveBeenCalledTimes(1);
  });
});
