import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask, TeamSummary } from '../../../../src/shared/types';

interface StoreState {
  globalTasks: GlobalTask[];
  globalTasksLoading: boolean;
  globalTasksInitialized: boolean;
  fetchAllTasks: ReturnType<typeof vi.fn>;
  fetchProjects: ReturnType<typeof vi.fn>;
  fetchRepositoryGroups: ReturnType<typeof vi.fn>;
  softDeleteTask: ReturnType<typeof vi.fn>;
  projects: { path: string; name: string; sessions: unknown[]; totalSessions?: number }[];
  projectsLoading: boolean;
  projectsInitialized: boolean;
  projectsError: string | null;
  viewMode: 'flat' | 'grouped';
  repositoryGroups: {
    id: string;
    name: string;
    totalSessions: number;
    worktrees: { path: string }[];
  }[];
  repositoryGroupsLoading: boolean;
  repositoryGroupsInitialized: boolean;
  repositoryGroupsError: string | null;
  teams: (Pick<TeamSummary, 'teamName' | 'displayName'> & Partial<TeamSummary>)[];
  provisioningRuns: Record<string, { state: string; runId: string; updatedAt: string }>;
  currentProvisioningRunIdByTeam: Record<string, string | null>;
  leadActivityByTeam: Record<string, 'active' | 'idle' | 'offline'>;
}

const storeState = {} as StoreState;
const toggleCollapsedGroup = vi.fn();
const sidebarTaskItemRenderSpy = vi.hoisted(() => vi.fn());
const taskLocalState = {
  isPinned: vi.fn(() => false),
  isArchived: vi.fn(() => false),
  getRenamedSubject: vi.fn(() => undefined),
  togglePin: vi.fn(),
  toggleArchive: vi.fn(),
  renameTask: vi.fn(),
};

const storeListeners = new Set<() => void>();
function notifyStoreUpdate(): void {
  storeListeners.forEach((l) => l());
}

vi.mock('../../../../src/renderer/store', () => ({
  useStore: (selector: (state: StoreState) => unknown) => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const { useState, useEffect } = require('react') as typeof import('react');
    const [, setVersion] = useState(0);
    useEffect(() => {
      const listener = () => setVersion((v) => v + 1);
      storeListeners.add(listener);
      return () => {
        storeListeners.delete(listener);
      };
    }, []);
    return selector(storeState);
  },
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T>(selector: T) => selector,
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
  SidebarTaskItem: ({
    task,
    hideProjectName,
    teamOffline,
  }: {
    task: GlobalTask;
    hideProjectName?: boolean;
    teamOffline?: boolean;
  }) => {
    sidebarTaskItemRenderSpy(task.id);
    return React.createElement(
      'div',
      {
        'data-testid': 'sidebar-task-item',
        'data-hide-project-name': hideProjectName ? 'true' : 'false',
        'data-team-offline': teamOffline ? 'true' : 'false',
      },
      task.subject
    );
  },
}));

vi.mock('../../../../src/renderer/components/sidebar/TaskFiltersPopover', () => ({
  TaskFiltersPopover: () => null,
}));

vi.mock('../../../../src/renderer/components/ui/popover', () => ({
  Popover: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  PopoverTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  PopoverContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
}));

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
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

function setElectronApiForTest(value: unknown): void {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    writable: true,
    value,
  });
}

