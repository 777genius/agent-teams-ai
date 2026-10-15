import React, { act, useState } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useTaskLocalState } from '@renderer/hooks/useTaskLocalState';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  append,
  applyCommand,
  childKey,
  emptySnapshot,
} from '../../../src/features/task-folders/core/domain/folders';
import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { FolderDialogs } from '../../../src/features/task-folders/renderer/ui/FolderDialogs';
import { FolderTree } from '../../../src/features/task-folders/renderer/ui/FolderTree';
import {
  projectFolders,
  UNFILED,
} from '../../../src/features/task-folders/renderer/view-models/projection';

import type { Snapshot } from '../../../src/features/task-folders/core/domain/folders';
import type { TaskFoldersHostModel } from '../../../src/features/task-folders/renderer/hooks/useTaskFoldersHost';
import type { Node } from '../../../src/features/task-folders/renderer/view-models/projection';
import type { TreeInstance } from '@headless-tree/core';
import type { GlobalTask } from '@shared/types';

const makeGlobalTask = (overrides: Partial<GlobalTask> = {}): GlobalTask => ({
  id: '1',
  teamName: 't',
  teamDisplayName: 'Team',
  subject: 'Task',
  status: 'pending',
  ...overrides,
});

const fakeIsTeamOffline = vi.fn((teamName: string): boolean => teamName === 'offline-team');
const fakeGetOwnerColorName = vi.fn(
  (task: Pick<GlobalTask, 'teamName' | 'owner'>): string | null =>
    task.owner === 'alice' ? 'blue' : task.owner ? 'forest' : null
);

const vendor = vi.hoisted(() => ({ trees: [] as TreeInstance<Node>[], rowLimit: Infinity }));
vi.mock('@headless-tree/react', async (importOriginal) => {
  const real = await importOriginal<typeof import('@headless-tree/react')>();
  return {
    ...real,
    useTree: (...args: Parameters<typeof real.useTree<Node>>) => {
      const tree = real.useTree<Node>(...args);
      vendor.trees.push(tree);
      return tree;
    },
  };
});
// Layout is owned by Electron E2E. Render all projected rows here to exercise the real vendor state/rebuild and row interactions.
vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, vendor.rowLimit) }, (_, index) => ({
        index,
        start: index * 32,
      })),
    getTotalSize: () => count * 32,
    scrollToIndex: vi.fn(),
  }),
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  vendor.trees = [];
  vendor.rowLimit = Infinity;
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  host.remove();
  localStorage.clear();
  panelController.dispose();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
