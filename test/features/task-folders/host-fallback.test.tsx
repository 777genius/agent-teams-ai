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
