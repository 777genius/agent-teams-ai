import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/components/team/MemberBadge', () => ({
  MemberBadge: ({ name }: { name: string }) => React.createElement('span', null, name),
}));

vi.mock('@renderer/components/team/UnreadCommentsBadge', () => ({
  UnreadCommentsBadge: () => null,
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

import { KanbanTaskCard } from './KanbanTaskCard';

import type { TeamTaskWithKanban } from '@shared/types/team';

const baseTask: TeamTaskWithKanban = {
  id: 'task-1',
  displayId: 'abcd1234',
  subject: 'Implement safer onboarding flow',
  owner: 'alice',
  reviewer: '',
  status: 'in_progress',
  changePresence: 'unknown',
  comments: [],
  blockedBy: [],
  blocks: [],
  workIntervals: [],
  historyEvents: [],
  createdAt: '2026-04-18T10:00:00.000Z',
  updatedAt: '2026-04-18T10:10:00.000Z',
} as unknown as TeamTaskWithKanban;

const noop = (): void => undefined;

describe('KanbanTaskCard change badge', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('does not render a No changes badge when changePresence is no_changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(KanbanTaskCard, {
          task: { ...baseTask, changePresence: 'no_changes' },
          teamName: 'my-team',
          columnId: 'in_progress',
          hasReviewers: true,
          compact: false,
          taskMap: new Map(),
          memberColorMap: new Map([['alice', 'blue']]),
          onRequestReview: noop,
          onApprove: noop,
          onRequestChanges: noop,
          onMoveBackToDone: noop,
          onStartTask: noop,
          onCompleteTask: noop,
          onCancelTask: noop,
          onViewChanges: noop,
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('No changes');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('still renders the Changes action when changePresence is has_changes', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(KanbanTaskCard, {
          task: { ...baseTask, changePresence: 'has_changes' },
          teamName: 'my-team',
          columnId: 'in_progress',
          hasReviewers: true,
          compact: false,
          taskMap: new Map(),
          memberColorMap: new Map([['alice', 'blue']]),
          onRequestReview: noop,
          onApprove: noop,
          onRequestChanges: noop,
          onMoveBackToDone: noop,
          onStartTask: noop,
          onCompleteTask: noop,
          onCancelTask: noop,
          onViewChanges: noop,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Changes"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not render the Changes action when changePresence needs attention', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(KanbanTaskCard, {
          task: { ...baseTask, changePresence: 'needs_attention' },
          teamName: 'my-team',
          columnId: 'in_progress',
          hasReviewers: true,
          compact: false,
          taskMap: new Map(),
          memberColorMap: new Map([['alice', 'blue']]),
          onRequestReview: noop,
          onApprove: noop,
          onRequestChanges: noop,
          onMoveBackToDone: noop,
          onStartTask: noop,
          onCompleteTask: noop,
          onCancelTask: noop,
          onViewChanges: noop,
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('[aria-label="Changes"]')).toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