describe('shared task presentation and vendor external updates', () => {
  it('publishes archive, pin and rename across mounted consumers and preserves legacy keys on remount', async () => {
    function Probe({ writer }: { writer?: boolean }) {
      const local = useTaskLocalState();
      return (
        <div
          data-probe={writer ? 'writer' : 'reader'}
          data-archived={local.isArchived('t', '1')}
          data-pinned={local.isPinned('t', '1')}
          data-name={local.getRenamedSubject('t', '1')}
        >
          {writer && (
            <button
              onClick={() => {
                local.toggleArchive('t', '1');
                local.togglePin('t', '1');
                local.renameTask('t', '1', 'Edited');
              }}
            >
              change
            </button>
          )}
        </div>
      );
    }
    await act(async () =>
      root.render(
        <>
          <Probe writer />
          <Probe />
        </>
      )
    );
    await act(async () => host.querySelector('button')!.click());
    const reader = host.querySelector('[data-probe="reader"]')!;
    expect(reader.getAttribute('data-archived')).toBe('true');
    expect(reader.getAttribute('data-pinned')).toBe('true');
    expect(reader.getAttribute('data-name')).toBe('Edited');
    expect(JSON.parse(localStorage.getItem('taskArchivedIds')!)).toEqual(['t:1']);
    expect(JSON.parse(localStorage.getItem('taskPinnedIds')!)).toEqual(['t:1']);
    expect(JSON.parse(localStorage.getItem('taskRenamedSubjects')!)).toEqual({ 't:1': 'Edited' });
    await act(async () => root.render(null));
    await act(async () => root.render(<Probe />));
    expect(host.querySelector('[data-probe="reader"]')!.getAttribute('data-name')).toBe('Edited');
  });
  it('rebuilds committed external CRUD/move projections immediately without requiring collapse/expand', async () => {
    const tasks = [makeGlobalTask()];
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'a',
      name: 'A',
      parent: null,
    });
    let publish!: React.Dispatch<React.SetStateAction<Snapshot>>;
    function Harness() {
      const [s, set] = useState(snapshot);
      publish = set;
      const local = useTaskLocalState();
      const projection = projectFolders(s, tasks, local.isArchived, local.getRenamedSubject, true);
      const model = {
        projection,
        contextId: 'local',
        local,
        state: { status: 'ready', snapshot: s },
        panel: { dragSource: null },
        openTask: vi.fn(),
        markUnread: vi.fn(),
        isTeamOffline: fakeIsTeamOffline,
        getOwnerColorName: fakeGetOwnerColorName,
      } as unknown as TaskFoldersHostModel;
      return (
        <TooltipProvider>
          <FolderTree model={model} dialog={vi.fn()} focusRequest={null} />
        </TooltipProvider>
      );
    }
    await act(async () => root.render(<Harness />));
    expect(host.querySelector('[data-folder-id="a"]')).not.toBeNull();
    snapshot = applyCommand(snapshot, { type: 'create', id: 'b', name: 'B', parent: null });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')).not.toBeNull();
    for (const id of ['a', 'b'])
      await act(async () =>
        (
          host.querySelector(
            `[data-folder-id="${id}"] [aria-label="taskFolders.expand"]`
          ) as HTMLButtonElement
        ).click()
      );
    snapshot = applyCommand(snapshot, {
      type: 'moveTask',
      identity: { teamName: 't', taskId: '1' },
      parent: 'b',
      anchor: append,
    });
    await act(async () => publish(snapshot));
    expect(host.querySelectorAll('[data-task-key]')).toHaveLength(1);
    expect(host.querySelector('[data-task-key]')!.getAttribute('aria-level')).toBe('2');
    snapshot = applyCommand(snapshot, { type: 'rename', id: 'b', name: 'Renamed' });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')!.textContent).toContain('Renamed');
    await act(async () => (host.querySelector('[data-folder-id="b"]') as HTMLElement).click());
    snapshot = applyCommand(snapshot, { type: 'delete', id: 'b' });
    await act(async () => publish(snapshot));
    expect(host.querySelector('[data-folder-id="b"]')).toBeNull();
    expect(host.querySelector('[data-folder-id="a"]')!.getAttribute('aria-selected')).toBe('true');
    expect(host.querySelector('[data-folder-id="a"]')!.getAttribute('tabindex')).toBe('0');
    expect(host.querySelectorAll('[data-task-key]')).toHaveLength(1);
  });
});

