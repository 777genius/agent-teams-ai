import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask } from '../../../../src/shared/types';

const storeState = {
  openGlobalTaskDetail: vi.fn(),
  teamByName: {} as Record<string, { members: unknown[] }>,
};
const moduleMocks = vi.hoisted(() => ({
  clearTaskManualUnread: vi.fn(),
  openTaskFolderMove: vi.fn(),
  preloadGlobalTaskDetailDialog: vi.fn(),
  taskFolderEditingReady: true,
  useUnreadCommentCount: vi.fn(
    (
      _identity: { contextId: string; teamName: string; taskId: string },
      _comments?: readonly unknown[]
    ) => 0
  ),
}));

let unreadCountValue = 0;
let isLightValue = false;

vi.mock('../../../../src/renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../../../../src/renderer/hooks/useUnreadCommentCount', () => ({
  useUnreadCommentCount: moduleMocks.useUnreadCommentCount,
}));

vi.mock('../../../../src/renderer/services/commentReadStorage', () => ({
  clearTaskManualUnread: moduleMocks.clearTaskManualUnread,
}));

vi.mock('../../../../src/renderer/components/layout/GlobalTaskDetailDialogSlot', () => ({
  preloadGlobalTaskDetailDialog: moduleMocks.preloadGlobalTaskDetailDialog,
}));

vi.mock('../../../../src/features/task-folders/renderer/adapters/taskFolderEditing', () => ({
  useTaskFolderEditingReady: () => moduleMocks.taskFolderEditingReady,
  taskFolderMoveRequest: { open: moduleMocks.openTaskFolderMove },
}));

vi.mock('../../../../src/renderer/hooks/useTheme', () => ({
  useTheme: () => ({
    theme: isLightValue ? 'light' : 'dark',
    resolvedTheme: isLightValue ? 'light' : 'dark',
    isDark: !isLightValue,
    isLight: isLightValue,
  }),
}));

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: (namespace: string) => {
    const catalogs: Record<string, Record<string, string>> = {
      common: {
        'tasks.date.updatedPrefix': 'upd',
        'tasks.date.updatedYesterday': 'upd yesterday',
        'tasks.date.yesterday': 'Yesterday',
        'tasks.reviewState.needsFix': 'Needs Fixes',
      },
      team: {
        'tasks.teamPrefix': 'Team:',
        'tasks.unassigned': 'Unassigned',
      },
    };

    return {
      resolvedLanguage: 'en',
      t: (key: string) => catalogs[namespace]?.[key] ?? key,
    };
  },
}));

vi.mock('../../../../src/renderer/constants/teamColors', () => ({
  getTeamColorSet: () => ({ text: '#fff', textLight: '#000' }),
}));

vi.mock('../../../../src/renderer/utils/memberHelpers', () => ({
  buildMemberColorMap: () => new Map<string, string>(),
  REVIEW_STATE_DISPLAY: {
    needsFix: { bg: 'bg-red-500/10', text: 'text-red-300', label: 'Needs fix' },
  },
}));

vi.mock('../../../../src/renderer/utils/projectColor', () => ({
  nameColorSet: () => ({ text: '#fff' }),
  projectColor: () => ({ text: '#fff' }),
}));

vi.mock('../../../../src/renderer/utils/taskGrouping', () => ({
  projectLabelFromPath: () => 'hookplex',
}));

vi.mock('../../../../src/shared/utils/reviewState', () => ({
  getTaskKanbanColumn: () => 'todo',
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: <T>(selector: T) => selector,
}));

vi.mock('lucide-react', () => {
  const Icon = (props: React.SVGProps<SVGSVGElement>) => React.createElement('svg', props);
  return {
    Archive: Icon,
    GripVertical: Icon,
    CheckCircle2: Icon,
    Circle: Icon,
    Eye: Icon,
    Loader2: Icon,
    ShieldCheck: Icon,
    Trash2: Icon,
  };
});

import { SidebarTaskItem as ActualSidebarTaskItem } from '../../../../src/renderer/components/sidebar/SidebarTaskItem';
import { TooltipProvider } from '../../../../src/renderer/components/ui/tooltip';

function SidebarTaskItem(
  props: React.ComponentProps<typeof ActualSidebarTaskItem>
): React.JSX.Element {
  return React.createElement(TooltipProvider, {
    children: React.createElement(ActualSidebarTaskItem, props),
    delayDuration: 0,
  });
}

