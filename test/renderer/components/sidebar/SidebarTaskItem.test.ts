import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { GlobalTask } from '../../../../src/shared/types';

const storeState = {
  openGlobalTaskDetail: vi.fn(),
  teamByName: {} as Record<string, { members: unknown[] }>,
};

let unreadCountValue = 0;
let isLightValue = false;

vi.mock('../../../../src/renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('../../../../src/renderer/hooks/useUnreadCommentCount', () => ({
  useUnreadCommentCount: () => unreadCountValue,
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

describe('SidebarTaskItem unread styling', () => {
  beforeEach(() => {
    unreadCountValue = 0;
    isLightValue = false;
    storeState.openGlobalTaskDetail.mockReset();
    storeState.teamByName = {};
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
      root.render(React.createElement(SidebarTaskItem, { task: makeTask() }));
      await Promise.resolve();
    });

    const button = host.querySelector('button');
    expect(button?.className).toContain('bg-blue-500/[0.05]');
    expect(button?.className).not.toContain('bg-blue-500/[0.08]');

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
      root.render(React.createElement(SidebarTaskItem, { task: makeTask() }));
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
      root.render(React.createElement(SidebarTaskItem, { task: makeTask(), teamOffline: true }));
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
        React.createElement(SidebarTaskItem, { task: makeTask(), hideProjectName: true })
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
            task: makeTask({
              id: 'minutes',
              createdAt: '2026-04-17T00:00:00.000Z',
              updatedAt: '2026-04-18T11:55:00.000Z',
            }),
          }),
          React.createElement(SidebarTaskItem, {
            task: makeTask({
              id: 'hours',
              createdAt: '2026-04-17T00:00:00.000Z',
              updatedAt: '2026-04-18T09:00:00.000Z',
            }),
          }),
          React.createElement(SidebarTaskItem, {
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

    expect(host.textContent).toContain('5 min. ago');
    expect(host.textContent).toContain('3 hr. ago');
    expect(host.textContent).toContain('4 days ago');
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

  it('refreshes the relative label from the shared clock', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-04-18T12:00:00.000Z'));
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(SidebarTaskItem, {
          task: makeTask({
            createdAt: '2026-04-18T11:00:00.000Z',
            updatedAt: '2026-04-18T11:59:30.000Z',
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

    expect(host.textContent).toContain('1 min. ago');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
