import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { taskFolderMoveRequest } from '../../../src/features/task-folders/renderer/adapters/taskFolderEditing';
import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { TaskFoldersHost } from '../../../src/features/task-folders/renderer/TaskFoldersHost';
import { TaskDragHandle } from '../../../src/features/task-folders/renderer/ui/TaskDragHandle';

import type { GlobalTask } from '@shared/types';

const makeGlobalTask = (overrides: Partial<GlobalTask> = {}): GlobalTask => ({
  id: '1',
  teamName: 't',
  teamDisplayName: 'Team',
  subject: 'Task',
  status: 'pending',
  ...overrides,
});

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key, resolvedLanguage: 'en' }),
}));
vi.mock('@tanstack/react-virtual', () => ({
  defaultRangeExtractor: () => [],
  useVirtualizer: ({ count }: { count: number }) => ({
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({ index, start: index * 32 })),
    getTotalSize: () => count * 32,
    scrollToIndex: vi.fn(),
  }),
}));
let root: ReturnType<typeof createRoot>;
let host: HTMLDivElement;
let sidebar: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  await folderController.reset();
  useStore.setState({ globalTasks: [makeGlobalTask()] });
  host = document.createElement('div');
  sidebar = document.createElement('div');
  document.body.append(host, sidebar);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  panelController.dispose();
  useStore.setState({ globalTasks: [] });
  host.remove();
  sidebar.remove();
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
async function renderAt(left: number) {
  vi.spyOn(sidebar, 'getBoundingClientRect').mockReturnValue({
    left,
    right: left + 280,
    top: 0,
    bottom: 800,
    width: 280,
    height: 800,
  } as DOMRect);
  const ref = createRef<HTMLDivElement>();
  ref.current = sidebar;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TaskDragHandle identity={{ teamName: 't', taskId: '1' }} subject="Task" />
        <TaskFoldersHost contextId="local" sidebar={ref} collapsed={false} />
      </TooltipProvider>
    )
  );
}
async function startSidebarDrag() {
  if (!panelController.getSnapshot().manual) {
    await act(() =>
      Promise.resolve(
        (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
      )
    );
  }
  const transfer = { setData: vi.fn(), setDragImage: vi.fn(), effectAllowed: 'none' };
  const event = new Event('dragstart', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', { value: transfer });
  const source = host.querySelector('[data-testid="sidebar-task-drag-handle"]') as HTMLElement;
  source.focus();
  await act(async () => source.dispatchEvent(event));
  expect(transfer.setData).toHaveBeenCalled();
  expect(transfer.effectAllowed).toBe('move');
  expect(panelController.getSnapshot().dragSource).toBe('task:["t","1"]');
  return source;
}
function mockPanelGeometry(panel: HTMLElement) {
  vi.spyOn(panel, 'getBoundingClientRect').mockReturnValue({
    left: 0,
    right: 300,
    top: 0,
    bottom: 800,
    width: 300,
    height: 800,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect);
}
async function dispatchDragEvent(type: 'dragover' | 'dragend' | 'drop', x?: number, y?: number) {
  const event = new Event(type, { bubbles: true, cancelable: true });
  if (x !== undefined && y !== undefined) {
    Object.defineProperties(event, {
      clientX: { value: x },
      clientY: { value: y },
    });
  }
  await act(async () => document.dispatchEvent(event));
}
async function dispatchTrustedPointerMove(x: number, y: number) {
  const event = new PointerEvent('pointermove', {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    pointerType: 'mouse',
  });
  Object.defineProperty(event, 'isTrusted', { value: true });
  await act(async () => document.dispatchEvent(event));
}
function capturePanelMutation(panel: HTMLElement, action: () => void): void {
  const observer = new MutationObserver(() => undefined);
  observer.observe(panel, { childList: true, subtree: true });
  let records: MutationRecord[] = [];
  act(action);
  records = observer.takeRecords();
  observer.disconnect();
  expect(records.some((record) => record.removedNodes.length > 0)).toBe(true);
}
function trackFocusReleaseAfterRemoval() {
  let arm = (): void => undefined;
  let released!: () => void;
  const focusReleased = new Promise<void>((resolve) => {
    released = resolve;
  });
  const hold = panelController.hold.bind(panelController);
  let armed = false;
  arm = (): void => {
    armed = true;
  };
  vi.spyOn(panelController, 'hold').mockImplementation((reason, active) => {
    hold(reason, active);
    if (armed && reason === 'focus' && !active) released();
  });
  return { arm, focusReleased };
}
it.each([0, 80, 239])('uses explicit folder mode for the narrow modal at %s px', async (left) => {
  await renderAt(left);
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
  await act(() =>
    Promise.resolve(
      (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
    )
  );
  const dialog = document.querySelector('[role="dialog"]')!;
  expect(dialog.getAttribute('aria-modal')).toBe('true');
  expect(dialog.contains(document.activeElement)).toBe(true);
  expect(
    host.querySelector('[data-testid="task-folders-toggle"]')!.getAttribute('aria-pressed')
  ).toBe('true');
  expect(document.querySelector('[data-testid="task-folders-tree"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).not.toBeNull();
  await act(() =>
    Promise.resolve(
      dialog.querySelector<HTMLButtonElement>('[aria-label="actions.close"]')!.click()
    )
  );
  expect(panelController.getSnapshot().manual).toBe(false);
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
});
it('absorbs the Escape finishing a cancelled drag inside the narrow modal', async () => {
  await renderAt(80);
  await act(() =>
    Promise.resolve(
      (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
    )
  );
  const panel = document.querySelector('[data-testid="task-folders-panel"]')!;
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  await act(async () => {
    panelController.begin('external');
    panelController.end();
  });
  const escape = () =>
    act(async () =>
      panel.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    );
  await escape();
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(panelController.getSnapshot()).toMatchObject({ open: true, manual: true });
  await escape();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(panelController.getSnapshot().manual).toBe(false);
});
it('keeps Manual Unfiled fresh while preserving authored folder order and persisted snapshot', async () => {
  const tasks = ['old', 'filed-old', 'middle', 'filed-new', 'new'].map((id, index) =>
    makeGlobalTask({ id, updatedAt: `2026-01-0${index + 1}T00:00:00.000Z` })
  );
  useStore.setState({ globalTasks: tasks });
  folderController.setCatalog(tasks.map(({ teamName, id }) => ({ teamName, taskId: id })));
  await folderController.execute({ type: 'create', id: 'ordered', name: 'Ordered', parent: null });
  for (const taskId of ['filed-old', 'filed-new']) {
    await folderController.execute({
      type: 'moveTask',
      identity: { teamName: 't', taskId },
      parent: 'ordered',
      anchor: { append: true },
    });
  }
  const snapshot = folderController.getSnapshot().snapshot;
  const persisted = localStorage.getItem('taskFolders:v1');
  await renderAt(300);
  await act(() => Promise.resolve(panelController.hold('manual', true)));
  const tree = document.querySelector('[data-testid="task-folders-tree"]')!;
  await act(() =>
    Promise.resolve(
      tree
        .querySelector<HTMLButtonElement>(
          '[data-folder-id="ordered"] [aria-label="taskFolders.expand"]'
        )!
        .click()
    )
  );
  const visibleOrder = () =>
    [...tree.querySelectorAll('[data-task-key]')].map(
      (row) => (JSON.parse(row.getAttribute('data-task-key')!) as [string, string])[1]
    );
  expect(visibleOrder()).toEqual(['filed-old', 'filed-new', 'new', 'middle', 'old']);

  await act(() =>
    Promise.resolve(
      useStore.setState({
        globalTasks: tasks.map((task) =>
          task.id === 'old' ? { ...task, updatedAt: '2026-01-06T00:00:00.000Z' } : task
        ),
      })
    )
  );
  expect(visibleOrder()).toEqual(['filed-old', 'filed-new', 'old', 'new', 'middle']);
  expect(folderController.getSnapshot().snapshot).toBe(snapshot);
  expect(snapshot.folders[0].children).toEqual([
    { kind: 'task', identity: { teamName: 't', taskId: 'filed-old' } },
    { kind: 'task', identity: { teamName: 't', taskId: 'filed-new' } },
  ]);
  expect(localStorage.getItem('taskFolders:v1')).toBe(persisted);
  expect(tasks.map((task) => task.id)).toEqual(['old', 'filed-old', 'middle', 'filed-new', 'new']);
});

it('keeps a same-window drag nonmodal with an adjacent usable panel at 240px', async () => {
  await renderAt(240);
  await startSidebarDrag();
  const panel = document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement;
  expect(panel).not.toBeNull();
  expect(panel.style.width).toBe('240px');
  expect(panel.getAttribute('role')).toBe('region');
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[data-radix-focus-guard]')).toBeNull();
  await act(async () => window.dispatchEvent(new Event('blur')));
  expect(panelController.getSnapshot().dragSource).toBeNull();
});
it('ignores a stale prior-session dragover when a later drag cancels outside without panel pointerleave', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragover', 200, 400);
  await dispatchDragEvent('dragend', 200, 400);
  await act(async () =>
    document
      .querySelector('[data-testid="task-folders-panel"]')!
      .dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: host }))
  );
  await act(async () => vi.advanceTimersByTime(2000));
  expect(panelController.getSnapshot().open).toBe(true);

  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragend', 301, 400);
  expect(panelController.getSnapshot().dragSource).toBeNull();
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});
it('reconciles cancellation outside the panel from trusted pointer movement without panel pointerleave', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragover', 200, 400);
  await dispatchTrustedPointerMove(301, 400);
  await dispatchDragEvent('dragend');
  expect(panelController.getSnapshot().dragSource).toBeNull();
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});
it('keeps enabled mode visible when trusted pointer movement leaves after release', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragover', 200, 400);
  await dispatchDragEvent('dragend', 200, 400);
  await act(async () => vi.advanceTimersByTime(2300));
  expect(panelController.getSnapshot().open).toBe(true);

  await dispatchTrustedPointerMove(301, 400);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});
it('keeps enabled mode visible beyond the former automatic release grace', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await dispatchTrustedPointerMove(200, 400);
  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragend');
  expect(panelController.getSnapshot().dragSource).toBeNull();
  await act(async () => vi.advanceTimersByTime(2300));
  expect(panelController.getSnapshot().open).toBe(true);
});
it('restores normal keyboard focus when an action menu closes without a pending action', async () => {
  await folderController.execute({ type: 'create', id: 'a', parent: null, name: 'A' });
  await renderAt(300);
  await act(async () => {
    panelController.hold('manual', true);
    panelController.begin('external');
    panelController.end();
  });
  const trigger = document.querySelector(
    '[data-folder-id="a"] [aria-label="taskFolders.actions"]'
  ) as HTMLButtonElement;
  await act(async () => trigger.focus());
  await act(async () =>
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
    )
  );
  const menu = document.querySelector('[role="menu"]')!;
  expect(menu).not.toBeNull();
  await act(async () =>
    menu.dispatchEvent(
      new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
    )
  );
  await act(async () => new Promise<void>((resolve) => setTimeout(resolve, 0)));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.activeElement).toBe(trigger);
  expect(panelController.getSnapshot().open).toBe(true);
});
it('restores row focus after a deferred state-only action', async () => {
  await renderAt(300);
  await act(async () => {
    panelController.hold('manual', true);
    panelController.begin('external');
    panelController.end();
  });
  const trigger = document.querySelector(
    '[data-task-key] [aria-label="taskFolders.actions"]'
  ) as HTMLButtonElement;
  await act(async () => trigger.focus());
  await act(async () =>
    trigger.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
    )
  );
  const pin = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'taskContextMenu.pin'
  ) as HTMLElement;
  await act(async () => pin.click());
  await act(async () => {
    await vi.waitFor(
      () => {
        if (document.activeElement !== trigger)
          throw new Error('Menu trigger focus was not restored');
      },
      { timeout: 1000, interval: 10 }
    );
  });
  expect(JSON.parse(localStorage.getItem('taskPinnedIds')!)).toEqual(['t:1']);
});
it('toggles sticky folder mode and sidebar handles without incidental holds reopening OFF mode', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="task-folders-toggle"]')!;
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
  await act(() => Promise.resolve(toggle.click()));
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).not.toBeNull();
  await act(() => Promise.resolve(window.dispatchEvent(new Event('blur'))));
  await act(() => Promise.resolve(vi.advanceTimersByTime(5000)));
  expect(document.querySelector('[data-testid="task-folders-panel"]')).not.toBeNull();
  await act(() => Promise.resolve(toggle.click()));
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).toBeNull();
  await act(() =>
    Promise.resolve(
      (['pointer', 'focus', 'dialog', 'menu'] as const).forEach((reason) =>
        panelController.hold(reason, true)
      )
    )
  );
  await act(() => Promise.resolve(panelController.begin('stale-off-drag')));
  await act(() => Promise.resolve(vi.advanceTimersByTime(5000)));
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
  expect(panelController.getSnapshot().manual).toBe(false);
  await act(() => Promise.resolve(toggle.click()));
  expect(document.querySelector('[data-testid="task-folders-panel"]')).not.toBeNull();
  await renderAt(300);
  expect(panelController.getSnapshot().manual).toBe(true);
});