it('keeps a saving confirmation visible and held through Escape until its command settles', async () => {
  vi.useFakeTimers();
  vi.spyOn(folderController, 'getSnapshot').mockReturnValue({
    snapshot: emptySnapshot(),
    status: 'ready',
    pending: 0,
    error: null,
  });
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.spyOn(folderController, 'execute').mockImplementation(async () => {
    await gate;
    return emptySnapshot();
  });
  panelController.hold('dialog', true);
  function Harness() {
    const [open, setOpen] = useState(true);
    return (
      <FolderDialogs
        action={open ? { kind: 'delete', id: 'a' } : null}
        close={() => setOpen(false)}
        projection={projectFolders(
          emptySnapshot(),
          [],
          () => false,
          () => undefined,
          true
        )}
        move={null}
        created={vi.fn()}
        renameTask={vi.fn()}
      />
    );
  }
  await act(async () => root.render(<Harness />));
  const confirmation = [...document.querySelectorAll('button')].find(
    (button) => button.textContent === 'taskFolders.deleteFolder'
  )!;
  await act(async () => confirmation.click());
  await act(async () =>
    document
      .querySelector('[role="dialog"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  await act(async () => vi.advanceTimersByTime(2500));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => {
    release();
    await gate;
    await Promise.resolve();
  });
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

function treeHarness(tasks: GlobalTask[], snapshot = emptySnapshot(), showArchived = true) {
  const openTask = vi.fn();
  let update!: (next: {
    tasks?: GlobalTask[];
    snapshot?: Snapshot;
    shown?: boolean;
    status?: TaskFoldersHostModel['state']['status'];
    showArchived?: boolean;
  }) => void;
  function Harness() {
    const [state, set] = useState({
      tasks,
      snapshot,
      shown: true,
      status: 'ready' as TaskFoldersHostModel['state']['status'],
      showArchived,
    });
    update = (next) => set((previous) => ({ ...previous, ...next }));
    const local = useTaskLocalState();
    const model = {
      projection: projectFolders(
        state.snapshot,
        state.tasks,
        local.isArchived,
        local.getRenamedSubject,
        state.showArchived
      ),
      contextId: 'local',
      local,
      state: { status: state.status, snapshot: state.snapshot },
      panel: panelController.getSnapshot(),
      openTask,
      markUnread: vi.fn(),
      isTeamOffline: fakeIsTeamOffline,
      getOwnerColorName: fakeGetOwnerColorName,
    } as unknown as TaskFoldersHostModel;
    return (
      <TooltipProvider>
        {state.shown && <FolderTree model={model} dialog={vi.fn()} focusRequest={null} />}
      </TooltipProvider>
    );
  }
  return {
    Harness,
    openTask,
    update: (next: Parameters<typeof update>[0]) => update(next),
  };
}

it('keeps folder rename closed during non-ready loading and opens after readiness changes', async () => {
  const fixture = treeHarness(
    [],
    applyCommand(emptySnapshot(), { type: 'create', id: 'a', name: 'A', parent: null })
  );
  await act(async () => root.render(<fixture.Harness />));
  const row = host.querySelector('[data-folder-id="a"]')!;
  await act(async () => fixture.update({ status: 'loading' }));
  expect(
    (row.querySelector('[data-testid="task-folder-drag-handle"]') as HTMLButtonElement).disabled
  ).toBe(true);
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  expect(row.querySelector('input')).toBeNull();
  await act(async () => fixture.update({ status: 'ready' }));
  expect(
    (row.querySelector('[data-testid="task-folder-drag-handle"]') as HTMLButtonElement).disabled
  ).toBe(false);
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  expect(row.querySelector('input')).not.toBeNull();
});

it('reports storage failure for a valid inline folder name as a save error', async () => {
  const fixture = treeHarness(
    [],
    applyCommand(emptySnapshot(), { type: 'create', id: 'a', name: 'A', parent: null })
  );
  vi.spyOn(folderController, 'execute').mockRejectedValue(new Error('quota'));
  await act(async () => root.render(<fixture.Harness />));
  const row = host.querySelector('[data-folder-id="a"]')!;
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  const input = row.querySelector('input')!;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLInputElement.prototype,
      'value'
    )!.set!;
    setter.call(input, 'Valid name');
    input.dispatchEvent(new Event('input', { bubbles: true }));
  });
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  expect(row.querySelector('[role="alert"]')?.textContent).toBe('taskFolders.saveError');
  expect(row.querySelector('[role="alert"]')?.textContent).not.toBe('taskFolders.invalidName');
});

