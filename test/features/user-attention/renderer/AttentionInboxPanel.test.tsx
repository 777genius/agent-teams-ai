import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { AttentionInboxPanel } from '../../../../src/features/user-attention/renderer/ui/AttentionInboxPanel';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { AttentionModel } from '../../../../src/features/user-attention/core/domain/buildAttention';

vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({
    t: (key: string) => key,
    resolvedLanguage: 'en',
  }),
}));
vi.mock('@features/team-direct-chats/renderer', () => ({
  ChatListRow: ({
    item, onOpen,
  }: {
    item: { displayName: string; scope: { kind: string; participant: string } };
    onOpen: (scope: { kind: string; participant: string }) => void;
  }) => (
    <button type="button" data-testid="chat-row"
      onClick={() => onOpen(item.scope)}>
      {item.displayName}
    </button>
  ),
  toChatListViewItems: (items: Array<{ scope: unknown; displayName: string; unreadCount: number; attentionCount: number; previewMessage: { text: string; from: string; timestamp: string } }>) => items.map((item) => ({
    ...item, previewText: item.previewMessage.text, previewFrom: item.previewMessage.from,
    previewTimestamp: item.previewMessage.timestamp,
  })),
}));

const onOpenTask = vi.fn();
const onOpenChat = vi.fn();
const onOpenFull = vi.fn();
const onRetry = vi.fn();
const tasks = Array.from({ length: 5 }, (_, i) => ({
  teamName: 'stopped-team',
  teamDisplayName: 'Stopped team',
  taskId: String(i),
  subject: `Awaiting task ${i}`,
  requestedAt: null,
}));
const chats = Array.from({ length: 5 }, (_, i) => ({
  teamName: 'stopped-team',
  teamDisplayName: 'Stopped team',
  name: `agent-${i}`,
  scope: { kind: 'direct' as const, participant: `agent-${i}` },
  unreadCount: 2,
  latestUnread: {
    messageId: `m-${i}`, from: `agent-${i}`, to: 'user',
    text: `Please decide ${i}`, timestamp: '2026-11-23T12:00:00Z',
  },
}));
const model: AttentionModel = {
  tasks, chats,
  taskCount: 5,
  chatCount: 5,
  unreadMessageCount: 10,
  complete: true,
  countsByTeam: new Map([['stopped-team', { tasks: 5, chats: 5 }]]),
};

afterEach(() => {
  document.body.innerHTML = '';
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

describe('AttentionInboxPanel renderer', () => {
  it('reuses chat rows, limits compact task DOM, scrolls chats and opens exact destinations', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const rootEl = document.createElement('div');
    document.body.append(rootEl);
    const root = createRoot(rootEl);
    await act(async () => root.render(
      <AttentionInboxPanel variant="compact" model={model} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat}
        onOpenFull={onOpenFull} onRetry={onRetry} />
    ));
    expect(rootEl.querySelectorAll('[aria-label^="attention.openTask"]')).toHaveLength(4);
    expect(rootEl.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(5);
    expect(rootEl.querySelector('.overflow-y-auto')).not.toBeNull();
    const headerCounts = rootEl.querySelector('[data-testid="attention-counts"]');
    expect(headerCounts?.querySelector('[data-testid="attention-task-count"]')?.textContent)
      .toContain('attention.tasks: 5');
    expect(headerCounts?.querySelector('[data-testid="attention-chat-count"]')?.textContent)
      .toContain('attention.chats: 5');
    expect(headerCounts?.textContent).not.toContain('10');
    await act(async () => (rootEl.querySelector('[aria-label^="attention.openTask"]') as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith(tasks[0]);
    await act(async () => (rootEl.querySelector('[data-testid="chat-row"]') as HTMLButtonElement).click());
    expect(onOpenChat).toHaveBeenCalledWith(chats[0], chats[0].scope);
    await act(async () => root.unmount());
  });

  it('does not announce an empty state when data is incomplete', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <AttentionInboxPanel variant="full" model={{
        ...model, complete: false, tasks: [], chats: [], taskCount: 0, chatCount: 0,
      }} loading={false} error={null} onOpenTask={onOpenTask}
        onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    expect(host.textContent).toContain('attention.partial');
    expect(host.textContent).not.toContain('attention.nothing');
    await act(async () => root.unmount());
  });
});
