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
    read: false,
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
  it('shows and announces the assigned member without changing ownerless labels', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <AttentionInboxPanel variant="full" model={{ ...model, tasks: [{ ...tasks[0], owner: 'team-lead' }, tasks[1]], taskCount: 2 }}
        loading={false} error={null} onOpenTask={onOpenTask} onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    expect(host.textContent).toContain('lead');
    const rows = host.querySelectorAll('[aria-label^="attention.openTask"]');
    expect(rows[0].getAttribute('aria-label')).toBe('attention.openTask · lead');
    expect(rows[1].getAttribute('aria-label')).toBe('attention.openTask');
    expect(rows[0].querySelector('img')?.getAttribute('alt')).toBe('');
    await act(async () => root.unmount());
  });

  it('shows a full-page filter dialog beside search, not on the Dashboard', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <AttentionInboxPanel variant="full" model={model} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    const search = host.querySelector('input[type="search"]') as HTMLInputElement;
    const trigger = host.querySelector('[data-testid="attention-filter-trigger"]') as HTMLButtonElement;
    expect(search).not.toBeNull();
    expect(trigger).not.toBeNull();
    expect(search.parentElement).toBe(trigger.parentElement);
    await act(async () => trigger.click());
    expect(document.querySelector('[data-testid="attention-filter-dialog"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="attention-filter-type"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="attention-filter-team"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="attention-filter-conversation"]')).not.toBeNull();
    expect(document.querySelector('[data-testid="attention-filter-waiting"]')).not.toBeNull();
    await act(async () =>
      (document.querySelector('[data-testid="attention-filter-reset"]') as HTMLButtonElement).click());
    await act(async () =>
      (document.querySelector('[data-testid="attention-filter-apply"]') as HTMLButtonElement).click());
    expect(document.querySelector('[data-testid="attention-filter-dialog"]')).toBeNull();

    await act(async () => root.render(
      <AttentionInboxPanel variant="compact" model={model} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    expect(host.querySelector('[data-testid="attention-filter-trigger"]')).toBeNull();
    expect(host.querySelector('input[type="search"]')).toBeNull();
    await act(async () => root.unmount());
  });


  it('shows up to eight older decisions and eight recent chats independently', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const rootEl = document.createElement('div');
    document.body.append(rootEl);
    const root = createRoot(rootEl);
    const moreTasks = Array.from({ length: 5 }, (_, i) => ({
      ...tasks[i], taskId: String(i + 5), subject: 'More task ' + i,
    }));
    const moreChats = Array.from({ length: 5 }, (_, i) => ({
      ...chats[i], name: 'more-agent-' + i,
      scope: { kind: 'direct' as const, participant: 'more-agent-' + i },
    }));
    await act(async () => root.render(
      <AttentionInboxPanel variant="compact" model={{
        ...model, tasks: [...tasks, ...moreTasks], chats: [...chats, ...moreChats],
        taskCount: 10, chatCount: 10,
      }} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat}
        onOpenFull={onOpenFull} onRetry={onRetry} />
    ));
    expect(rootEl.querySelectorAll('[aria-label^="attention.openTask"]')).toHaveLength(8);
    expect(rootEl.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(8);
    expect(rootEl.querySelector('.overflow-y-auto')).toBeNull();
    const sections = rootEl.querySelector('[data-testid="attention-sections"]');
    expect(sections?.className).toContain('grid-cols-1');
    expect(sections?.className).toContain('xl:grid-cols-2');
    const taskMore = rootEl.querySelector('[data-testid="attention-tasks-more"]') as HTMLButtonElement;
    const chatMore = rootEl.querySelector('[data-testid="attention-chats-more"]') as HTMLButtonElement;
    expect(taskMore).not.toBeNull();
    expect(chatMore).not.toBeNull();
    const headerCounts = rootEl.querySelector('[data-testid="attention-counts"]');
    expect(headerCounts?.querySelector('[data-testid="attention-task-count"]')?.textContent)
      .toContain('attention.tasks: 10');
    expect(headerCounts?.querySelector('[data-testid="attention-chat-count"]')?.textContent)
      .toContain('attention.chats: 10');

    await act(async () => (rootEl.querySelector('[aria-label^="attention.openTask"]') as HTMLButtonElement).click());
    expect(onOpenTask).toHaveBeenCalledWith(tasks[0]);
    await act(async () => (rootEl.querySelector('[data-testid="chat-row"]') as HTMLButtonElement).click());
    expect(onOpenChat).toHaveBeenCalledWith(chats[0], chats[0].scope);
    await act(async () => taskMore.click());
    expect(rootEl.querySelectorAll('[aria-label^="attention.openTask"]')).toHaveLength(10);
    expect(rootEl.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(8);
    await act(async () => chatMore.click());
    expect(rootEl.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(10);
    await act(async () => root.unmount());
  });

  it('filters the full inbox by team, task, speaker and message preview', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <AttentionInboxPanel variant="full" model={{
        ...model,
        tasks: [{ ...tasks[0], teamName: 'design', teamDisplayName: 'Design team',
          subject: 'Approve new banner' }, tasks[1]],
        chats: [{ ...chats[0], teamName: 'design', teamDisplayName: 'Design team',
          latestUnread: { ...chats[0].latestUnread, text: 'Choose a palette' } }, chats[1]],
        taskCount: 2, chatCount: 2,
      }} loading={false} error={null} onOpenTask={onOpenTask}
      onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    const input = host.querySelector('input[type="search"]') as HTMLInputElement;
    expect(input).not.toBeNull();
    const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    expect(valueSetter).toBeDefined();
    await act(async () => {
      valueSetter?.call(input, 'palette');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label^="attention.openTask"]')).toHaveLength(0);
    expect(host.querySelector('[data-testid="attention-sections"]')?.className)
      .toContain('flex flex-col');
    await act(async () => {
      valueSetter?.call(input, 'design team');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(1);
    expect(host.querySelectorAll('[aria-label^="attention.openTask"]')).toHaveLength(1);
    expect(host.querySelector('[data-testid="attention-sections"]')?.className)
      .toContain('xl:grid-cols-2');
    await act(async () => root.unmount());
  });


  it('finds a group chat by the sender of its latest unread message', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const groupChat = {
      ...chats[0], name: 'Release group',
      scope: { kind: 'group' as const, groupChatId: 'release-group' },
      latestUnread: { ...chats[0].latestUnread, from: 'maya', text: 'Please review the release' },
    };
    await act(async () => root.render(
      <AttentionInboxPanel variant="full" model={{
        ...model, tasks: [], chats: [groupChat], taskCount: 0, chatCount: 1,
      }} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    const input = host.querySelector('input[type="search"]') as HTMLInputElement;
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set;
    await act(async () => {
      setter?.call(input, 'maya');
      input.dispatchEvent(new Event('input', { bubbles: true }));
    });
    expect(host.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(1);
    await act(async () => root.unmount());
  });

  it('omits missing and invalid ages but displays a valid epoch timestamp', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    const epoch = '1970-01-01T00:00:00.000Z';
    await act(async () => root.render(
      <AttentionInboxPanel variant="compact" model={{
        ...model,
        tasks: [
          { ...tasks[0], requestedAt: null },
          { ...tasks[1], requestedAt: 'not-a-date' },
          { ...tasks[2], requestedAt: epoch },
        ],
        chats: [
          { ...chats[0], latestUnread: { ...chats[0].latestUnread, timestamp: 'not-a-date' } },
          { ...chats[1], latestUnread: { ...chats[1].latestUnread, timestamp: epoch } },
        ],
        taskCount: 3, chatCount: 2,
      }} loading={false} error={null}
        onOpenTask={onOpenTask} onOpenChat={onOpenChat} onRetry={onRetry} />
    ));
    const taskRows = host.querySelectorAll('[aria-label^="attention.openTask"]');
    expect(taskRows[0].textContent).not.toContain(' · ');
    expect(taskRows[1].textContent).not.toContain(' · ');
    expect(taskRows[2].textContent).toContain(' · ');
    const chatRows = host.querySelectorAll('[data-testid="chat-row"]');
    expect(chatRows[0].parentElement?.textContent).not.toContain(' · ');
    expect(chatRows[1].parentElement?.textContent).toContain(' · ');
    expect(host.textContent).not.toContain('Time unknown');
    await act(async () => root.unmount());
  });

  it('uses a compact explanatory empty state on the Dashboard', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const host = document.createElement('div');
    document.body.append(host);
    const root = createRoot(host);
    await act(async () => root.render(
      <AttentionInboxPanel variant="compact" model={{
        ...model, tasks: [], chats: [], taskCount: 0, chatCount: 0,
      }} loading={false} error={null} onOpenTask={onOpenTask}
      onOpenChat={onOpenChat} onOpenFull={onOpenFull} onRetry={onRetry} />
    ));
    const panel = host.querySelector('[data-testid="user-attention-inbox"]');
    expect(panel?.className).toContain('px-3 py-2');
    expect(panel?.className).not.toContain('p-4');
    expect(panel?.querySelector('header')?.className).not.toContain('mb-3');
    expect(panel?.querySelector('header')?.textContent).toContain('attention.nothing');
    expect(panel?.querySelector('p')).toBeNull();
    expect(host.querySelectorAll('[data-testid="chat-row"]')).toHaveLength(0);
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
