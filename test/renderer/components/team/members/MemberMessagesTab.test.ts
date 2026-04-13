import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { MemberMessagesTab } from '@renderer/components/team/members/MemberMessagesTab';

import type { InboxMessage, ResolvedTeamMember, TeamTaskWithKanban } from '@shared/types';

const getMessagesPage = vi.fn();

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getMessagesPage: (...args: unknown[]) => getMessagesPage(...args),
    },
  },
}));

vi.mock('@renderer/components/team/activity/ActivityItem', () => ({
  ActivityItem: ({ message }: { message: InboxMessage }) =>
    React.createElement(
      'div',
      {
        'data-testid': 'activity-item',
        'data-kind': message.messageKind ?? 'message',
      },
      `${message.messageKind ?? 'message'}:${message.summary ?? message.text ?? ''}`
    ),
}));

vi.mock('@renderer/components/team/activity/MessageExpandDialog', () => ({
  MessageExpandDialog: () => null,
}));

vi.mock('@renderer/hooks/useTeamMessagesRead', () => ({
  useTeamMessagesRead: () => ({
    readSet: new Set<string>(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  }),
}));

describe('MemberMessagesTab', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    getMessagesPage.mockResolvedValue({
      messages: [],
      nextCursor: null,
      hasMore: false,
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    getMessagesPage.mockReset();
  });

  it('shows both messages and comments by default and filters them separately', async () => {
    const members: ResolvedTeamMember[] = [
      {
        name: 'team-lead',
        status: 'active',
        currentTaskId: null,
        taskCount: 0,
        lastActiveAt: null,
        messageCount: 0,
        agentType: 'team-lead',
      },
      {
        name: 'jack',
        status: 'active',
        currentTaskId: null,
        taskCount: 1,
        lastActiveAt: null,
        messageCount: 0,
      },
    ];
    const messages: InboxMessage[] = [
      {
        from: 'team-lead',
        to: 'jack',
        text: 'New task assigned',
        summary: 'New task assigned',
        timestamp: '2026-04-13T13:34:00.000Z',
        read: false,
        messageId: 'msg-1',
      },
    ];
    const tasks: TeamTaskWithKanban[] = [
      {
        id: 'task-1',
        displayId: '#8fdd6803',
        subject: 'Review contributor notes',
        owner: 'jack',
        status: 'in_progress',
        comments: [
          {
            id: 'comment-1',
            author: 'jack',
            text: 'Короткий отчёт по contributor pass',
            createdAt: '2026-04-13T13:35:00.000Z',
            type: 'regular',
          },
        ],
        reviewState: 'none',
      } as TeamTaskWithKanban,
    ];

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MemberMessagesTab, {
          messages,
          teamName: 'demo-team',
          memberName: 'jack',
          members,
          tasks,
        })
      );
      await Promise.resolve();
    });

    const getRenderedKinds = () =>
      Array.from(host.querySelectorAll('[data-testid="activity-item"]')).map((node) =>
        node.getAttribute('data-kind')
      );

    expect(getRenderedKinds()).toEqual(['task_comment_notification', 'message']);

    const messagesButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Messages'
    );
    expect(messagesButton).not.toBeUndefined();

    await act(async () => {
      messagesButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getRenderedKinds()).toEqual(['message']);

    const commentsButton = Array.from(host.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Comments'
    );
    expect(commentsButton).not.toBeUndefined();

    await act(async () => {
      commentsButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(getRenderedKinds()).toEqual(['task_comment_notification']);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
