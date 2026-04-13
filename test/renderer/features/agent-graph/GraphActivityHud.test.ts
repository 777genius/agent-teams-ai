import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphActivityHud } from '@renderer/features/agent-graph/ui/GraphActivityHud';

import type { GraphNode } from '@claude-teams/agent-graph';
import type { InboxMessage } from '@shared/types/team';

const teamState = {
  selectedTeamName: 'demo-team',
  selectedTeamData: {
    members: [
      { name: 'team-lead', agentType: 'team-lead' },
      { name: 'jack', agentType: 'developer' },
    ],
    tasks: [],
    messages: [],
  },
  teamDataCacheByName: {
    'demo-team': {
      members: [
        { name: 'team-lead', agentType: 'team-lead' },
        { name: 'jack', agentType: 'developer' },
      ],
      tasks: [],
      messages: [],
    },
  } as Record<string, { members: Array<Record<string, unknown>>; tasks: unknown[]; messages: unknown[] }>,
  teams: [],
};

const buildInlineActivityEntries = vi.fn();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof teamState) => unknown) => selector(teamState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: (_state: typeof teamState, teamName: string) =>
    teamState.teamDataCacheByName[teamName] ??
    (teamState.selectedTeamName === teamName ? teamState.selectedTeamData : null),
}));

vi.mock('zustand/react/shallow', () => ({
  useShallow: (selector: unknown) => selector,
}));

vi.mock('@renderer/hooks/useTeamMessagesRead', () => ({
  useTeamMessagesRead: () => ({
    readSet: new Set<string>(),
    markRead: vi.fn(),
    markAllRead: vi.fn(),
  }),
}));

vi.mock('@renderer/hooks/useStableTeamMentionMeta', () => ({
  useStableTeamMentionMeta: () => ({
    teamNames: [],
    teamColorByName: new Map(),
  }),
}));

vi.mock('@renderer/components/team/activity/ActivityItem', () => ({
  ActivityItem: ({ message }: { message: InboxMessage }) =>
    React.createElement('div', { 'data-testid': 'activity-item' }, message.summary ?? message.text),
}));

vi.mock('@renderer/components/team/activity/MessageExpandDialog', () => ({
  MessageExpandDialog: () => null,
}));

vi.mock('@renderer/components/team/activity/activityMessageContext', () => ({
  buildMessageContext: () => ({
    colorMap: new Map(),
    localMemberNames: new Set<string>(),
    memberInfo: new Map(),
  }),
  resolveMessageRenderProps: () => ({}),
}));

vi.mock('@renderer/features/agent-graph/utils/buildInlineActivityEntries', () => ({
  buildInlineActivityEntries: (...args: unknown[]) => buildInlineActivityEntries(...args),
  getGraphLeadMemberName: () => 'team-lead',
}));

describe('GraphActivityHud', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    buildInlineActivityEntries.mockReset();
  });

  afterEach(() => {
    document.body.innerHTML = '';
  });

  it('opens the member profile on the Activity tab when +N more is clicked', async () => {
    const visibleMessages: InboxMessage[] = [
      {
        from: 'team-lead',
        to: 'jack',
        text: 'First',
        summary: 'First',
        timestamp: '2026-04-13T13:34:00.000Z',
        read: false,
        messageId: 'msg-1',
      },
      {
        from: 'team-lead',
        to: 'jack',
        text: 'Second',
        summary: 'Second',
        timestamp: '2026-04-13T13:35:00.000Z',
        read: false,
        messageId: 'msg-2',
      },
      {
        from: 'team-lead',
        to: 'jack',
        text: 'Third',
        summary: 'Third',
        timestamp: '2026-04-13T13:36:00.000Z',
        read: false,
        messageId: 'msg-3',
      },
    ];
    buildInlineActivityEntries.mockReturnValue(
      new Map([
        [
          'member:demo-team:jack',
          visibleMessages.map((message, index) => ({
            ownerNodeId: 'member:demo-team:jack',
            graphItem: {
              id: `item-${index + 1}`,
              kind: 'inbox_message',
              timestamp: message.timestamp,
              title: message.summary ?? '',
            },
            message,
          })),
        ],
      ])
    );

    const node: GraphNode = {
      id: 'member:demo-team:jack',
      kind: 'member',
      label: 'jack',
      state: 'active',
      domainRef: { kind: 'member', teamName: 'demo-team', memberName: 'jack' },
      activityItems: [
        {
          id: 'item-1',
          kind: 'inbox_message',
          timestamp: '2026-04-13T13:36:00.000Z',
          title: 'Third',
        },
        {
          id: 'item-2',
          kind: 'inbox_message',
          timestamp: '2026-04-13T13:35:00.000Z',
          title: 'Second',
        },
        {
          id: 'item-3',
          kind: 'inbox_message',
          timestamp: '2026-04-13T13:34:00.000Z',
          title: 'First',
        },
        {
          id: 'item-4',
          kind: 'inbox_message',
          timestamp: '2026-04-13T13:33:00.000Z',
          title: 'Older hidden',
        },
      ],
      activityOverflowCount: 1,
    };

    const onOpenMemberProfile = vi.fn();
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);

    await act(async () => {
      root.render(
        React.createElement(GraphActivityHud, {
          teamName: 'demo-team',
          nodes: [node],
          getActivityAnchorScreenPlacement: () => ({ x: 40, y: 80, scale: 1, visible: true }),
          focusNodeIds: null,
          onOpenMemberProfile,
        })
      );
      await Promise.resolve();
    });

    const moreButton = Array.from(host.querySelectorAll('button')).find((button) =>
      button.textContent?.includes('+1 more')
    );
    expect(moreButton).not.toBeUndefined();

    await act(async () => {
      moreButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
      await Promise.resolve();
    });

    expect(onOpenMemberProfile).toHaveBeenCalledWith('jack', {
      initialTab: 'activity',
      initialActivityFilter: 'all',
    });

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