it.each([false, true])(
  'opens an arrow-focused task with Enter (archived=%s), preserving nested controls',
  async (archived) => {
    if (archived) localStorage.setItem('taskArchivedIds', JSON.stringify(['t:1']));
    const fixture = treeHarness([makeGlobalTask()]);
    await act(async () => root.render(<fixture.Harness />));
    const unfiled = host.querySelector(
      '[role="treeitem"][aria-label="taskFolders.unfiled"]'
    ) as HTMLElement;
    await act(async () => unfiled.focus());
    await act(async () =>
      unfiled.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true }))
    );
    const row = host.querySelector('[data-task-key]') as HTMLElement;
    expect(row.getAttribute('tabindex')).toBe('0');
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));
    expect(document.activeElement).toBe(row);
    expect(row.getAttribute('aria-label')).toBe(archived ? 'Task (taskFolders.archived)' : 'Task');
    expect(row.querySelector('[draggable="true"]')).not.toBeNull();
    await act(async () =>
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    );
    expect(fixture.openTask).toHaveBeenCalledExactlyOnceWith('t', '1');
    const button = row.querySelector('[aria-label="taskFolders.actions"]') as HTMLButtonElement;
    await act(async () => button.focus());
    await act(async () =>
      button.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    );
    expect(fixture.openTask).toHaveBeenCalledTimes(1);
    await act(async () =>
      row.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
      )
    );
    expect(fixture.openTask).toHaveBeenCalledTimes(1);
  }
);

it('keeps Enter in the folder rename editor and nested buttons from triggering row actions', async () => {
  const fixture = treeHarness(
    [],
    applyCommand(emptySnapshot(), { type: 'create', id: 'a', name: 'A', parent: null })
  );
  const execute = vi.spyOn(folderController, 'execute').mockResolvedValue(emptySnapshot());
  await act(async () => root.render(<fixture.Harness />));
  const row = host.querySelector('[data-folder-id="a"]') as HTMLElement;
  const expand = row.querySelector('button[aria-label="taskFolders.expand"]')!;
  await act(async () =>
    expand.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  expect(row.querySelector('input')).toBeNull();
  await act(async () =>
    row.dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  const input = row.querySelector('input')!;
  await act(async () =>
    input.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true })
    )
  );
  expect(execute).not.toHaveBeenCalled();
  await act(async () =>
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  expect(execute).toHaveBeenCalledOnce();
  expect(execute.mock.calls[0][0]).toEqual({ type: 'rename', id: 'a', name: 'A' });
  expect(execute.mock.calls[0][1]).toEqual(expect.any(String));
  expect(fixture.openTask).not.toHaveBeenCalled();
});

it('uses shared native buttons for tree drag, disclosure and dropdown controls', async () => {
  const fixture = treeHarness(
    [makeGlobalTask()],
    applyCommand(emptySnapshot(), { type: 'create', id: 'a', name: 'A', parent: null })
  );
  await act(async () => root.render(<fixture.Harness />));

  const folderRow = host.querySelector('[data-folder-id="a"]')!;
  const folderDrag = folderRow.querySelector<HTMLButtonElement>(
    '[data-testid="task-folder-drag-handle"]'
  )!;
  const disclosure = folderRow.querySelector<HTMLButtonElement>(
    '[aria-label="taskFolders.expand"]'
  )!;
  const actions = folderRow.querySelector<HTMLButtonElement>(
    '[aria-label="taskFolders.actions"]'
  )!;
  const taskRow = host.querySelector('[data-task-key]')!;
  const taskDrag = taskRow.querySelector<HTMLButtonElement>(
    '[data-testid="sidebar-task-drag-handle"]'
  )!;

  for (const control of [folderDrag, disclosure, actions, taskDrag]) {
    expect(control.tagName).toBe('BUTTON');
    expect(control.type).toBe('button');
    expect(control.title).toBe('');
    expect(control.className).toContain('size-5');
    expect(control.className).toContain('focus-visible:ring-1');
  }
  expect(folderDrag.tabIndex).toBe(-1);
  expect(folderDrag.disabled).toBe(false);
  expect(folderDrag.getAttribute('draggable')).toBe('true');
  expect(taskDrag.getAttribute('draggable')).toBe('true');
  expect(taskRow.contains(taskDrag)).toBe(true);
  expect(taskRow.querySelector('[role="button"]')).toBeNull();
});

