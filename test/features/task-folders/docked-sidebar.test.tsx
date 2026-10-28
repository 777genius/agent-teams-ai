import React, { act, createRef } from 'react';
import { createRoot } from 'react-dom/client';

import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { useStore } from '@renderer/store';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

import { dockedSidebar } from '../../../src/features/task-folders/renderer/adapters/dockedSidebar';
import {
  folderController,
  panelController,
} from '../../../src/features/task-folders/renderer/composition';
import { TaskFoldersHost } from '../../../src/features/task-folders/renderer/TaskFoldersHost';

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
let body: HTMLDivElement;
beforeEach(async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  dockedSidebar.set(false);
  await folderController.reset();
  useStore.setState({ globalTasks: [makeGlobalTask()] });
  host = document.createElement('div');
  sidebar = document.createElement('div');
  body = document.createElement('div');
  body.id = 'sidebar-tasks-panel';
  document.body.append(host, sidebar, body);
  root = createRoot(host);
});
afterEach(async () => {
  await act(async () => root.unmount());
  panelController.dispose();
  dockedSidebar.set(false);
  useStore.setState({ globalTasks: [] });
  host.remove();
  sidebar.remove();
  body.remove();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function renderHost() {
  const ref = createRef<HTMLDivElement>();
  ref.current = sidebar;
  await act(async () =>
    root.render(
      <TooltipProvider>
        <TaskFoldersHost contextId="local" sidebar={ref} collapsed={false} />
      </TooltipProvider>
    )
  );
}
const dockToggle = (): HTMLButtonElement | null =>
  document.querySelector('[data-testid="task-folders-dock-toggle"]');
async function openPanelAndDock(): Promise<void> {
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="task-folders-toggle"]')!;
  await act(() => Promise.resolve(toggle.click()));
  await act(() => Promise.resolve(dockToggle()!.click()));
}
it('replaces the sidebar body with the docked tree while docked', async () => {
  await renderHost();
  const toggle = host.querySelector<HTMLButtonElement>('[data-testid="task-folders-toggle"]')!;
  await act(() => Promise.resolve(toggle.click()));
  expect(dockToggle()!.getAttribute('aria-pressed')).toBe('false');
  await act(() => Promise.resolve(dockToggle()!.click()));
  expect(dockToggle()!.getAttribute('aria-pressed')).toBe('true');
  expect(body.querySelector('[data-testid="task-folders-docked"]')).not.toBeNull();
  expect(host.querySelector('[data-testid="task-folders-toggle"]')).toBeNull();
  expect(document.querySelector('[data-testid="task-folders-panel"]')).toBeNull();
  expect(document.querySelector('[role="dialog"]')).toBeNull();
  expect(panelController.getSnapshot().manual).toBe(false);
  await act(() => Promise.resolve(dockToggle()!.click()));
  expect(body.querySelector('[data-testid="task-folders-docked"]')).toBeNull();
  expect(host.querySelector('[data-testid="task-folders-toggle"]')).not.toBeNull();
});
it('stores the docked preference and allows drag sessions while docked', async () => {
  await renderHost();
  await openPanelAndDock();
  expect(localStorage.getItem('taskFolders:dockedSidebar:v1')).toBe('1');
  panelController.begin('task:["t","1"]');
  expect(panelController.getSnapshot().dragSource).toBe('task:["t","1"]');
  panelController.end();
  await act(() => Promise.resolve(dockToggle()!.click()));
  expect(localStorage.getItem('taskFolders:dockedSidebar:v1')).toBeNull();
  expect(panelController.begin('task:["t","1"]')).toBe(panelController.getSnapshot().session);
  expect(panelController.getSnapshot().dragSource).toBeNull();
});
