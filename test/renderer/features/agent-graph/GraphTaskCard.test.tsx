import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { TeamTaskWithKanban } from '@shared/types/team';

const graphActivityMock = vi.hoisted(() => ({
  teamData: null as {
    tasks: TeamTaskWithKanban[];
    members: { name: string; color?: string }[];
  } | null,
}));

vi.mock('@features/agent-graph/renderer/hooks/useGraphActivityContext', () => ({
  useGraphActivityContext: () => ({
    teamData: graphActivityMock.teamData,
  }),
}));

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/UnreadCommentsBadge', () => ({
  UnreadCommentsBadge: () => React.createElement('span', { 'data-testid': 'comments-badge' }),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    className,
    onClick,
    disabled,
    'aria-label': ariaLabel,
  }: {
    children: React.ReactNode;
    className?: string;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
    disabled?: boolean;
    'aria-label'?: string;
  }) =>
    React.createElement(
      'button',
      { className, onClick, disabled, 'aria-label': ariaLabel, type: 'button' },
      children
    ),
}));

vi.mock('@renderer/components/ui/popover', () => ({
  Popover: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  PopoverTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  PopoverContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/hooks/useUnreadCommentCount', () => ({
  useUnreadCommentCount: () => 0,
}));

import { GraphTaskCard } from '@features/agent-graph/renderer/ui/GraphTaskCard';

import type { GraphNode } from '@claude-teams/agent-graph';

const changedTask = {
  id: 'task-1',
  displayId: '#1',
  subject: 'Review graph diff route',
  owner: 'alice',
  reviewer: '',
  status: 'completed',
  changePresence: 'has_changes',
  comments: [],
  blockedBy: [],
  blocks: [],
  workIntervals: [],
  historyEvents: [],
  createdAt: '2026-05-17T10:00:00.000Z',
  updatedAt: '2026-05-17T10:10:00.000Z',
} as TeamTaskWithKanban;

const taskNode: GraphNode = {
  id: 'task:northstar-core:task-1',
  kind: 'task',
  label: 'Review graph diff route',
  state: 'complete',
  domainRef: { kind: 'task', teamName: 'northstar-core', taskId: 'task-1' },
};

const noop = (): void => undefined;

async function flushReact(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
}

describe('GraphTaskCard', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    graphActivityMock.teamData = {
      tasks: [changedTask],
      members: [{ name: 'alice', color: 'blue' }],
    };
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('opens task changes from the graph card and closes the popover', async () => {
    const onViewChanges = vi.fn();
    const onClose = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <GraphTaskCard
          node={taskNode}
          teamName="northstar-core"
          onClose={onClose}
          onStartTask={noop}
          onCompleteTask={noop}
          onApproveTask={noop}
          onRequestReview={noop}
          onRequestChanges={noop}
          onCancelTask={noop}
          onMoveBackToDone={noop}
          onViewChanges={onViewChanges}
        />
      );
      await flushReact();
    });

    const changesButton = host.querySelector<HTMLButtonElement>('button[aria-label="Changes"]');
    expect(changesButton).not.toBeNull();

    await act(async () => {
      changesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await flushReact();
    });

    expect(onViewChanges).toHaveBeenCalledWith('task-1');
    expect(onClose).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
      await flushReact();
    });
  });
});