it.each([
  ['context', 'click'],
  ['context', 'keyboard'],
  ['dropdown', 'click'],
  ['dropdown', 'keyboard'],
] as const)(
  'keeps a real %s menu %s activation from toggling the folder row',
  async (kind, activation) => {
    const fixture = treeHarness(
      [],
      applyCommand(emptySnapshot(), { type: 'create', id: 'a', name: 'A', parent: null })
    );
    await act(async () => root.render(<fixture.Harness />));
    const row = host.querySelector('[data-folder-id="a"]') as HTMLElement;
    const tree = vendor.trees[0];
    await act(async () =>
      (row.querySelector('[aria-label="taskFolders.expand"]') as HTMLButtonElement).click()
    );
    expect(tree.getItemInstance('folder:a').isExpanded()).toBe(true);

    if (kind === 'context') {
      await act(async () =>
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
      );
    } else {
      await act(async () =>
        row
          .querySelector('[aria-label="taskFolders.actions"]')!
          .dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
          )
      );
    }
    const rename = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'taskFolders.renameFolder'
    )!;
    expect(rename).toBeDefined();
    await act(async () => {
      if (activation === 'click') rename.click();
      else
        rename.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(tree.getItemInstance('folder:a').isExpanded()).toBe(true);
    expect(host.querySelector('[data-folder-id="a"]')).not.toBeNull();
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect((host.querySelector('[data-folder-id="a"] input') as HTMLInputElement).value).toBe('A');
  }
);

it.each([
  ['context', 'click'],
  ['context', 'keyboard'],
  ['dropdown', 'click'],
  ['dropdown', 'keyboard'],
] as const)(
  'keeps a real %s menu %s activation from opening a task row',
  async (kind, activation) => {
    const fixture = treeHarness([makeGlobalTask()]);
    await act(async () => root.render(<fixture.Harness />));
    const row = host.querySelector('[data-task-key]') as HTMLElement;

    if (kind === 'context') {
      await act(async () =>
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }))
      );
    } else {
      await act(async () =>
        row
          .querySelector('[aria-label="taskFolders.actions"]')!
          .dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
          )
      );
    }
    const pin = [...document.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
      (item) => item.textContent === 'taskContextMenu.pin'
    )!;
    expect(pin).toBeDefined();
    await act(async () => {
      if (activation === 'click') pin.click();
      else
        pin.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
        );
    });
    await act(async () => new Promise((resolve) => setTimeout(resolve, 20)));

    expect(fixture.openTask).not.toHaveBeenCalled();
    expect(row.getAttribute('aria-selected')).toBe('false');
    expect(JSON.parse(localStorage.getItem('taskPinnedIds')!)).toEqual(['t:1']);
  }
);

it.each(['context', 'dropdown'] as const)(
  'releases an open real portaled %s menu on catalog removal with a full grace period',
  async (kind) => {
    vi.useFakeTimers();
    const fixture = treeHarness([makeGlobalTask()]);
    panelController.begin('external');
    panelController.end();
    await act(async () => root.render(<fixture.Harness />));
    const row = host.querySelector('[data-task-key]')!;
    await act(async () => {
      if (kind === 'context')
        row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, button: 2 }));
      else
        row
          .querySelector('[aria-label="taskFolders.actions"]')!
          .dispatchEvent(
            new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
          );
    });
    expect(document.querySelector('[role="menu"]')).not.toBeNull();
    expect(host.querySelector('[role="menu"]')).toBeNull();
    expect(panelController.escape()).toBe(false);
    await act(async () => vi.advanceTimersByTime(4000));
    expect(panelController.getSnapshot().open).toBe(true);
    await act(async () => fixture.update({ tasks: [] }));
    expect(document.querySelector('[role="menu"]')).toBeNull();
    await act(async () => vi.advanceTimersByTime(1999));
    expect(panelController.getSnapshot().open).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(panelController.getSnapshot().open).toBe(false);
  }
);

