import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { describe, expect, it, vi } from 'vitest';

import { useGroupChatHistory } from '../../../src/features/team-group-chats/renderer/hooks/useGroupChatHistory';

import type { InboxMessage } from '@shared/types';

const ports = vi.hoisted(() => ({ page: vi.fn() }));
vi.mock('@renderer/api', () => ({
  api: { teams: { getMessagesPage: ports.page, onTeamChange: () => () => undefined } },
}));

describe('loaded group history lifetime', () => {
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
