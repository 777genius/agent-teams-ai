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

vi.mock('../../../../src/renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: React.PropsWithChildren) => React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: React.PropsWithChildren) =>
    React.createElement(React.Fragment, null, children),
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
  useShallow: <T,>(selector: T) => selector,
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

import { SidebarTaskItem } from '../../../../src/renderer/components/sidebar/SidebarTaskItem';

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
});