it('releases a menu owner when its row is virtualized away and on tree unmount', async () => {
  vi.useFakeTimers();
  const fixture = treeHarness([makeGlobalTask()]);
  await act(async () => root.render(<fixture.Harness />));
  const row = host.querySelector('[data-task-key]')!;
  await act(async () => row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true })));
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  vendor.rowLimit = 1;
  await act(async () => fixture.update({}));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  await act(async () => vi.advanceTimersByTime(2000));
  expect(panelController.getSnapshot().open).toBe(false);
  vendor.rowLimit = Infinity;
  await act(async () => fixture.update({}));
  await act(async () =>
    host
      .querySelector('[data-task-key]')!
      .dispatchEvent(new MouseEvent('contextmenu', { bubbles: true }))
  );
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  await act(async () => fixture.update({ shown: false }));
  await act(async () => vi.advanceTimersByTime(2000));
  expect(panelController.getSnapshot().open).toBe(false);
});

it('removes deleted expanded IDs using real vendor state and cancels projection repair frames on change/unmount', async () => {
  const frames = new Map<number, FrameRequestCallback>();
  let serial = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    frames.set(++serial, callback);
    return serial;
  });
  const cancel = vi.fn((id: number) => frames.delete(id));
  vi.stubGlobal('cancelAnimationFrame', cancel);
  let snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'a',
    name: 'A',
    parent: null,
  });
  snapshot = applyCommand(snapshot, { type: 'create', id: 'b', name: 'B', parent: null });
  snapshot = applyCommand(snapshot, { type: 'create', id: 'c', name: 'C', parent: null });
  const fixture = treeHarness([], snapshot);
  await act(async () => root.render(<fixture.Harness />));
  const tree = vendor.trees.at(-1)!;
  await act(async () => {
    tree.getItemInstance('folder:b').expand();
    tree.getItemInstance('folder:b').setFocused();
  });
  snapshot = applyCommand(snapshot, { type: 'delete', id: 'b' });
  await act(async () => fixture.update({ snapshot }));
  expect(tree.getState().expandedItems).not.toContain('folder:b');
  expect(frames.size).toBe(1);
  const stale = [...frames.values()][0];
  const scroll = vi.spyOn(tree.getItemInstance('folder:c'), 'scrollTo');
  const focus = vi.spyOn(tree, 'updateDomFocus');
  const repairs = focus.mock.calls.length;
  await act(async () => fixture.update({ snapshot: { ...snapshot } }));
  expect(frames.size).toBe(0);
  stale(0);
  expect(scroll).not.toHaveBeenCalled();
  expect(focus).toHaveBeenCalledTimes(repairs);
  await act(async () => {
    tree.getItemInstance('folder:a').setFocused();
  });
  await act(async () => fixture.update({ snapshot: emptySnapshot() }));
  expect(frames.size).toBe(1);
  const unmounted = [...frames.values()][0];
  await act(async () => fixture.update({ shown: false }));
  expect(frames.size).toBe(0);
  unmounted(0);
  expect(cancel).toHaveBeenCalledTimes(2);
});

it('repairs hidden task focus to its still-present containing folder', async () => {
  const identity = { teamName: 't', taskId: '1' };
  let snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'a',
    name: 'A',
    parent: null,
  });
  snapshot = applyCommand(snapshot, { type: 'create', id: 'b', name: 'B', parent: null });
  snapshot = applyCommand(snapshot, {
    type: 'moveTask',
    identity,
    parent: 'a',
    anchor: append,
  });
  const fixture = treeHarness(
    [makeGlobalTask({ id: identity.taskId, teamName: identity.teamName })],
    snapshot
  );
  await act(async () => root.render(<fixture.Harness />));
  const tree = vendor.trees.at(-1)!;
  const task = childKey({ kind: 'task', identity });
  await act(async () => {
    tree.getItemInstance('folder:a').expand();
    tree.getItemInstance(task).setFocused();
  });
  expect(tree.getState().focusedItem).toBe(task);

  await act(async () => fixture.update({ tasks: [] }));
  expect(tree.getState().focusedItem).toBe('folder:a');
});