function makeTask(overrides: Partial<GlobalTask> = {}): GlobalTask {
  return {
    id: 'task-1',
    displayId: 'task1',
    teamName: 'alpha-team',
    teamDisplayName: 'Alpha Team',
    subject: 'Review docs',
    description: '',
    status: 'in_progress',
    owner: 'alice',
    createdAt: '2026-04-18T10:00:00.000Z',
    updatedAt: '2026-04-18T10:10:00.000Z',
    reviewState: 'none',
    blockedBy: [],
    blocks: [],
    comments: [],
    attachments: [],
    workIntervals: [],
    projectPath: '/workspace/hookplex',
    ...overrides,
  };
}

describe('SidebarTaskItem unread styling', () => {
  beforeEach(() => {
    unreadCountValue = 0;
    isLightValue = false;
    storeState.openGlobalTaskDetail.mockReset();
    storeState.teamByName = {};
    moduleMocks.clearTaskManualUnread.mockReset();
    moduleMocks.useUnreadCommentCount.mockReset();
    moduleMocks.useUnreadCommentCount.mockImplementation(() => unreadCountValue);
    moduleMocks.openTaskFolderMove.mockReset();
    moduleMocks.preloadGlobalTaskDetailDialog.mockReset();
    moduleMocks.taskFolderEditingReady = true;
  });

  afterEach(() => {
    vi.useRealTimers();
    document.body.innerHTML = '';
  });

  it('uses the softened unread background tint in dark theme', async () => {
    unreadCountValue = 2;
    isLightValue = false;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector('[data-task-key]');
    expect(row?.className).toContain('bg-blue-500/[0.025]');
    expect(row?.className).not.toContain('bg-blue-500/[0.05]');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders sibling native detail and move buttons and separates their actions', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>('[data-task-key]')!;
    const detail = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-task-detail"]')!;
    const move = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-task-drag-handle"]')!;

    expect(row.tagName).toBe('DIV');
    expect(row.getAttribute('role')).toBeNull();
    expect(row.getAttribute('tabindex')).toBeNull();
    expect(detail.tagName).toBe('BUTTON');
    expect(detail.type).toBe('button');
    expect(move.tagName).toBe('BUTTON');
    expect(move.type).toBe('button');
    expect(move.disabled).toBe(false);
    expect(move.getAttribute('draggable')).toBe('true');
    expect(detail.contains(move)).toBe(false);
    expect(move.closest('button')).toBe(move);

    await act(async () => detail.focus());
    expect(moduleMocks.preloadGlobalTaskDetailDialog).toHaveBeenCalled();

    await act(async () =>
      move.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    );
    expect(moduleMocks.openTaskFolderMove).not.toHaveBeenCalled();
    await act(async () => move.click());
    expect(moduleMocks.openTaskFolderMove).toHaveBeenCalledExactlyOnceWith({
      teamName: 'alpha-team',
      taskId: 'task-1',
    });
    expect(storeState.openGlobalTaskDetail).not.toHaveBeenCalled();
    expect(moduleMocks.clearTaskManualUnread).not.toHaveBeenCalled();

    await act(async () =>
      detail.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true })
      )
    );
    expect(storeState.openGlobalTaskDetail).not.toHaveBeenCalled();
    await act(async () => detail.click());
    expect(storeState.openGlobalTaskDetail).toHaveBeenCalledExactlyOnceWith('alpha-team', 'task-1');
    expect(moduleMocks.clearTaskManualUnread).toHaveBeenCalledExactlyOnceWith({
      contextId: 'local',
      teamName: 'alpha-team',
      taskId: 'task-1',
    });
    expect(moduleMocks.openTaskFolderMove).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the move control disabled until task-folder editing is ready', async () => {
    moduleMocks.taskFolderEditingReady = false;
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
        })
      );
      await Promise.resolve();
    });

    const move = host.querySelector<HTMLButtonElement>('[data-testid="sidebar-task-drag-handle"]')!;
    expect(move.disabled).toBe(true);
    expect(move.getAttribute('draggable')).toBe('false');
    await act(async () => move.click());
    expect(moduleMocks.openTaskFolderMove).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('keeps the rename editor outside buttons and preserves IME, Escape and blur callbacks', async () => {
    const onRenameComplete = vi.fn();
    const onRenameCancel = vi.fn();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
          renamingKey: 'alpha-team:task-1',
          onRenameComplete,
          onRenameCancel,
        })
      );
      await Promise.resolve();
    });

    const row = host.querySelector<HTMLElement>('[data-task-key]')!;
    const input = row.querySelector<HTMLInputElement>('input')!;
    expect(input.closest('button')).toBeNull();
    expect(row.querySelector('button')).toBeNull();
    await act(async () => input.focus());

    await act(async () => {
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
      setter.call(input, 'Renamed task');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', {
          key: 'Enter',
          bubbles: true,
          cancelable: true,
          isComposing: true,
        })
      )
    );
    expect(onRenameComplete).not.toHaveBeenCalled();
    expect(onRenameCancel).not.toHaveBeenCalled();

    await act(async () =>
      input.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true })
      )
    );
    expect(onRenameCancel).toHaveBeenCalledExactlyOnceWith();

    await act(async () => input.blur());
    expect(onRenameComplete).toHaveBeenCalledExactlyOnceWith(
      'alpha-team',
      'task-1',
      'Renamed task'
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('animates the in-progress status icon', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('svg')?.getAttribute('class')).toContain('animate-spin');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('pauses the in-progress status icon when the task team is offline', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
          teamOffline: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('svg')?.getAttribute('class')).not.toContain('animate-spin');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('can hide the project label when the parent already groups by project', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask(),
          hideProjectName: true,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('hookplex');
    expect(host.textContent).toContain('alice');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders localized relative and review labels instead of i18n keys', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const updatedAt = new Date();
    const createdAt = new Date(updatedAt.getTime() - 5 * 60_000);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask({
            createdAt: createdAt.toISOString(),
            reviewState: 'needsFix',
            updatedAt: updatedAt.toISOString(),
          }),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('now');
    expect(host.textContent).toContain('Needs Fixes');
    expect(host.textContent).not.toContain('tasks.date.updatedPrefix');
    expect(host.textContent).not.toContain('tasks.reviewState.needsFix');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('shows compact localized relative minutes, hours, and days', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: makeTask({
              id: 'minutes',
              createdAt: '2026-04-17T00:00:00.000Z',
              updatedAt: '2026-04-18T11:55:00.000Z',
            }),
          }),
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: makeTask({
              id: 'hours',
              createdAt: '2026-04-17T00:00:00.000Z',
              updatedAt: '2026-04-18T09:00:00.000Z',
            }),
          }),
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: makeTask({
              id: 'days',
              createdAt: '2026-04-01T00:00:00.000Z',
              updatedAt: '2026-04-14T12:00:00.000Z',
            }),
          })
        )
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('5 min');
    expect(host.textContent).not.toContain('ago');
    expect(host.textContent).toContain('3 hr');
    expect(host.textContent).toContain('4 days');
    expect(host.textContent).not.toContain('upd');
    const relativeLabels = host.querySelectorAll<HTMLElement>(
      '[data-testid="sidebar-task-relative-time"]'
    );
    expect(relativeLabels).toHaveLength(3);
    for (const label of relativeLabels) {
      expect(label.className).toContain('max-w-[55%]');
      expect(label.className).toContain('truncate');
    }
    expect(vi.getTimerCount()).toBe(1);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    expect(vi.getTimerCount()).toBe(0);
  });

  it('shows the exact localized update date and time in the tooltip', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T13:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const updatedAt = new Date(2026, 3, 18, 12, 34, 56);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask({
            createdAt: new Date(2026, 3, 17, 12, 0, 0).toISOString(),
            updatedAt: updatedAt.toISOString(),
          }),
        })
      );
      await Promise.resolve();
    });

    const exactDateTime = new Intl.DateTimeFormat('en', {
      dateStyle: 'medium',
      timeStyle: 'medium',
    }).format(updatedAt);
    const trigger = host.querySelector<HTMLElement>('[data-testid="sidebar-task-relative-time"]');

    expect(trigger).not.toBeNull();
    expect(document.querySelector('[role="tooltip"]')).toBeNull();

    await act(async () => {
      const PointerEventConstructor = window.PointerEvent ?? MouseEvent;
      trigger?.dispatchEvent(
        new PointerEventConstructor('pointermove', { bubbles: true, cancelable: true })
      );
      await vi.advanceTimersByTimeAsync(0);
    });

    expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(exactDateTime);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it.each([undefined, 'invalid', '2026-04-18T11:29:30.000Z'])(
    'shows relative creation time and its exact tooltip without a meaningful update (%s)',
    async (updatedAt) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);
      const createdAt = new Date('2026-04-18T11:29:00.000Z');

      try {
        act(() => {
          root.render(
            React.createElement(SidebarTaskItem, {
              contextId: 'local',
              task: makeTask({ createdAt: createdAt.toISOString(), updatedAt }),
            })
          );
        });

        const trigger = host.querySelector<HTMLElement>(
          '[data-testid="sidebar-task-relative-time"]'
        );
        expect(trigger?.textContent).toBe('31 min');

        await act(async () => {
          const PointerEventConstructor = window.PointerEvent ?? MouseEvent;
          trigger?.dispatchEvent(
            new PointerEventConstructor('pointermove', { bubbles: true, cancelable: true })
          );
          await vi.advanceTimersByTimeAsync(0);
        });

        const exactDateTime = new Intl.DateTimeFormat('en', {
          dateStyle: 'medium',
          timeStyle: 'medium',
        }).format(createdAt);
        expect(document.querySelector('[role="tooltip"]')?.textContent).toContain(exactDateTime);
      } finally {
        act(() => root.unmount());
      }
    }
  );

  it.each([undefined, 'invalid'])('omits time when both timestamps are unusable (%s)', (date) => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    act(() => {
      root.render(
        React.createElement(SidebarTaskItem, {
          contextId: 'local',
          task: makeTask({ createdAt: date, updatedAt: date }),
        })
      );
    });

    expect(host.querySelector('[data-testid="sidebar-task-relative-time"]')).toBeNull();
    expect(host.textContent).not.toContain('Invalid');
    expect(vi.getTimerCount()).toBe(0);

    act(() => root.unmount());
  });

  it.each(['update', 'creation'])(
    'refreshes the relative %s label from the shared clock',
    async (source) => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
      vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = createRoot(host);

      await act(async () => {
        root.render(
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: makeTask({
              createdAt:
                source === 'creation' ? '2026-04-18T11:59:30.000Z' : '2026-04-18T11:00:00.000Z',
              updatedAt: source === 'creation' ? undefined : '2026-04-18T11:59:30.000Z',
            }),
          })
        );
        await Promise.resolve();
      });

      expect(host.textContent).toContain('now');

      await act(async () => {
        vi.advanceTimersByTime(30_000);
        await Promise.resolve();
      });

      expect(host.textContent).toContain('1 min');
      expect(host.textContent).not.toContain('ago');

      await act(async () => {
        root.unmount();
        await Promise.resolve();
      });
    }
  );

  it('keeps injected tree presentation field-for-field synchronized with sidebar cards', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const renderCards = (source: GlobalTask, archived = false): void => {
      root.render(
        React.createElement(
          React.Fragment,
          null,
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: source,
            isArchived: archived,
            showTeamName: true,
            displaySubjectOverride: source.subject,
          }),
          React.createElement(SidebarTaskItem, {
            contextId: 'local',
            task: source,
            isArchived: archived,
            showTeamName: true,
            displaySubjectOverride: source.subject,
            containerProps: {
              role: 'treeitem',
              className: 'tree-card-under-test',
            },
            renderDragHandle: () =>
              React.createElement('button', {
                type: 'button',
                'data-testid': 'injected-tree-handle',
              }),
            menuSlot: React.createElement('button', {
              type: 'button',
              'data-testid': 'injected-tree-menu',
            }),
          })
        )
      );
    };
    const fields = (): Record<string, string> =>
      Object.fromEntries(
        [...host.querySelectorAll('[data-task-card-field]')]
          .filter((field) => !field.closest('.tree-card-under-test'))
          .map((field) => [
            `${field.getAttribute('data-task-card-field')}:${field.textContent}`,
            `${field.getAttribute('class')}:${field.getAttribute('data-task-card-field')}`,
          ])
      );
    const treeFields = (): Record<string, string> =>
      Object.fromEntries(
        [...host.querySelectorAll('.tree-card-under-test [data-task-card-field]')].map((field) => [
          `${field.getAttribute('data-task-card-field')}:${field.textContent}`,
          `${field.getAttribute('class')}:${field.getAttribute('data-task-card-field')}`,
        ])
      );
    await act(async () => {
      renderCards(makeTask({ status: 'pending', owner: 'alice', subject: 'Before' }));
      await Promise.resolve();
    });
    expect(moduleMocks.useUnreadCommentCount).toHaveBeenCalledWith(
      { contextId: 'local', teamName: 'alpha-team', taskId: 'task-1' },
      expect.any(Array)
    );
    expect(treeFields()).toEqual(fields());
    expect(host.querySelector('[data-testid="injected-tree-handle"]')).not.toBeNull();
    expect(host.querySelector('[data-testid="injected-tree-menu"]')).not.toBeNull();

    unreadCountValue = 3;
    await act(async () => {
      renderCards(
        makeTask({
          status: 'completed',
          owner: 'bob',
          subject: 'After live update',
          updatedAt: '2026-04-18T10:30:00.000Z',
        }),
        true
      );
      await Promise.resolve();
    });
    expect(treeFields()).toEqual(fields());
    expect(fields()['subject:After live update']).toBeDefined();
    expect(fields()['owner:bob']).toBeDefined();
    expect(fields()['unread:3']).toBeDefined();
    expect(
      host.querySelector('.tree-card-under-test')!.className.includes('opacity-60')
    ).toBe(true);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