it('opens the explicit move chooser while mode is OFF without reopening the companion', async () => {
  await renderAt(300);
  expect(panelController.getSnapshot().manual).toBe(false);
  await act(() => Promise.resolve(taskFolderMoveRequest.open({ teamName: 't', taskId: '1' })));
  expect(document.querySelector('[role="dialog"]')).not.toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
  expect(host.querySelector('[data-testid="sidebar-task-drag-handle"]')).toBeNull();
  expect(panelController.getSnapshot()).toMatchObject({
    open: false,
    manual: false,
    dragSource: null,
  });
  await act(() => Promise.resolve(taskFolderMoveRequest.close()));
  expect(document.querySelector('[role="dialog"]')).toBeNull();
});

it('resubmits the same create operation and panel Retry preserves only independent failures', async () => {
  await renderAt(300);
  const storage = vi
    .spyOn(localStorage, 'setItem')
    .mockImplementationOnce(() => {
      throw new Error('independent');
    })
    .mockImplementationOnce(() => {
      throw new Error('dialog');
    });
  await act(async () => {
    await expect(
      folderController.execute({ type: 'create', id: 'independent', parent: null, name: 'Other' })
    ).rejects.toThrow('independent');
    panelController.hold('manual', true);
    panelController.begin('external');
    panelController.end();
  });
  await act(async () =>
    (document.querySelector('[data-testid="task-folders-new-folder"]') as HTMLButtonElement).click()
  );
  const input = document.querySelector(
    'input[aria-label="taskFolders.folderName"]'
  ) as HTMLInputElement;
  const change = async (name: string) =>
    act(async () => {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, name);
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
  const submit = () =>
    [...document.querySelectorAll('[role="dialog"] button')].find(
      (button) => button.textContent === 'taskFolders.newFolder'
    ) as HTMLButtonElement;
  await change('');
  await act(async () => submit().click());
  expect(storage).toHaveBeenCalledTimes(1); // name validation never enters storage Retry
  await change('One');
  await act(async () => submit().click());
  expect(document.querySelector('input[aria-label="taskFolders.folderName"]')).not.toBeNull();
  expect(folderController.getSnapshot().snapshot.folders).toHaveLength(0);
  await change('Revised');
  await act(async () => submit().click());
  expect(document.querySelector('input[aria-label="taskFolders.folderName"]')).toBeNull();
  expect(folderController.getSnapshot().snapshot.folders.map((f) => f.name)).toEqual(['Revised']);
  expect(folderController.getSnapshot().error).toBe('independent');
  await act(async () =>
    (
      [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'taskFolders.retry'
      ) as HTMLButtonElement
    ).click()
  );
  expect(folderController.getSnapshot().snapshot.folders.map((f) => f.name)).toEqual([
    'Revised',
    'Other',
  ]);
  expect(folderController.getSnapshot().error).toBeNull();
  await act(async () => folderController.retry());
  expect(folderController.getSnapshot().snapshot.folders).toHaveLength(2);
  expect(storage).toHaveBeenCalledTimes(4);
  expect(folderController.getSnapshot().pending).toBe(0);
});

it('keeps the page interactive after a menu-launched nested folder dialog closes', async () => {
  await folderController.execute({ type: 'create', id: 'parent', parent: null, name: 'Parent' });
  await renderAt(300);
  await act(async () => {
    panelController.hold('manual', true);
    panelController.begin('external');
    panelController.end();
  });
  const actions = document.querySelector(
    '[data-folder-id="parent"] [aria-label="taskFolders.actions"]'
  ) as HTMLButtonElement;
  await act(async () => actions.focus());
  const restoredToTrigger = vi.fn();
  actions.addEventListener('focus', restoredToTrigger);
  await act(async () =>
    actions.dispatchEvent(
      new PointerEvent('pointerdown', { bubbles: true, button: 0, ctrlKey: false })
    )
  );
  const newSubfolder = [...document.querySelectorAll('[role="menuitem"]')].find(
    (item) => item.textContent === 'taskFolders.newSubfolder'
  ) as HTMLElement;
  await act(async () => newSubfolder.click());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  let input!: HTMLInputElement;
  await act(async () => {
    input = await vi.waitFor(
      () => {
        const next = document.querySelector<HTMLInputElement>(
          'input[aria-label="taskFolders.folderName"]'
        );
        if (!next) throw new Error('Deferred folder dialog input did not mount');
        return next;
      },
      { timeout: 1000, interval: 10 }
    );
  });
  expect(restoredToTrigger).not.toHaveBeenCalled();
  await act(async () => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, 'Child');
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  });
  await act(async () => Promise.resolve());
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(document.querySelector('[role="menu"]')).toBeNull();
  expect(document.body.style.pointerEvents).not.toBe('none');
  expect(
    folderController.getSnapshot().snapshot.folders.map((folder) => [folder.id, folder.name])
  ).toEqual([
    ['parent', 'Parent'],
    [expect.any(String), 'Child'],
  ]);
});

