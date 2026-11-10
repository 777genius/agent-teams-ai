import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useGroupChatHistory } from '@features/team-group-chats/renderer';
import { useMessagesReadState } from '@renderer/components/team/messages/useMessagesReadState';
import { getReadSet, markRead } from '@renderer/utils/teamMessageReadStorage';
import { expect, it, vi } from 'vitest';

import type { InboxMessage, MessagesPage } from '@shared/types';

const historyApi = vi.hoisted(() => ({ getMessagesPage: vi.fn() }));
vi.mock('@renderer/api', () => ({ api: { teams: historyApi } }));

it('shares scoped group reads across rows/thread/aggregate without finalizing a partial team feed or changing DM reads', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const group = { from: 'alice', to: 'user', timestamp: 'now', text: 'group', read: false,
    messageId: 'canonical', groupMessageId: 'canonical', groupChatId: 'group-a' } as InboxMessage;
  const dm = { ...group, messageId: 'dm', groupChatId: undefined, groupMessageId: undefined };
  markRead('sandbox', 'dm');
  // Old unscoped group state must not leak into the new root-isolated projection.
  markRead('sandbox', 'canonical');
  let view: ReturnType<typeof useMessagesReadState>;
  function Harness({ scope, partial }: { scope: string; partial: boolean }) {
    view = useMessagesReadState('sandbox', scope, [dm, group], [group], partial);
    return null;
  }
  const host = document.createElement('div');
  const root = createRoot(host);
  try {
    await act(async () => root.render(<Harness scope="root-a" partial />));
    expect(view!.readSet.has('dm')).toBe(true);
    expect(view!.readSet.has('canonical')).toBe(false);
    expect(localStorage.getItem('team-messages-read-backfill:sandbox')).toBeNull();
    await act(async () => view!.markAllRead(['canonical']));
    expect(view!.readSet.has('canonical')).toBe(true);
    await act(async () => root.render(<Harness scope="root-b" partial />));
    expect(view!.readSet.has('canonical')).toBe(false);
    expect(view!.readSet.has('dm')).toBe(true);
    await act(async () => root.render(<Harness scope="root-a" partial={false} />));
    expect(view!.readSet.has('canonical')).toBe(true);
    expect(localStorage.getItem('team-messages-read-backfill:sandbox')).toBe('1');
    expect(getReadSet('sandbox').has('dm')).toBe(true);
  } finally {
    await act(async () => root.unmount());
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});


it('does not seed a new root from the previous group history during asynchronous root navigation', async () => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  localStorage.clear();
  const oldMessage = { from: 'alice', to: 'user', timestamp: '2026-10-10T00:00:00Z', text: 'old-root', read: true,
    messageId: 'same-canonical', groupMessageId: 'same-canonical', groupChatId: 'group-a' } as InboxMessage;
  let resolveNew!: (page: MessagesPage) => void;
  historyApi.getMessagesPage.mockResolvedValueOnce({ messages: [oldMessage], hasMore: false, nextCursor: null, feedRevision: 'root-a' })
    .mockImplementation(() => new Promise<MessagesPage>(resolve => { resolveNew = resolve; }));
  let view: ReturnType<typeof useMessagesReadState>;
  const seenDuringNavigation: string[][] = [];
  function Harness({ scope }: { scope: string }) {
    const history = useGroupChatHistory('sandbox', scope, 'group-a');
    view = useMessagesReadState('sandbox', scope, history.messages, history.messages, true);
    if (scope === 'root-b') seenDuringNavigation.push(history.messages.map(message => message.text));
    return null;
  }
  const root = createRoot(document.createElement('div'));
  try {
    await act(async () => root.render(<Harness scope="root-a" />));
    expect(view!.readSet.has('same-canonical')).toBe(true);
    await act(async () => root.render(<Harness scope="root-b" />));
    expect(seenDuringNavigation.every(messages => messages.length === 0)).toBe(true);
    expect(view!.readSet.has('same-canonical')).toBe(false);
    await act(async () => resolveNew({ messages: [{ ...oldMessage, read: false, text: 'new-root' }], hasMore: false, nextCursor: null, feedRevision: 'root-b' }));
    expect(view!.readSet.has('same-canonical')).toBe(false);
  } finally {
    await act(async () => root.unmount());
    historyApi.getMessagesPage.mockReset();
    localStorage.clear();
    vi.unstubAllGlobals();
  }
});