function findButton(host: HTMLElement, label: string): HTMLButtonElement | null {
  return (
    Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === label
    ) ?? null
  );
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
    storeState.fetchProjects = vi.fn(() => Promise.resolve(undefined));
    storeState.fetchRepositoryGroups = vi.fn(() => Promise.resolve(undefined));
    storeState.softDeleteTask = vi.fn(() => Promise.resolve(undefined));
    storeState.projects = [];
    storeState.projectsLoading = false;
    storeState.projectsInitialized = false;
    storeState.projectsError = null;
    storeState.viewMode = 'flat';
    storeState.repositoryGroups = [];
    storeState.repositoryGroupsLoading = false;
    storeState.repositoryGroupsInitialized = false;
    storeState.repositoryGroupsError = null;
    storeState.teams = [{ teamName: 'alpha-team', displayName: 'Alpha Team' }];
    storeState.provisioningRuns = {};
    storeState.currentProvisioningRunIdByTeam = {};
    storeState.leadActivityByTeam = {};
    toggleCollapsedGroup.mockReset();
    taskLocalState.isPinned.mockClear();
    taskLocalState.isArchived.mockClear();
    taskLocalState.getRenamedSubject.mockClear();
    taskLocalState.togglePin.mockClear();
    taskLocalState.toggleArchive.mockClear();
    taskLocalState.renameTask.mockClear();
    sidebarTaskItemRenderSpy.mockClear();
    setElectronApiForTest(undefined);
    localStorage.clear();
    localStorage.setItem('sidebarTasksGrouping', 'project');
  });

  afterEach(() => {
    document.body.innerHTML = '';
    setElectronApiForTest(undefined);
    vi.unstubAllGlobals();
    storeListeners.clear();
  });

  it('fetches repository groups when grouped project filter data is needed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.viewMode = 'grouped';

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(storeState.fetchRepositoryGroups).not.toHaveBeenCalled();
    expect(storeState.fetchProjects).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        React.createElement(GlobalTaskList, {
          filtersPopoverOpen: true,
          onFiltersPopoverOpenChange: vi.fn(),
        })
      );
      await flushMicrotasks();
    });

    expect(storeState.fetchRepositoryGroups).toHaveBeenCalledTimes(1);
    expect(storeState.fetchProjects).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('fetches flat projects when flat project filter data is needed', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(storeState.fetchProjects).not.toHaveBeenCalled();
    expect(storeState.fetchRepositoryGroups).not.toHaveBeenCalled();

    await act(async () => {
      root.render(
        React.createElement(GlobalTaskList, {
          filtersPopoverOpen: true,
          onFiltersPopoverOpenChange: vi.fn(),
        })
      );
      await flushMicrotasks();
    });

    expect(storeState.fetchProjects).toHaveBeenCalledTimes(1);
    expect(storeState.fetchRepositoryGroups).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('does not duplicate project filter data fetches while a repository fetch is already pending', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.viewMode = 'grouped';
    storeState.repositoryGroupsLoading = true;

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GlobalTaskList, {
          filtersPopoverOpen: true,
          onFiltersPopoverOpenChange: vi.fn(),
        })
      );
      await flushMicrotasks();
    });

    expect(storeState.fetchRepositoryGroups).not.toHaveBeenCalled();
    expect(storeState.fetchProjects).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('does not refetch repository groups after an empty grouped result is initialized', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.viewMode = 'grouped';

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GlobalTaskList, {
          filtersPopoverOpen: true,
          onFiltersPopoverOpenChange: vi.fn(),
        })
      );
      await flushMicrotasks();
    });

    expect(storeState.fetchRepositoryGroups).toHaveBeenCalledTimes(1);

    storeState.repositoryGroupsLoading = true;
    await act(async () => {
      notifyStoreUpdate();
      await flushMicrotasks();
    });

    storeState.repositoryGroupsLoading = false;
    storeState.repositoryGroupsInitialized = true;
    storeState.repositoryGroups = [];
    await act(async () => {
      notifyStoreUpdate();
      await flushMicrotasks();
    });

    expect(storeState.fetchRepositoryGroups).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
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

    expect(visibleSubjects(host)).toEqual([
      'Task 1',
      'Task 2',
      'Task 3',
      'Task 4',
      'Task 5',
      'Task 6',
    ]);
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

  it('hides project labels in task cards when grouped by project', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.globalTasks = [makeTask(1), makeTask(2)];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(
      Array.from(host.querySelectorAll('[data-testid="sidebar-task-item"]')).map((node) =>
        node.getAttribute('data-hide-project-name')
      )
    ).toEqual(['true', 'true']);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('marks task cards as offline when the owning team has gone offline', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.globalTasks = [makeTask(1)];
    storeState.leadActivityByTeam = { 'alpha-team': 'offline' };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(
      host.querySelector('[data-testid="sidebar-task-item"]')?.getAttribute('data-team-offline')
    ).toBe('true');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('marks task cards as offline when the owning team has a partial launch failure', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const aliveList = vi.fn(() => Promise.resolve([]));
    setElectronApiForTest({ teams: { aliveList } });
    storeState.globalTasks = [makeTask(1)];
    storeState.teams = [
      {
        teamName: 'alpha-team',
        displayName: 'Alpha Team',
        partialLaunchFailure: true,
        teamLaunchState: 'partial_failure',
      },
    ];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(aliveList).toHaveBeenCalled();
    expect(
      host.querySelector('[data-testid="sidebar-task-item"]')?.getAttribute('data-team-offline')
    ).toBe('true');

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });

  it('marks task cards as offline when alive-list is initialized before teams are loaded', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const aliveList = vi.fn(() => Promise.resolve([]));
    setElectronApiForTest({ teams: { aliveList } });
    storeState.globalTasks = [makeTask(1)];
    storeState.teams = [];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
      await flushMicrotasks();
    });

    expect(aliveList).toHaveBeenCalled();
    expect(
      host.querySelector('[data-testid="sidebar-task-item"]')?.getAttribute('data-team-offline')
    ).toBe('true');

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
      notifyStoreUpdate();
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

  it('does not rerender unchanged task rows when refreshed task objects keep the same visible fields', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    storeState.globalTasks = [makeTask(1), makeTask(2)];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(React.createElement(GlobalTaskList));
      await flushMicrotasks();
    });

    expect(sidebarTaskItemRenderSpy).toHaveBeenCalledTimes(2);
    sidebarTaskItemRenderSpy.mockClear();

    storeState.globalTasks = [makeTask(1), makeTask(2, { subject: 'Task 2 updated' })];
    await act(async () => {
      notifyStoreUpdate();
      await flushMicrotasks();
    });

    expect(visibleSubjects(host)).toEqual(['Task 1', 'Task 2 updated']);
    expect(sidebarTaskItemRenderSpy.mock.calls.map(([taskId]) => taskId)).toEqual(['task-2']);

    sidebarTaskItemRenderSpy.mockClear();
    storeState.globalTasks = [
      makeTask(1, {
        comments: [
          {
            id: 'comment-1',
            author: 'alice',
            text: 'note',
            createdAt: '2026-04-18T11:00:00.000Z',
            type: 'regular',
          },
        ],
      }),
      makeTask(2, { subject: 'Task 2 updated' }),
    ];
    await act(async () => {
      notifyStoreUpdate();
      await flushMicrotasks();
    });

    expect(sidebarTaskItemRenderSpy.mock.calls.map(([taskId]) => taskId)).toEqual(['task-1']);

    await act(async () => {
      root.unmount();
      await flushMicrotasks();
    });
  });
});