it('cleans rename holds across wide/narrow/wide transitions while mode stays pinned until Escape', async () => {
  vi.useFakeTimers();
  await folderController.execute({ type: 'create', id: 'a', parent: null, name: 'A' });
  await renderAt(300);
  await startSidebarDrag();
  await act(async () => window.dispatchEvent(new Event('blur')));
  await act(async () =>
    document
      .querySelector('[data-folder-id="a"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  expect(document.querySelector('input[aria-label="taskFolders.renameFolder"]')).not.toBeNull();
  await act(async () => vi.advanceTimersByTime(4000));
  await renderAt(80);
  expect(document.querySelector('input[aria-label="taskFolders.renameFolder"]')).toBeNull();
  await renderAt(300);
  expect(document.querySelector('input[aria-label="taskFolders.renameFolder"]')).toBeNull();
  await act(async () => panelController.hold('pointer', true));
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => {
    panelController.hold('focus', false);
    panelController.hold('pointer', false);
  });
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () =>
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(panelController.getSnapshot().open).toBe(false);
});

it('reconciles a focused editor unmount without ancestor blur while keeping enabled mode pinned', async () => {
  vi.useFakeTimers();
  await folderController.execute({ type: 'create', id: 'a', parent: null, name: 'A' });
  await renderAt(300);
  await startSidebarDrag();
  await act(async () => window.dispatchEvent(new Event('blur')));
  const panel = document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement;
  await act(async () =>
    panel
      .querySelector('[data-folder-id="a"]')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'F2', bubbles: true }))
  );
  const editor = panel.querySelector<HTMLInputElement>(
    'input[aria-label="taskFolders.renameFolder"]'
  )!;
  editor.focus();
  expect(document.activeElement).toBe(editor);

  // Browser removal may move focus to BODY without delivering the React blur path.
  const focusRelease = trackFocusReleaseAfterRemoval();
  focusRelease.arm();
  capturePanelMutation(panel, () =>
    editor.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(panel.querySelector('input[aria-label="taskFolders.renameFolder"]')).toBeNull();
  expect(document.activeElement).toBe(document.body);
  await act(async () => focusRelease.focusReleased);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});

