import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  calculateConversationWindow,
  classifyConversationHead,
  projectTimelineRows,
} from '@renderer/components/team/activity/conversationWindow';
import { describe, expect, it, vi } from 'vitest';

import { useGroupChatHistory } from '../../../src/features/team-group-chats/renderer/hooks/useGroupChatHistory';

import type { InboxMessage } from '@shared/types';

const ports = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('@renderer/api', () => ({
  api: { teams: { getMessagesPage: ports.page, onTeamChange: () => () => undefined } },
}));

describe('loaded group history lifetime', () => {
  it('keeps the newest group messages at the bottom through refresh and older pagination', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const message = (position: number, id = String(position)): InboxMessage => ({
      from: 'alice',
      to: 'user',
      text: id,
      timestamp: new Date(Date.UTC(2026, 9, 10, 10, 0, position)).toISOString(),
      read: false,
      messageId: id,
      groupMessageId: id,
      groupChatId: 'group',
    });
    const initial = Array.from({ length: 35 }, (_, index) => message(35 - index));
    ports.page.mockReset();
    ports.page.mockResolvedValue({
      messages: initial,
      nextCursor: 'older-page',
      hasMore: true,
    });
    let history: ReturnType<typeof useGroupChatHistory>;
    function Probe() {
      history = useGroupChatHistory('team', 'root', 'group');
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        view.render(<Probe />);
      });
      expect(history!.messages.map((item) => item.messageId)).toEqual(
        Array.from({ length: 35 }, (_, index) => String(35 - index))
      );
      const initialWindow = calculateConversationWindow(history!.messages, 30);
      expect(
        projectTimelineRows(initialWindow.visibleMessages, 'conversation').map(
          (item) => item.messageId
        )
      ).toEqual(Array.from({ length: 30 }, (_, index) => String(index + 6)));
      const previousKeys = new Set(history!.messages.map((item) => item.messageId!));
      const visibleKeys = new Set(initialWindow.visibleMessages.map((item) => item.messageId!));
      ports.page.mockResolvedValue({
        messages: [message(36), { ...message(35), text: 'updated reply' }],
        nextCursor: 'new-head-cursor',
        hasMore: true,
      });
      await act(async () => {
        await history!.refresh();
      });
      expect([...classifyConversationHead(history!.messages, previousKeys)]).toEqual(['36']);
      expect(history!.messages[1].text).toBe('updated reply');
      const refreshed = calculateConversationWindow(history!.messages, 30, visibleKeys);
      expect(refreshed.budget).toBe(31);
      expect(
        projectTimelineRows(refreshed.visibleMessages, 'conversation').map((item) => item.messageId)
      ).toEqual(Array.from({ length: 31 }, (_, index) => String(index + 6)));
      const refreshedKeys = new Set(history!.messages.map((item) => item.messageId!));
      ports.page.mockResolvedValue({
        messages: [message(0, 'older-b'), message(0, 'older-a')],
        nextCursor: null,
        hasMore: false,
      });
      await act(async () => {
        await history!.loadOlder();
      });
      expect(ports.page).toHaveBeenLastCalledWith('team', {
        groupChatId: 'group',
        limit: 100,
        cursor: 'older-page',
      });
      expect(history!.messages.slice(-2).map((item) => item.messageId)).toEqual([
        'older-a',
        'older-b',
      ]);
      expect([...classifyConversationHead(history!.messages, refreshedKeys)]).toEqual([]);
      expect(calculateConversationWindow(history!.messages, 31, visibleKeys).budget).toBe(31);
      const allRows = projectTimelineRows(history!.messages, 'conversation');
      expect(allRows.slice(0, 2).map((item) => item.messageId)).toEqual(['older-b', 'older-a']);
      expect(allRows.at(-1)?.messageId).toBe('36');
      expect(history!.hasMore).toBe(false);
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });

  it('retains loaded groups and deduplicates refreshes, without exposing another root or team', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const message = (id: string, groupChatId: string): InboxMessage => ({
      from: 'alice',
      to: 'user',
      text: id,
      timestamp: '2026-10-10T10:00:00.000Z',
      read: false,
      messageId: id,
      groupMessageId: id,
      groupChatId,
    });
    ports.page.mockImplementation((_team: string, query: { groupChatId: string }) =>
      Promise.resolve({
        messages: [message(query.groupChatId, query.groupChatId)],
        nextCursor: null,
        hasMore: false,
      })
    );
    let history: ReturnType<typeof useGroupChatHistory>;
    const renders: { root: string; team: string; known: string[]; current: string[] }[] = [];
    function Probe({
      root = 'root-a',
      team = 'team-a',
      group,
    }: {
      root?: string;
      team?: string;
      group?: string;
    }) {
      history = useGroupChatHistory(team, root, group);
      renders.push({
        root,
        team,
        known: history.knownMessages.map((m) => m.messageId!),
        current: history.messages.map((m) => m.messageId!),
      });
      return null;
    }
    const view = createRoot(document.createElement('div'));
    try {
      await act(async () => {
        view.render(<Probe group="old-group" />);
        await Promise.resolve();
      });
      expect(history!.messages.map((m) => m.messageId)).toEqual(['old-group']);
      await act(async () => {
        await history!.refresh();
      });
      expect(history!.knownMessages.map((m) => m.messageId)).toEqual(['old-group']);
      await act(async () => {
        view.render(<Probe group="new-group" />);
        await Promise.resolve();
      });
      expect(
        history!.knownMessages
          .map((m) => m.messageId)
          .sort((a, b) => String(a).localeCompare(String(b)))
      ).toEqual(['new-group', 'old-group']);
      await act(async () => {
        view.render(<Probe />);
        await Promise.resolve();
      });
      expect(history!.messages).toEqual([]);
      expect(history!.knownMessages).toHaveLength(2);
      ports.page.mockImplementation(() => new Promise<never>(() => undefined));
      await act(async () => {
        view.render(<Probe group="old-group" />);
        await Promise.resolve();
      });
      expect(history!.messages.map((m) => m.messageId)).toEqual(['old-group']);
      await act(async () => {
        view.render(<Probe root="root-b" group="old-group" />);
        await Promise.resolve();
      });
      expect(renders.find((render) => render.root === 'root-b')).toMatchObject({
        known: [],
        current: [],
      });
      expect(history!.knownMessages).toEqual([]);
      ports.page.mockResolvedValue({
        messages: [message('new-root-message', 'old-group')],
        nextCursor: null,
        hasMore: false,
      });
      await act(async () => {
        await history!.refresh();
      });
      // A pending request is isolated; changing the team must never reveal the prior cache.
      await act(async () => {
        view.render(<Probe root="root-b" team="team-b" group="old-group" />);
        await Promise.resolve();
      });
      expect(renders.find((render) => render.team === 'team-b')).toMatchObject({
        known: [],
        current: [],
      });
    } finally {
      act(() => view.unmount());
      vi.unstubAllGlobals();
    }
  });
});
