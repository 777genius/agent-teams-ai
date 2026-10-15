import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { TaskTooltip } from '@renderer/components/team/TaskTooltip';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/components/chat/viewers/MarkdownViewer', () => ({
  MarkdownViewer: ({ content }: { content: string }) => <div>{content}</div>,
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectResolvedMembersForTeamName: () => [],
}));

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: Record<string, unknown>) => unknown) =>
    selector({
      activeContextId: 'local',
      selectedTeamName: 'team-a',
      selectedTeamData: {
        tasks: [
          {
            id: 'canonical-a',
            displayId: '1',
            subject: 'WRONG TEAM A SUBJECT',
            status: 'pending',
          },
        ],
      },
      selectedTeamMembers: [],
      globalTasks: [
        {
          id: 'canonical-a',
          displayId: '1',
          subject: 'WRONG TEAM A SUBJECT',
          status: 'pending',
          teamName: 'team-a',
        },
        {
          id: 'canonical-b',
          displayId: '1',
          subject: 'CORRECT TEAM B SUBJECT',
          status: 'pending',
          teamName: 'team-b',
        },
      ],
      teamByName: {
        'team-a': { displayName: 'Team A' },
        'team-b': { displayName: 'Team B' },
      },
    }),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({
    children,
    onOpenChange,
  }: {
    children: React.ReactNode;
    onOpenChange: (open: boolean) => void;
  }) => {
    React.useEffect(() => onOpenChange(true), [onOpenChange]);
    return <div>{children}</div>;
  },
  TooltipTrigger: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  TooltipContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));

describe('TaskTooltip scoped resolution', () => {
  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('resolves literal same-ID target B without falling back to selected team A', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        <TaskTooltip taskId="1" teamName="team-b">
          <button>#1</button>
        </TaskTooltip>
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('CORRECT TEAM B SUBJECT');
    expect(host.textContent).not.toContain('WRONG TEAM A SUBJECT');

    await act(async () => {
      root.render(
        <TaskTooltip taskId="1">
          <button>#1</button>
        </TaskTooltip>
      );
    });
    expect(host.textContent).not.toContain('WRONG TEAM A SUBJECT');
    expect(host.textContent).not.toContain('CORRECT TEAM B SUBJECT');

    await act(async () => {
      root.render(
        <TaskTooltip taskId="1" teamName="team-b" contextId="retired-context">
          <button>#1</button>
        </TaskTooltip>
      );
    });
    expect(host.textContent).not.toContain('CORRECT TEAM B SUBJECT');

    await act(async () => root.unmount());
    host.remove();
  });
});
