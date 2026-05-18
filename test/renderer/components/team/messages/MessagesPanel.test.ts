import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { OpenCodeRuntimeDeliveryDebugDetails } from '@renderer/utils/openCodeRuntimeDeliveryDiagnostics';
import type { InboxMessage } from '@shared/types';

const storeState = {
  sendTeamMessage: vi.fn().mockResolvedValue(undefined),
  sendCrossTeamMessage: vi.fn().mockResolvedValue(undefined),
  sendingMessage: false,
  sendMessageError: null as string | null,
  sendMessageWarning: null as string | null,
  sendMessageDebugDetails: null as OpenCodeRuntimeDeliveryDebugDetails | null,
  lastSendMessageResult: null as unknown,
  clearSendMessageRuntimeDiagnostics: vi.fn(),
  refreshSendMessageRuntimeDeliveryStatus: vi.fn().mockResolvedValue(undefined),
  teams: [],
  openTeamTab: vi.fn(),
  loadOlderTeamMessages: vi.fn().mockResolvedValue(undefined),
  refreshTeamMessagesHead: vi.fn().mockResolvedValue({
    feedChanged: true,
    headChanged: true,
    feedRevision: 'rev-1',
  }),
  teamMessagesByName: {} as Record<
    string,
    {
      canonicalMessages: InboxMessage[];
      optimisticMessages: InboxMessage[];
      feedRevision: string | null;
      nextCursor: string | null;
      hasMore: boolean;
      lastFetchedAt: number | null;
      loadingHead: boolean;
      loadingOlder: boolean;
      headHydrated: boolean;
    }
  >,
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

const sidebarUiState = {
  messagesSearchQuery: '',
  messagesFilter: { from: new Set<string>(), to: new Set<string>(), showNoise: false },
  messagesFilterOpen: false,
  messagesCollapsed: true,
  messagesSearchBarVisible: false,
  expandedItemKey: null as string | null,
  messagesScrollTop: 0,
  bottomSheetSnapIndex: 2,
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

vi.mock('@renderer/components/team/sidebar/teamSidebarUiState', () => ({
  getTeamMessagesSidebarUiState: () => ({
    messagesSearchQuery: sidebarUiState.messagesSearchQuery,
    messagesFilter: {
      from: new Set(sidebarUiState.messagesFilter.from),
      to: new Set(sidebarUiState.messagesFilter.to),
      showNoise: sidebarUiState.messagesFilter.showNoise,
    },
    messagesFilterOpen: sidebarUiState.messagesFilterOpen,
    messagesCollapsed: sidebarUiState.messagesCollapsed,
    messagesSearchBarVisible: sidebarUiState.messagesSearchBarVisible,
    expandedItemKey: sidebarUiState.expandedItemKey,
    messagesScrollTop: sidebarUiState.messagesScrollTop,
    bottomSheetSnapIndex: sidebarUiState.bottomSheetSnapIndex,
  }),
  setTeamMessagesSidebarUiState: vi.fn(),
}));

vi.mock('@renderer/components/team/activity/ActivityTimeline', () => ({
  ActivityTimeline: ({ messages, loading }: { messages: InboxMessage[]; loading?: boolean }) =>
    React.createElement(
      'div',
      { 'data-testid': 'activity-timeline' },
      loading ? React.createElement('div', null, 'timeline-loading') : null,
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

import {
  hasVisibleReplyForSendMessageDiagnostics,
  MessagesPanel,
  reconcilePendingRepliesByMember,
} from '@renderer/components/team/messages/MessagesPanel';

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
    vi.useRealTimers();
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
    storeState.clearSendMessageRuntimeDiagnostics.mockClear();
    storeState.refreshSendMessageRuntimeDeliveryStatus.mockClear();
    storeState.loadOlderTeamMessages.mockClear();
    storeState.refreshTeamMessagesHead.mockClear();
    storeState.sendingMessage = false;
    storeState.sendMessageError = null;
    storeState.sendMessageWarning = null;
    storeState.sendMessageDebugDetails = null;
    storeState.lastSendMessageResult = null;
    storeState.teamMessagesByName = {};
    sidebarUiState.messagesSearchQuery = '';
    sidebarUiState.messagesFilter = { from: new Set(), to: new Set(), showNoise: false };
    sidebarUiState.messagesFilterOpen = false;
    sidebarUiState.messagesCollapsed = true;
    sidebarUiState.messagesSearchBarVisible = false;
    sidebarUiState.expandedItemKey = null;
    sidebarUiState.messagesScrollTop = 0;
    sidebarUiState.bottomSheetSnapIndex = 2;
  });

  it('shows timeline loading before the initial message page has a cache entry', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).toContain('timeline-loading');
    expect(storeState.refreshTeamMessagesHead).toHaveBeenCalledWith('atlas-hq');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('does not keep timeline loading forever after an empty failed head attempt settles', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [],
        optimisticMessages: [],
        feedRevision: null,
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: null,
        loadingHead: false,
        loadingOlder: false,
        headHydrated: false,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('timeline-loading');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('hides passive peer summaries by default while unread badge only counts filtered unread messages', async () => {
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
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: messages,
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.textContent).not.toContain('passive-idle');
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
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: messages,
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
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

  it('clears pending replies when a real member reply to the user arrives after the pending timestamp', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const onPendingReplyChange = vi.fn();

    const pendingSentAtMs = Date.parse('2026-04-08T12:00:00.000Z');
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'member-reply',
        from: 'alice',
        to: 'user',
        read: true,
        source: 'inbox',
        timestamp: '2026-04-08T12:01:00.000Z',
        text: 'Starting now.',
      }),
    ];

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: messages,
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: { alice: pendingSentAtMs },
          onPendingReplyChange,
        })
      );
      await Promise.resolve();
    });

    expect(onPendingReplyChange.mock.calls.length).toBeGreaterThan(0);
    const updater = onPendingReplyChange.mock.calls.at(-1)?.[0] as
      | ((current: Record<string, number>) => Record<string, number>)
      | undefined;
    expect(updater?.({ alice: pendingSentAtMs })).toEqual({});

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('clears pending replies from durable user_sent history even if the local pending timestamp drifted later', () => {
    const pendingSentAtMs = Date.parse('2026-04-08T12:02:00.000Z');
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'user-send',
        from: 'user',
        to: 'forge',
        source: 'user_sent',
        timestamp: '2026-04-08T12:00:00.000Z',
        text: 'Тут?',
      }),
      makeMessage({
        messageId: 'forge-reply',
        from: 'forge',
        to: 'user',
        source: 'inbox',
        timestamp: '2026-04-08T12:00:05.000Z',
        text: 'Да, я тут.',
      }),
    ];

    expect(reconcilePendingRepliesByMember({ forge: pendingSentAtMs }, messages)).toEqual({});
  });

  it('clears pending replies when the team lead answers through a visible lead thought', () => {
    const pendingSentAtMs = Date.parse('2026-04-08T12:00:00.000Z');
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'lead-thought-reply',
        from: 'lead',
        to: undefined,
        source: 'lead_session',
        timestamp: '2026-04-08T12:00:05.000Z',
        text: 'Да, команда на месте.',
      }),
    ];

    expect(reconcilePendingRepliesByMember({ lead: pendingSentAtMs }, messages)).toEqual({});
  });

  it('keeps pending replies when the lead thought is older than the user message', () => {
    const pendingSentAtMs = Date.parse('2026-04-08T12:00:00.000Z');
    const pending = { lead: pendingSentAtMs };
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'older-lead-thought',
        from: 'lead',
        to: undefined,
        source: 'lead_session',
        timestamp: '2026-04-08T11:59:59.000Z',
        text: 'Предыдущий статус.',
      }),
    ];

    expect(reconcilePendingRepliesByMember(pending, messages)).toBe(pending);
  });

  it('detects a visible OpenCode reply for pending runtime diagnostics', () => {
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'user-send',
        from: 'user',
        to: 'tom',
        source: 'user_sent',
        timestamp: '2026-04-08T12:00:00.000Z',
        text: 'Тут?',
      }),
      makeMessage({
        messageId: 'tom-reply',
        from: 'tom',
        to: 'user',
        relayOfMessageId: 'user-send',
        timestamp: '2026-04-08T12:00:05.000Z',
        text: 'Да, я тут.',
      }),
    ];

    expect(
      hasVisibleReplyForSendMessageDiagnostics(
        {
          messageId: 'user-send',
          providerId: 'opencode',
          delivered: true,
          responsePending: true,
          responseState: 'pending',
          ledgerStatus: 'accepted',
          acceptanceUnknown: false,
          reason: 'assistant_response_pending',
          diagnostics: ['assistant_response_pending'],
        },
        messages
      )
    ).toBe(true);
  });

  it('does not treat older member messages as OpenCode replies for pending diagnostics', () => {
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'tom-old-reply',
        from: 'tom',
        to: 'user',
        timestamp: '2026-04-08T11:59:59.000Z',
        text: 'Предыдущий ответ.',
      }),
      makeMessage({
        messageId: 'user-send',
        from: 'user',
        to: 'tom',
        source: 'user_sent',
        timestamp: '2026-04-08T12:00:00.000Z',
        text: 'Тут?',
      }),
    ];

    expect(
      hasVisibleReplyForSendMessageDiagnostics(
        {
          messageId: 'user-send',
          providerId: 'opencode',
          delivered: true,
          responsePending: true,
          responseState: 'pending',
          ledgerStatus: 'accepted',
          acceptanceUnknown: false,
          reason: 'assistant_response_pending',
          diagnostics: ['assistant_response_pending'],
        },
        messages
      )
    ).toBe(false);
  });

  it('clears stale OpenCode runtime diagnostics once the member reply is visible', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const messages: InboxMessage[] = [
      makeMessage({
        messageId: 'user-send',
        from: 'user',
        to: 'tom',
        source: 'user_sent',
        timestamp: '2026-04-08T12:00:00.000Z',
        text: 'Тут?',
      }),
      makeMessage({
        messageId: 'tom-reply',
        from: 'tom',
        to: 'user',
        timestamp: '2026-04-08T12:00:05.000Z',
        text: 'Да, я тут.',
      }),
    ];

    storeState.sendMessageWarning =
      'OpenCode runtime delivery is still being checked. Message was saved and will be retried if needed.';
    storeState.sendMessageDebugDetails = {
      messageId: 'user-send',
      providerId: 'opencode',
      delivered: true,
      responsePending: true,
      responseState: 'pending',
      ledgerStatus: 'accepted',
      acceptanceUnknown: false,
      reason: 'assistant_response_pending',
      diagnostics: ['assistant_response_pending'],
    };

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: messages,
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(storeState.clearSendMessageRuntimeDiagnostics).toHaveBeenCalledWith('user-send');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('refreshes pending OpenCode runtime diagnostics after send timeout', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    storeState.sendMessageWarning =
      'OpenCode runtime delivery is still being checked. Message was saved and will be retried if needed.';
    storeState.sendMessageDebugDetails = {
      messageId: 'user-send',
      providerId: 'opencode',
      delivered: true,
      responsePending: true,
      responseState: 'pending',
      ledgerStatus: 'accepted',
      acceptanceUnknown: false,
      reason: 'assistant_response_pending',
      diagnostics: ['assistant_response_pending'],
    };

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [
          makeMessage({
            messageId: 'user-send',
            from: 'user',
            to: 'tom',
            source: 'user_sent',
            timestamp: '2026-04-08T12:00:00.000Z',
            text: 'Тут?',
          }),
        ],
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    await act(async () => {
      vi.advanceTimersByTime(15_000);
      await Promise.resolve();
    });

    expect(storeState.refreshSendMessageRuntimeDeliveryStatus).toHaveBeenCalledWith('atlas-hq', {
      messageId: 'user-send',
      statusMessageId: 'user-send',
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    vi.useRealTimers();
  });

  it('renders the bottom-sheet composer before the status block so input stays pinned near the header', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    const mountPoint = document.createElement('div');
    host.appendChild(mountPoint);
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [makeMessage()],
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'bottom-sheet',
          mountPoint,
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
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

  it('reopens the search bar when a persisted search query is active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    sidebarUiState.messagesSearchQuery = 'Тут?';
    sidebarUiState.messagesSearchBarVisible = false;

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [makeMessage({ text: 'Тут?' })],
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('input[placeholder=\"Search...\"]')).not.toBeNull();

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('reopens the search and filter bar when a persisted member filter is active', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    sidebarUiState.messagesFilter = {
      from: new Set<string>(),
      to: new Set<string>(['jack']),
      showNoise: false,
    };
    sidebarUiState.messagesSearchBarVisible = false;

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [makeMessage({ to: 'jack', text: 'Тут?' })],
        optimisticMessages: [],
        feedRevision: 'rev-1',
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: Date.now(),
        loadingHead: false,
        loadingOlder: false,
        headHydrated: true,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(host.querySelector('input[placeholder=\"Search...\"]')).not.toBeNull();
    expect(host.textContent).toContain('filter-popover');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });

  it('requests a one-shot head refresh when the messages cache is empty', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      storeState.teamMessagesByName['atlas-hq'] = {
        canonicalMessages: [],
        optimisticMessages: [],
        feedRevision: null,
        nextCursor: null,
        hasMore: false,
        lastFetchedAt: null,
        loadingHead: false,
        loadingOlder: false,
        headHydrated: false,
      };
      root.render(
        React.createElement(MessagesPanel, {
          teamName: 'atlas-hq',
          position: 'sidebar',
          onPositionChange: vi.fn(),
          members: [],
          tasks: [],
          timeWindow: null,
          pendingRepliesByMember: {},
          onPendingReplyChange: vi.fn(),
        })
      );
      await Promise.resolve();
    });

    expect(storeState.refreshTeamMessagesHead).toHaveBeenCalledWith('atlas-hq');

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
