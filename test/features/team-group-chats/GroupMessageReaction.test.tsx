import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { LocalizationProvider } from '@features/localization/renderer';
import { ActivityMessageFooter } from '@renderer/components/team/activity/ActivityMessageFooter';
import { TooltipProvider } from '@renderer/components/ui/tooltip';
import { describe, expect, it, vi } from 'vitest';

import type { GroupMessageReactionTarget } from '../../../src/features/team-group-chats/contracts';
import type { InboxMessage, TeamChangeEvent } from '@shared/types';

const ports = vi.hoisted(() => ({ get: vi.fn(), set: vi.fn(), subscribe: vi.fn() }));
vi.mock('@renderer/api', () => ({
  api: {
    teamGroupChats: { getReaction: ports.get, setReaction: ports.set },
    teams: { onTeamChange: ports.subscribe },
  },
}));
vi.mock('@renderer/store', async () => {
  const { create } = await import('zustand');
  return { useStore: create(() => ({ activeContextId: 'local', isContextSwitching: false })) };
});

describe('shared canonical reaction footer', () => {
  it('renders an agent post in collapsed feed and custom views, refreshes both after a click, and excludes unsupported rows', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const target: GroupMessageReactionTarget = {
      teamName: 'test-team',
      groupChatId: '3f622f25-697c-42db-85aa-ea44b6d7c062',
      messageId: 'd49f3a9c-50a0-42e2-b8d3-632d7feb7f4c',
    };
    const message: InboxMessage = {
      from: 'alice',
      to: 'user',
      text: 'Informational update',
      read: false,
      timestamp: '2026-10-11T08:00:00.000Z',
      source: 'runtime_delivery',
      messageId: target.messageId,
      groupMessageId: target.messageId,
      groupChatId: target.groupChatId,
      groupChatProtocolVersion: 1,
    };
    let actorNames = ['alice'];
    const listeners = new Set<(event: unknown, change: TeamChangeEvent) => void>();
    const snapshot = () => ({
      ...target,
      actorNames,
      canReact: true,
      hasUserReacted: actorNames.includes('user'),
    });
    ports.get.mockImplementation(async (query) => ({ ...snapshot(), ...query }));
    ports.subscribe.mockImplementation((listener) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    });
    ports.set.mockImplementation(async () => {
      actorNames = ['alice', 'user'];
      for (const listener of listeners)
        listener(undefined, {
          type: 'group-reactions',
          teamName: target.teamName,
          detail: target.messageId,
        });
      return snapshot();
    });
    try {
      await act(async () =>
        root.render(
          <LocalizationProvider appConfig={null}>
            <TooltipProvider delayDuration={0}>
              <ActivityMessageFooter
                teamName={target.teamName}
                message={message}
                expanded={false}
              />
              <ActivityMessageFooter teamName={target.teamName} message={message} expanded />
              <ActivityMessageFooter
                teamName={target.teamName}
                message={{ ...message, groupChatProtocolVersion: undefined }}
                expanded
              />
              <ActivityMessageFooter
                teamName={target.teamName}
                message={{ ...message, messageId: 'physical-inbound', to: 'bob' }}
                expanded
              />
              <ActivityMessageFooter
                teamName={target.teamName}
                message={{ ...message, messageId: 'queued-unsent', groupMessageId: undefined }}
                expanded
              />
            </TooltipProvider>
          </LocalizationProvider>
        )
      );
      const buttons = host.querySelectorAll('button');
      expect(buttons).toHaveLength(2);
      expect([...buttons].map((button) => button.textContent)).toEqual(['👍1', '👍1']);
      expect(ports.get.mock.calls.map(([query]) => query)).toEqual([target, target]);
      await act(async () => buttons[0].click());
      expect(ports.set).toHaveBeenCalledWith({ ...target, active: true });
      expect([...buttons].map((button) => button.textContent)).toEqual(['👍2', '👍2']);
      expect([...buttons].map((button) => button.getAttribute('aria-pressed'))).toEqual([
        'true',
        'true',
      ]);
      await act(async () => buttons[0].focus());
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('alice');
      expect(document.querySelector('[role="tooltip"]')?.textContent).toContain('user');
      const sentinelIds = [
        '00000000-0000-0000-0000-000000000000',
        'ffffffff-ffff-ffff-ffff-ffffffffffff',
      ];
      await act(async () =>
        root.render(
          <LocalizationProvider appConfig={null}>
            <TooltipProvider>
              {sentinelIds.map((messageId) => (
                <ActivityMessageFooter
                  key={messageId}
                  teamName={target.teamName}
                  message={{ ...message, messageId, groupMessageId: messageId }}
                  expanded={false}
                />
              ))}
            </TooltipProvider>
          </LocalizationProvider>
        )
      );
      expect(host.querySelectorAll('button')).toHaveLength(2);
      expect(ports.get.mock.calls.slice(-2).map(([query]) => query)).toEqual(
        sentinelIds.map((messageId) => ({ ...target, messageId }))
      );
    } finally {
      act(() => root.unmount());
      host.remove();
      vi.unstubAllGlobals();
    }
    expect(listeners.size).toBe(0);
  });
});
