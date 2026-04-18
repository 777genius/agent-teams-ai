import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask } from '../../../../src/shared/types';

interface StoreState {
  globalTasks: GlobalTask[];
  globalTasksLoading: boolean;
  globalTasksInitialized: boolean;
  fetchAllTasks: ReturnType<typeof vi.fn>;
  softDeleteTask: ReturnType<typeof vi.fn>;
  projects: { path: string; name: string; sessions: unknown[]; totalSessions?: number }[];
  viewMode: 'flat' | 'grouped';
  repositoryGroups: {
    id: string;
    name: string;
    totalSessions: number;
    worktrees: { path: string }[];
  }[];
  teams: { teamName: string; displayName: string }[];
}

const storeState = {} as StoreState;
const toggleCollapsedGroup = vi.fn();
const taskLocalState = {
  isPinned: vi.fn(() => false),
  isArchived: vi.fn(() => false),
  getRenamedSubject: vi.fn(() => undefined),
  togglePin: vi.fn(),
  toggleArchive: vi.fn(),
  renameTask: vi.fn(),
};

vi.mock('../../../../src/renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => selector(storeState),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T,>(selector: T) => selector,
}));

vi.mock('../../../../src/renderer/components/common/ConfirmDialog', () => ({
  confirm: vi.fn(() => Promise.resolve(true)),
}));

vi.mock('../../../../src/renderer/hooks/useCollapsedGroups', () => ({
  useCollapsedGroups: () => ({
    isCollapsed: () => false,
    toggle: toggleCollapsedGroup,
  }),
}));

vi.mock('../../../../src/renderer/hooks/useTaskLocalState', () => ({
  useTaskLocalState: () => taskLocalState,
}));

vi.mock('../../../../src/renderer/components/team/activity/AnimatedHeightReveal', () => ({
  AnimatedHeightReveal: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('../../../../src/renderer/components/sidebar/TaskContextMenu', () => ({
  TaskContextMenu: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('../../../../src/renderer/components/sidebar/SidebarTaskItem', () => ({
  SidebarTaskItem: ({ task }: { task: GlobalTask }) =>
    React.createElement('div', { 'data-testid': 'sidebar-task-item' }, task.subject),
}));

vi.mock('../../../../src/renderer/components/sidebar/TaskFiltersPopover', () => ({
  TaskFiltersPopover: () => null,
}));

vi.mock('../../../../src/renderer/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  PopoverTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  PopoverContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Archive: Icon,
    ArrowUpDown: Icon,
    Check: Icon,
    ChevronDown: Icon,
    ChevronRight: Icon,
    Folder: Icon,
    ListTodo: Icon,
    Pin: Icon,
    Search: Icon,
    X: Icon,
  };
});

import { GlobalTaskList } from '../../../../src/renderer/components/sidebar/GlobalTaskList';

function flushMicrotasks(): Promise<void> {
  return Promise.resolve();
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  return Array.from(host.querySelectorAll('button')).find(
    (button) => button.textContent?.trim() === label
  ) ?? null;
}

function visibleSubjects(host: HTMLElement): string[] {
  return Array.from(host.querySelectorAll('[data-testid="sidebar-task-item"]')).map(
    (node) => node.textContent ?? ''
  );
}

function makeTask(index: number, overrides: Partial<GlobalTask> = {}): GlobalTask {
  const timestamp = String(60 - index).padStart(2, '0');
  return {
    id: `task-${index}`,
    displayId: `task${index}`,
    teamName: 'alpha-team',
    teamDisplayName: 'Alpha Team',
    subject: `Task ${index}`,
    description: '',
    status: 'in_progress',
    owner: 'alice',
    createdAt: `2026-04-18T10:${timestamp}:00.000Z`,
    updatedAt: `2026-04-18T10:${timestamp}:00.000Z`,
    reviewState: 'none',
    reviewNotes: [],
    blockedBy: [],
    blocks: [],
    comments: [],
    attachments: [],
    workIntervals: [],
    kanbanColumnId: null,
    projectPath: '/workspace/hookplex',
    ...overrides,
  } as GlobalTask;
}

describe('GlobalTaskList project grouping', () => {
  beforeEach(() => {
    storeState.globalTasks = [];
    storeState.globalTasksLoading = false;
    storeState.globalTasksInitialized = true;
    storeState.fetchAllTasks = vi.fn(() => Promise.resolve(undefined));
    storeState.softDeleteTask = vi.fn(() => Promise.resolve(undefined));
    storeState.projects = [];
    storeState.viewMode = 'flat';
    storeState.repositoryGroups = [];
    storeState.teams = [{ teamName: 'alpha-team', displayName: 'Alpha Team' }];
    toggleCollapsedGroup.mockReset();
    taskLocalState.isPinned.mockClear();
    taskLocalState.isArchived.mockClear();
    taskLocalState.getRenamedSubject.mockClear();
    taskLocalState.togglePin.mockClear();
    taskLocalState.toggleArchive.mockClear();
    taskLocalState.renameTask.mockClear();
    localStorage.clear();
    localStorage.setItem('sidebarTasksGrouping', 'project');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('shows five tasks first, then expands and collapses with Show more and Show less', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.globalTasks = Array.from({ length: 6 }, (_, index) => makeTask(index + 1));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);
    expect(findButton(host, 'Show more')).not.toBeNull();
    expect(findButton(host, 'Show less')).toBeNull();

    await act(async () => {
      findButton(host, 'Show more')?.click();
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5', 'Task 6']);
    expect(findButton(host, 'Show less')).not.toBeNull();

    await act(async () => {
      findButton(host, 'Show less')?.click();
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toEqual(['Task 1', 'Task 2', 'Task 3', 'Task 4', 'Task 5']);
    expect(findButton(host, 'Show less')).toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('keeps the hard visible limit when new tasks arrive after expansion', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.globalTasks = Array.from({ length: 10 }, (_, index) => makeTask(index + 1));

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    await act(async () => {
      findButton(host, 'Show more')?.click();
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toHaveLength(10);
    expect(findButton(host, 'Show less')).not.toBeNull();

    storeState.globalTasks = [
      makeTask(0, {
        id: 'task-new',
        displayId: 'task-new',
        subject: 'Task 0',
        createdAt: '2026-04-18T11:00:00.000Z',
        updatedAt: '2026-04-18T11:00:00.000Z',
      }),
      ...Array.from({ length: 10 }, (_, index) => makeTask(index + 1)),
    ];

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toHaveLength(10);
    expect(visibleSubjects(host)).toEqual([
      'Task 0',
      'Task 1',
      'Task 2',
      'Task 3',
      'Task 4',
      'Task 5',
      'Task 6',
      'Task 7',
      'Task 8',
      'Task 9',
    ]);
    expect(visibleSubjects(host)).not.toContain('Task 10');
    expect(findButton(host, 'Show more')).not.toBeNull();
    expect(findButton(host, 'Show less')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