it('keeps current replacement focus inside the live panel after a descendant is removed', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await startSidebarDrag();
  await act(async () => window.dispatchEvent(new Event('blur')));
  const panel = document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement;
  const removed = document.createElement('button');
  const replacement = document.createElement('button');
  panel.append(removed);
  await act(async () => removed.focus());
  panel.append(replacement);
  await act(async () => replacement.focus());
  capturePanelMutation(panel, () => removed.remove());
  expect(document.activeElement).toBe(replacement);
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);

  const focusRelease = trackFocusReleaseAfterRemoval();
  focusRelease.arm();
  capturePanelMutation(panel, () => {
    replacement.remove();
    panel.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true }));
  });
  await act(async () => focusRelease.focusReleased);
  expect(document.activeElement).toBe(document.body);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});

it('releases only focus when removed descendant focus transfers outside the live panel', async () => {
  vi.useFakeTimers();
  await renderAt(300);
  await startSidebarDrag();
  await act(async () => window.dispatchEvent(new Event('blur')));
  const panel = document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement;
  const removed = document.createElement('button');
  panel.append(removed);
  await act(async () => removed.focus());
  expect(document.activeElement).toBe(removed);
  const outside = host.querySelector('[data-testid="sidebar-task-drag-handle"]') as HTMLElement;

  const focusRelease = trackFocusReleaseAfterRemoval();
  focusRelease.arm();
  capturePanelMutation(panel, () => {
    removed.remove();
    outside.focus();
  });
  await act(async () => focusRelease.focusReleased);
  expect(document.activeElement).toBe(outside);
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(true);
});

it.each(['edit:replacement', 'menu:replacement', 'dialog', 'pointer'] as const)(
  'retains independent %s hold cleanup without disabling sticky mode',
  async (hold) => {
    vi.useFakeTimers();
    await renderAt(300);
    await startSidebarDrag();
    await act(async () => window.dispatchEvent(new Event('blur')));

    await act(async () => panelController.hold(hold, true));
    await act(async () => vi.advanceTimersByTime(4000));
    expect(panelController.getSnapshot().open).toBe(true);

    await act(async () => panelController.hold(hold, false));
    await act(async () => vi.advanceTimersByTime(1999));
    expect(panelController.getSnapshot().open).toBe(true);
    await act(async () => vi.advanceTimersByTime(1));
    expect(panelController.getSnapshot().open).toBe(true);
  }
);
