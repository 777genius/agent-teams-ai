import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { TaskFoldersHost } from '../../../src/features/task-folders/renderer/TaskFoldersHost';
import { TaskDragHandle } from '../../../src/features/task-folders/renderer/ui/TaskDragHandle';

import type { GlobalTask } from '@shared/types';
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
  useStore.setState({ globalTasks: [{ teamName: 't', id: '1', subject: 'Task' }] as GlobalTask[] });
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
        <TaskFoldersHost sidebar={ref} collapsed={false} />
      </TooltipProvider>
    )
  );
}
async function startSidebarDrag() {
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
it.each([0, 80, 239])(
  'uses only the manual button fallback at %s px without introducing a drag modal or drop surface',
  async (left) => {
    await renderAt(left);
    const source = await startSidebarDrag();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
    expect(document.querySelector('[data-testid="task-folders-tree"]')).toBeNull();
    expect(document.querySelector('[data-radix-focus-guard]')).toBeNull();
    expect(document.activeElement).toBe(source);
    await act(async () => window.dispatchEvent(new Event('blur')));
    expect(panelController.getSnapshot().dragSource).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
    await act(async () =>
      (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
    );
    expect(document.querySelector('[role="dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="task-folders-tree"]')).not.toBeNull();
    expect(
      document.querySelector('[data-testid="task-folders-toggle"]')!.getAttribute('aria-expanded')
    ).toBe('true');
  }
);
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
  expect(panelController.getSnapshot().open).toBe(false);

  await startSidebarDrag();
  mockPanelGeometry(document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement);
  await dispatchDragEvent('dragend', 301, 400);
  expect(panelController.getSnapshot().dragSource).toBeNull();
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(false);
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
  expect(panelController.getSnapshot().open).toBe(false);
});
it('restarts the complete grace period when trusted pointer movement leaves after release', async () => {
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
  expect(panelController.getSnapshot().open).toBe(false);
});
it('keeps a stationary pointer inside the current panel beyond the full release grace', async () => {
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
    await vi.waitFor(() => {
      if (document.activeElement !== trigger) throw new Error('Menu trigger focus was not restored');
    }, { timeout: 1000, interval: 10 });
  });
  expect(JSON.parse(localStorage.getItem('taskPinnedIds')!)).toEqual(['t:1']);
});
it('registers manual fallback pointer/focus/dialog and real portaled menu holds and releases full grace after the final hold', async () => {
  vi.useFakeTimers();
  await renderAt(80);
  await act(async () =>
    (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
  );
  const panel = document.querySelector('[data-testid="task-folders-panel"]') as HTMLElement;
  await act(async () => panel.dispatchEvent(new PointerEvent('pointerover', { bubbles: true })));
  await act(async () => panelController.hold('manual', false));
  // A pointer alone keeps it open after removing the manual reason.
  await act(async () =>
    document
      .querySelector('[data-task-key]')!
      .dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: host }))
  );
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () =>
    (panel.querySelector('[data-testid="task-folders-new-folder"]') as HTMLButtonElement).focus()
  );
  await act(async () =>
    panel.dispatchEvent(new PointerEvent('pointerout', { bubbles: true, relatedTarget: host }))
  );
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () =>
    (panel.querySelector('[data-testid="task-folders-new-folder"]') as HTMLButtonElement).click()
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(2);
  await act(async () =>
    document
      .querySelectorAll('[role="dialog"]')[1]
      .dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(document.querySelectorAll('[role="dialog"]')).toHaveLength(1);
  const row = panel.querySelector('[data-task-key]')!;
  await act(async () =>
    row.dispatchEvent(new MouseEvent('contextmenu', { button: 2, bubbles: true }))
  );
  expect(document.querySelector('[role="menu"]')).not.toBeNull();
  expect(panelController.escape()).toBe(false);
  await act(async () =>
    panel.dispatchEvent(
      new FocusEvent('focusout', {
        bubbles: true,
        relatedTarget: document.querySelector('[role="menu"]'),
      })
    )
  );
  await act(async () => vi.advanceTimersByTime(4000));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => useStore.setState({ globalTasks: [] }));
  expect(document.querySelector('[role="menu"]')).toBeNull();
  // Radix may restore focus on dismissal; explicitly move it off the fallback.
  await act(async () =>
    panel.dispatchEvent(new FocusEvent('focusout', { bubbles: true, relatedTarget: host }))
  );
  await act(async () => vi.advanceTimersByTime(1999));
  expect(panelController.getSnapshot().open).toBe(true);
  await act(async () => vi.advanceTimersByTime(1));
  expect(panelController.getSnapshot().open).toBe(false);
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
    input = await vi.waitFor(() => {
      const next = document.querySelector<HTMLInputElement>(
        'input[aria-label="taskFolders.folderName"]'
      );
      if (!next) throw new Error('Deferred folder dialog input did not mount');
      return next;
    }, { timeout: 1000, interval: 10 });
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

it('releases the automatic panel rename hold on wide/narrow/wide transition with full final grace and Escape', async () => {
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
  expect(panelController.getSnapshot().open).toBe(false);
  await act(async () =>
    (host.querySelector('[data-testid="task-folders-toggle"]') as HTMLButtonElement).click()
  );
  await act(async () =>
    host.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))
  );
  expect(panelController.getSnapshot().open).toBe(false);
});