it('repairs hidden archived Unfiled task focus to Unfiled when custom roots remain', async () => {
  localStorage.setItem('taskArchivedIds', JSON.stringify(['t:1']));
  const identity = { teamName: 't', taskId: '1' };
  const snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'custom-root',
    name: 'Custom Root',
    parent: null,
  });
  const fixture = treeHarness(
    [makeGlobalTask({ id: identity.taskId, teamName: identity.teamName })],
    snapshot,
    true
  );
  await act(async () => root.render(<fixture.Harness />));
  const tree = vendor.trees.at(-1)!;
  const task = childKey({ kind: 'task', identity });
  await act(async () => tree.getItemInstance(task).setFocused());
  expect(tree.getState().focusedItem).toBe(task);

  await act(async () => fixture.update({ showArchived: false }));

  expect(host.querySelector('[data-folder-id="custom-root"]')).not.toBeNull();
  expect(host.querySelector('[data-task-key]')).toBeNull();
  expect(tree.getState().focusedItem).toBe(UNFILED);
});

it('does not update DOM focus after an already-started repair scroll settles for a stale projection', async () => {
  let next: FrameRequestCallback | undefined;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
    next = callback;
    return 1;
  });
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  let snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'a',
    name: 'A',
    parent: null,
  });
  snapshot = applyCommand(snapshot, { type: 'create', id: 'b', name: 'B', parent: null });
  const fixture = treeHarness([], snapshot);
  await act(async () => root.render(<fixture.Harness />));
  const tree = vendor.trees.at(-1)!;
  await act(async () => tree.getItemInstance('folder:b').setFocused());
  await act(async () =>
    fixture.update({ snapshot: applyCommand(snapshot, { type: 'delete', id: 'b' }) })
  );
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const scroll = vi.spyOn(tree.getItemInstance('folder:a'), 'scrollTo').mockReturnValue(pending);
  const focus = vi.spyOn(tree, 'updateDomFocus');
  next!(0);
  expect(scroll).toHaveBeenCalledTimes(1);
  const prior = focus.mock.calls.length;
  await act(async () => fixture.update({}));
  await act(async () => {
    release();
    await pending;
  });
  expect(focus).toHaveBeenCalledTimes(prior);
});

it('cancels a real internal vendor drag when catalog refresh removes its source without dragend', async () => {
  const fixture = treeHarness([makeGlobalTask()]);
  await act(async () => root.render(<fixture.Harness />));
  const tree = vendor.trees.at(-1)!;
  const handle = host.querySelector('[data-task-key] [draggable="true"]')!;
  await act(async () =>
    handle.dispatchEvent(new Event('dragstart', { bubbles: true, cancelable: true }))
  );
  expect(tree.getState().dnd?.draggedItems?.[0].getId()).toBe('task:["t","1"]');
  expect(panelController.getSnapshot().dragSource).toBe('task:["t","1"]');
  await act(async () => fixture.update({ tasks: [] }));
  expect(tree.getState().dnd).toBeNull();
  expect(panelController.getSnapshot().dragSource).toBeNull();
});

it('cancels vanished editors and ignores old async rename completion after a new session or unmount', async () => {
  vi.useFakeTimers();
  let snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'a',
    parent: null,
    name: 'A',
  });
  snapshot = applyCommand(snapshot, { type: 'create', id: 'b', parent: null, name: 'B' });
  const fixture = treeHarness([], snapshot);
  let finish!: (s: Snapshot) => void;
  const gate = new Promise<Snapshot>((resolve) => {
    finish = resolve;
  });
  vi.spyOn(folderController, 'execute').mockReturnValue(gate);
  panelController.begin('external');
  panelController.end();
  await act(async () => root.render(<fixture.Harness />));
  const rename = async (id: string) =>
    act(async () =>
      host
        .querySelector(`[data-folder-id="${id}"]`)!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    );
  await rename('a');
  await act(async () =>
    host
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  snapshot = applyCommand(snapshot, { type: 'delete', id: 'a' });
  await act(async () => fixture.update({ snapshot }));
  expect(host.querySelector('input')).toBeNull();
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(false);
  await rename('b');
  await act(async () => {
    finish(snapshot);
    await gate;
  });
  expect(host.querySelector('input')).not.toBeNull();
  expect(panelController.escape()).toBe(false);
  panelController.hold('edit:independent', true);
  await act(async () => fixture.update({ shown: false }));
  expect(panelController.escape()).toBe(false);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);
  panelController.hold('edit:independent', false);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(false);
});

