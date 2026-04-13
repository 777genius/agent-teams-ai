import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { InboxMessage } from '@shared/types';

const storeState = {
  sendTeamMessage: vi.fn().mockResolvedValue(undefined),
  sendCrossTeamMessage: vi.fn().mockResolvedValue(undefined),
  sendingMessage: false,
  sendMessageError: null,
  lastSendMessageResult: null,
  teams: [],
  openTeamTab: vi.fn(),
};

const readHookState = {
  readSet: new Set<string>(),
  markRead: vi.fn(),
  markAllRead: vi.fn(),
};

const expandedHookState = {
  expandedSet: new Set<string>(),
  toggle: vi.fn(),
};

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/hooks/useStableTeamMentionMeta', () => ({
  useStableTeamMentionMeta: () => ({
    teamNames: [],
    teamColorByName: new Map<string, string>(),
  }),
}));

vi.mock('@renderer/hooks/useTeamMessagesRead', () => ({
  useTeamMessagesRead: () => readHookState,
}));

vi.mock('@renderer/hooks/useTeamMessagesExpanded', () => ({
  useTeamMessagesExpanded: () => expandedHookState,
}));

vi.mock('@renderer/components/ui/badge', () => ({
  Badge: ({ children }: { children: React.ReactNode }) =>
    React.createElement('span', null, children),
}));

vi.mock('@renderer/components/ui/button', () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: React.MouseEventHandler<HTMLButtonElement>;
  }) => React.createElement('button', { type: 'button', onClick }, children),
}));

vi.mock('@renderer/components/ui/tooltip', () => ({
  Tooltip: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipTrigger: ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  TooltipContent: ({ children }: { children: React.ReactNode }) =>
    React.createElement('div', null, children),
}));

vi.mock('@renderer/components/team/messages/MessageComposer', () => ({
  MessageComposer: () => React.createElement('div', null, 'composer'),
}));

vi.mock('@renderer/components/team/messages/MessagesFilterPopover', () => ({
  MessagesFilterPopover: () => React.createElement('div', null, 'filter-popover'),
}));

vi.mock('@renderer/components/team/messages/StatusBlock', () => ({
  StatusBlock: () => React.createElement('div', null, 'status-block'),
}));

vi.mock('@renderer/components/team/activity/ActivityTimeline', () => ({
  ActivityTimeline: ({ messages }: { messages: InboxMessage[] }) =>
    React.createElement(
      'div',
      { 'data-testid': 'activity-timeline' },
      messages.map((message) =>
        React.createElement(
          'div',
          {
            key: message.messageId ?? `${message.from}-${message.timestamp}`,
            'data-message-id': message.messageId ?? '',
          },
          `${message.messageId ?? 'no-id'}:${message.text}`
        )
      )
    ),
}));

vi.mock('@renderer/components/team/activity/MessageExpandDialog', () => ({
  MessageExpandDialog: () => null,
}));

vi.mock('react-modal-sheet', () => ({
  Sheet: Object.assign(
    ({ children }: { children: React.ReactNode }) => React.createElement('div', null, children),
    {
      Container: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', null, children),
      Header: ({ children }: { children?: React.ReactNode }) =>
        React.createElement('div', null, children),
      DragIndicator: () => React.createElement('div', null, 'drag-indicator'),
      Content: ({ children }: { children: React.ReactNode }) =>
        React.createElement('div', null, children),
    }
  ),
}));

import { MessagesPanel } from '@renderer/components/team/messages/MessagesPanel';

function makeMessage(overrides: Partial<InboxMessage> = {}): InboxMessage {
  return {
    from: 'alice',
    text: 'Hello',
    timestamp: '2026-04-08T12:00:00.000Z',
    read: true,
    source: 'inbox',
    messageId: 'msg-1',
    ...overrides,
  };
}

describe('MessagesPanel idle summary invariants', () => {
  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  beforeEach(() => {
    readHookState.readSet = new Set<string>();
    readHookState.markRead.mockReset();
    readHookState.markAllRead.mockReset();
    expandedHookState.expandedSet = new Set<string>();
    expandedHookState.toggle.mockReset();
    storeState.sendTeamMessage.mockClear();
    storeState.sendCrossTeamMessage.mockClear();
    storeState.openTeamTab.mockClear();
  });

  it('keeps read passive peer summaries in the activity timeline while unread badge only counts filtered unread messages', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'passive-idle',
        from: 'alice',
        read: true,
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
      }),
      makeMessage({
        messageId: 'human-reply',
        from: 'bob',
        read: false,
        text: 'Need one more input from you',
        timestamp: '2026-04-08T12:02:00.000Z',
      }),
    ];

    await act(async () => {
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          messages,
          timeWindow: null,
          teamSessionIds: new Set<string>(),
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('passive-idle');
    expect(host.textContent).toContain('human-reply');
    expect(host.textContent).toContain('1 new');
    expect(host.textContent).not.toContain('2 new');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not clear pending replies when only a passive idle summary arrives', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onPendingReplyChange = vi.fn();

    const pendingSentAtMs = Date.parse('2026-04-08T12:00:00.000Z');
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'passive-idle',
        from: 'alice',
        read: true,
        timestamp: '2026-04-08T12:01:00.000Z',
        text: JSON.stringify({
          type: 'idle_notification',
          idleReason: 'available',
          summary: '[to bob] aligned on rollout order',
        }),
      }),
    ];

    await act(async () => {
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          messages,
          timeWindow: null,
          teamSessionIds: new Set<string>(),
          pendingRepliesByMember: { alice: pendingSentAtMs },
          onPendingReplyChange,
        })
      );
      await Promise.resolve();
    });

    expect(onPendingReplyChange).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('renders the bottom-sheet composer before the status block so input stays pinned near the header', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const mountPoint = document.createElement('div');
    host.appendChild(mountPoint);
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'bottom-sheet',
          mountPoint,
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          messages: [makeMessage()],
          timeWindow: null,
          teamSessionIds: new Set<string>(),
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    const text = host.textContent ?? '';
    expect(text.indexOf('composer')).toBeGreaterThan(-1);
    expect(text.indexOf('status-block')).toBeGreaterThan(text.indexOf('composer'));

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
