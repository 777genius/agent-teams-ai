import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { GraphActivityHud } from '@features/agent-graph/renderer/ui/GraphActivityHud';

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
  teamDataCacheByName: new Map<
    string,
    { members: Record<string, unknown>[]; tasks: unknown[]; messages: unknown[] }
  >([
    [
      'demo-team',
      {
        members: [
          { name: 'team-lead', agentType: 'team-lead' },
          { name: 'jack', agentType: 'developer' },
        ],
        tasks: [],
        messages: [],
      },
    ],
  ]),
  teams: [],
};

const buildInlineActivityEntries = vi.fn();
const originalOffsetWidthDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetWidth'
);
const originalOffsetHeightDescriptor = Object.getOwnPropertyDescriptor(
  HTMLElement.prototype,
  'offsetHeight'
);

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof teamState) => unknown) => selector(teamState),
}));

vi.mock('@renderer/store/slices/teamSlice', () => ({
  selectTeamDataForName: (_state: typeof teamState, teamName: string) =>
    teamState.teamDataCacheByName.get(teamName) ??
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

vi.mock('@features/agent-graph/core/domain/buildInlineActivityEntries', () => ({
  buildInlineActivityEntries: (...args: unknown[]) => buildInlineActivityEntries(...args),
  getGraphLeadMemberName: () => 'team-lead',
}));

describe('GraphActivityHud', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    buildInlineActivityEntries.mockReset();
    vi.stubGlobal('requestAnimationFrame', vi.fn(() => 1));
    vi.stubGlobal('cancelAnimationFrame', vi.fn());
    Object.defineProperty(HTMLElement.prototype, 'offsetWidth', {
      configurable: true,
      get() {
        return 296;
      },
    });
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get() {
        return 220;
      },
    });
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
    if (originalOffsetWidthDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetWidth', originalOffsetWidthDescriptor);
    } else {
      delete (HTMLElement.prototype as { offsetWidth?: number }).offsetWidth;
    }
    if (originalOffsetHeightDescriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', originalOffsetHeightDescriptor);
    } else {
      delete (HTMLElement.prototype as { offsetHeight?: number }).offsetHeight;
    }
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
          getActivityWorldRect: () => ({
            left: 40,
            top: 80,
            right: 336,
            bottom: 372,
            width: 296,
            height: 292,
          }),
          getCameraZoom: () => 1,
          worldToScreen: (x: number, y: number) => ({ x, y }),
          getNodeWorldPosition: () => ({ x: 120, y: 40 }),
          getViewportSize: () => ({ width: 1200, height: 800 }),
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

  it('pins the activity lane to the provided world rect without post-hoc repositioning', async () => {
    const message: InboxMessage = {
      from: 'team-lead',
      to: 'jack',
      text: 'Latest log',
      summary: 'Latest log',
      timestamp: '2026-04-13T13:36:00.000Z',
      read: false,
      messageId: 'msg-latest',
    };
    buildInlineActivityEntries.mockReturnValue(
      new Map([
        [
          'member:demo-team:jack',
          [
            {
              ownerNodeId: 'member:demo-team:jack',
              graphItem: {
                id: 'item-1',
                kind: 'inbox_message',
                timestamp: message.timestamp,
                title: message.summary ?? '',
              },
              message,
            },
          ],
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
          timestamp: message.timestamp,
          title: 'Latest log',
        },
      ],
      activityOverflowCount: 0,
    };

    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const nodeWorld = { x: 320, y: 300 };
    const laneRect = {
      left: 120,
      top: 340,
      right: 416,
      bottom: 632,
      width: 296,
      height: 292,
    };

    await act(async () => {
      root.render(
        React.createElement(GraphActivityHud, {
          teamName: 'demo-team',
          nodes: [node],
          getActivityWorldRect: () => laneRect,
          getCameraZoom: () => 1,
          getNodeWorldPosition: () => nodeWorld,
          getViewportSize: () => ({ width: 1200, height: 800 }),
          worldToScreen: (x: number, y: number) => ({ x, y }),
          focusNodeIds: null,
        })
      );
      await Promise.resolve();
    });

    const shell = host.querySelector('.z-10');
    expect(shell).not.toBeNull();
    expect((shell as HTMLDivElement).style.left).toBe(`${laneRect.left}px`);
    expect((shell as HTMLDivElement).style.top).toBe(`${laneRect.top}px`);

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