it.each(['resolve', 'reject'] as const)(
  'keeps a directly replaced rename editor usable and protected through stale %s completion',
  async (outcome) => {
    vi.useFakeTimers();
    let snapshot = applyCommand(emptySnapshot(), {
      type: 'create',
      id: 'a',
      parent: null,
      name: 'A',
    });
    snapshot = applyCommand(snapshot, { type: 'create', id: 'b', parent: null, name: 'B' });
    const fixture = treeHarness([], snapshot);
    const pending: {
      promise: Promise<Snapshot>;
      resolve: (value: Snapshot) => void;
      reject: (error: Error) => void;
    }[] = [];
    const execute = vi.spyOn(folderController, 'execute').mockImplementation(() => {
      let resolve!: (value: Snapshot) => void;
      let reject!: (error: Error) => void;
      const promise = new Promise<Snapshot>((res, rej) => {
        resolve = res;
        reject = rej;
      });
      pending.push({ promise, resolve, reject });
      return promise;
    });
    panelController.begin('external');
    panelController.end();
    await act(async () => root.render(<fixture.Harness />));
    const rename = async (id: string) =>
      act(async () =>
        host
          .querySelector(`[data-folder-id="${id}"]`)!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
      );
    const submit = async () =>
      act(async () =>
        host
          .querySelector('input')!
          .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
      );

    await rename('a');
    await submit();
    expect(host.querySelector('input')!.disabled).toBe(true);
    await rename('b');
    expect(host.querySelector('input')!.value).toBe('B');
    expect(host.querySelector('input')!.disabled).toBe(false);

    const stale = pending[0];
    await act(async () => {
      if (outcome === 'resolve') stale.resolve(snapshot);
      else stale.reject(new Error('stale save'));
      await stale.promise.catch(() => undefined);
    });
    expect(host.querySelector('input')!.value).toBe('B');
    expect(host.querySelector('input')!.disabled).toBe(false);
    expect(host.querySelector('input')!.getAttribute('aria-invalid')).toBe('false');
    expect(panelController.escape()).toBe(false);

    await submit();
    expect(pending).toHaveLength(2);
    expect(host.querySelector('input')!.disabled).toBe(true);
    await act(async () => {
      pending[1].resolve(snapshot);
      await pending[1].promise;
    });
    expect(host.querySelector('input')).toBeNull();
    const operationIds = execute.mock.calls.map(([, operationId]) => operationId);
    expect(operationIds[0]).toEqual(expect.any(String));
    expect(operationIds[1]).toEqual(expect.any(String));
    expect(operationIds[0]).not.toBe(operationIds[1]);
  }
);

it('ignores a pending rename rejection after tree unmount and preserves the replacement editor', async () => {
  const snapshot = applyCommand(emptySnapshot(), {
    type: 'create',
    id: 'a',
    parent: null,
    name: 'A',
  });
  const fixture = treeHarness([], snapshot);
  let fail!: (error: Error) => void;
  const gate = new Promise<Snapshot>((_resolve, reject) => {
    fail = reject;
  });
  vi.spyOn(folderController, 'execute').mockReturnValue(gate);
  await act(async () => root.render(<fixture.Harness />));
  const rename = async () =>
    act(async () =>
      host
        .querySelector('[data-folder-id="a"]')!
        .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
    );
  await rename();
  await act(async () =>
    host
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
  );
  await act(async () => fixture.update({ shown: false }));
  await act(async () => fixture.update({ shown: true }));
  await rename();
  await act(async () => {
    fail(new Error('save'));
    await gate.catch(() => undefined);
  });
  expect(host.querySelector('input')!.getAttribute('aria-invalid')).toBe('false');
  expect(host.querySelector('input')!.disabled).toBe(false);
  expect(panelController.escape()).toBe(false);
  await act(async () =>
    host
      .querySelector('input')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(host.querySelector('input')).toBeNull();
});
