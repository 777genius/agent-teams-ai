import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type {
  DiscardQueuedUserMessagesResult,
  InboxMessage,
  QueuedUserMessagesSnapshot,
  ResolvedTeamMember,
} from '@shared/types';
import type { Root } from 'react-dom/client';

const storeState = {
  pendingApprovals: [] as { toolName: string; receivedAt: string }[],
};

const discardQueuedUserMessages =
  vi.fn<
    (
      teamName: string,
      memberName: string,
      messageId?: string
    ) => Promise<DiscardQueuedUserMessagesResult>
  >();
const getQueuedUserMessages =
  vi.fn<(teamName: string, memberName: string) => Promise<QueuedUserMessagesSnapshot>>();
const confirmMock = vi.fn<(options: Record<string, unknown>) => Promise<boolean>>();

vi.mock('@renderer/store', () => ({
  useStore: (selector: (state: typeof storeState) => unknown) => selector(storeState),
}));

vi.mock('@renderer/hooks/useTheme', () => ({
  useTheme: () => ({ isLight: false }),
}));

vi.mock('@renderer/api', () => ({
  api: {
    teams: {
      getQueuedUserMessages: (teamName: string, memberName: string) =>
        getQueuedUserMessages(teamName, memberName),
      discardQueuedUserMessages: (teamName: string, memberName: string, messageId?: string) =>
        discardQueuedUserMessages(teamName, memberName, messageId),
    },
  },
  isElectronMode: () => true,
}));

vi.mock('@renderer/components/common/ConfirmDialog', () => ({
  confirm: (options: Record<string, unknown>) => confirmMock(options),
}));

import { PendingRepliesBlock } from '@renderer/components/team/activity/PendingRepliesBlock';

const NOW_MS = Date.parse('2026-04-09T10:00:00.000Z');
const SENT_AT_MS = Date.parse('2026-04-09T09:59:00.000Z');
const TEAM_NAME = 'demo-team';

const member: ResolvedTeamMember = {
  name: 'alice',
  status: 'unknown',
  taskCount: 0,
  currentTaskId: null,
  lastActiveAt: null,
  messageCount: 0,
  color: 'blue',
  agentType: 'reviewer',
  role: 'Reviewer',
  providerId: 'anthropic',
};

function queuedMessage(timestamp: string): InboxMessage {
  return {
    from: 'user',
    to: 'alice',
    text: 'Please check the latest changes',
    timestamp,
    read: false,
    source: 'user_sent',
    messageId: `message-${timestamp}`,
  };
}

const queuedMessages = [
  queuedMessage('2026-04-09T09:59:01.000Z'),
  queuedMessage('2026-04-09T09:59:02.000Z'),
];

function inboxSnapshot(count: number): QueuedUserMessagesSnapshot {
  return {
    member: 'alice',
    messages: Array.from({ length: count }, (_unused, index) => ({
      messageId: `inbox-${index}`,
      text: 'Please check the latest changes',
      timestamp: '2026-04-09T09:59:00.000Z',
    })),
  };
}

let host: HTMLDivElement;
let root: Root;
let onQueuedDiscarded: ReturnType<typeof vi.fn>;

async function renderBlock(
  props: { teamName?: string; messages?: InboxMessage[] } = { teamName: TEAM_NAME }
): Promise<void> {
  await act(async () => {
    root.render(
      React.createElement(PendingRepliesBlock, {
        members: [member],
        nowMs: NOW_MS,
        messages: queuedMessages,
        isTeamAlive: false,
        pendingRepliesByMember: { alice: SENT_AT_MS },
        onQueuedDiscarded,
        ...props,
      })
    );
    await Promise.resolve();
  });
}

function getDiscardButton(): HTMLButtonElement | null {
  return host.querySelector<HTMLButtonElement>('button[aria-label="Discard queued messages"]');
}

async function clickDiscard(): Promise<void> {
  const button = getDiscardButton();
  expect(button).not.toBeNull();
  await act(async () => {
    button!.click();
    await Promise.resolve();
  });
  // The handler awaits the queued listing, then the confirm dialog, then the
  // discard call, so every promise chain has to drain before the outcome is
  // observable.
  await act(async () => {
    for (let drain = 0; drain < 6; drain += 1) {
      await Promise.resolve();
    }
  });
}

describe('PendingRepliesBlock queued-message discard', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    discardQueuedUserMessages.mockReset();
    getQueuedUserMessages.mockReset();
    getQueuedUserMessages.mockResolvedValue(inboxSnapshot(2));
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    onQueuedDiscarded = vi.fn();
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  });

  afterEach(async () => {
    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('reports the discarded rows to the panel without a follow-up dialog', async () => {
    discardQueuedUserMessages.mockResolvedValue({ discarded: 2, remainingQueued: 0 });
    await renderBlock();

    expect(host.textContent).toContain('2 queued');
    await clickDiscard();

    expect(discardQueuedUserMessages).toHaveBeenCalledWith(TEAM_NAME, 'alice', undefined);
    expect(onQueuedDiscarded).toHaveBeenCalledWith('alice', { discarded: 2, remainingQueued: 0 });
    // One dialog only: the confirmation. A clean discard must not stop the user
    // again to report what they just asked for.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Discard queued messages',
      message:
        'Discard 2 queued messages for "alice"? They have not been delivered yet and will be removed permanently. Delivered and agent-to-agent messages are not affected.',
      variant: 'danger',
    });
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  // Negative control for the count source: the loaded feed holds one queued row
  // for alice while the inbox holds three. The confirmation has to name the
  // three the discard will remove, not the one the feed happens to show.
  it('confirms with the inbox count when the loaded feed is only a page', async () => {
    getQueuedUserMessages.mockResolvedValue(inboxSnapshot(3));
    discardQueuedUserMessages.mockResolvedValue({ discarded: 3, remainingQueued: 0 });
    await renderBlock({ teamName: TEAM_NAME, messages: [queuedMessages[0]] });

    // The badge is fed by the page and stays quiet below two rows.
    expect(host.textContent).not.toContain('queued');
    await clickDiscard();

    expect(getQueuedUserMessages).toHaveBeenCalledWith(TEAM_NAME, 'alice');
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      message:
        'Discard 3 queued messages for "alice"? They have not been delivered yet and will be removed permanently. Delivered and agent-to-agent messages are not affected.',
    });
    expect(discardQueuedUserMessages).toHaveBeenCalledWith(TEAM_NAME, 'alice', undefined);
    expect(onQueuedDiscarded).toHaveBeenCalledWith('alice', { discarded: 3, remainingQueued: 0 });
    expect(confirmMock).toHaveBeenCalledTimes(1);
  });

  it('reports an empty inbox without asking to confirm a delete of nothing', async () => {
    getQueuedUserMessages.mockResolvedValue(inboxSnapshot(0));
    await renderBlock();

    await clickDiscard();

    expect(discardQueuedUserMessages).not.toHaveBeenCalled();
    // The panel still has to refresh the head so the entry can settle into
    // "delivered" instead of sitting on "queued" forever.
    expect(onQueuedDiscarded).toHaveBeenCalledWith('alice', { discarded: 0, remainingQueued: 0 });
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Queued messages',
      message: 'Nothing was discarded: those messages had already been delivered to "alice".',
    });
    expect(confirmMock.mock.calls[0][0]).not.toHaveProperty('variant');
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  it('surfaces the failure and touches nothing when the queued listing throws', async () => {
    getQueuedUserMessages.mockRejectedValue(
      new Error('Inbox file for "alice" is not a valid JSON message list')
    );
    await renderBlock();

    await clickDiscard();

    // A count we could not read is not a count we may confirm against.
    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(confirmMock.mock.calls[0][0]).toMatchObject({
      title: 'Failed to discard queued messages',
      message: 'Inbox file for "alice" is not a valid JSON message list',
      variant: 'danger',
    });
    expect(discardQueuedUserMessages).not.toHaveBeenCalled();
    expect(onQueuedDiscarded).not.toHaveBeenCalled();
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  it('tells the user when the runtime consumed the queue first', async () => {
    discardQueuedUserMessages.mockResolvedValue({ discarded: 0, remainingQueued: 0 });
    await renderBlock();

    await clickDiscard();

    expect(onQueuedDiscarded).toHaveBeenCalledWith('alice', { discarded: 0, remainingQueued: 0 });
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(confirmMock.mock.calls[1][0]).toMatchObject({
      title: 'Queued messages',
      message: 'Nothing was discarded: those messages had already been delivered to "alice".',
    });
    expect(confirmMock.mock.calls[1][0]).not.toHaveProperty('cancelLabel');
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  it('reports rows that arrived while the discard was running', async () => {
    discardQueuedUserMessages.mockResolvedValue({ discarded: 1, remainingQueued: 2 });
    await renderBlock();

    await clickDiscard();

    expect(onQueuedDiscarded).toHaveBeenCalledWith('alice', { discarded: 1, remainingQueued: 2 });
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(confirmMock.mock.calls[1][0]).toMatchObject({
      title: 'Queued messages',
      message: 'Discarded 1. Still queued: 2.',
    });
  });

  it('surfaces the failure and keeps the pending entry when the discard throws', async () => {
    discardQueuedUserMessages.mockRejectedValue(
      new Error('Inbox file for "alice" is not a valid JSON message list')
    );
    await renderBlock();

    await clickDiscard();

    // The rows are still on disk, so the panel must not drop the pending entry.
    expect(onQueuedDiscarded).not.toHaveBeenCalled();
    expect(confirmMock).toHaveBeenCalledTimes(2);
    expect(confirmMock.mock.calls[1][0]).toMatchObject({
      title: 'Failed to discard queued messages',
      message: 'Inbox file for "alice" is not a valid JSON message list',
      variant: 'danger',
    });
    // A failed attempt has to leave the control usable for a retry.
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  it('does not touch the inbox when the user cancels the confirmation', async () => {
    confirmMock.mockResolvedValue(false);
    await renderBlock();

    await clickDiscard();

    expect(confirmMock).toHaveBeenCalledTimes(1);
    expect(discardQueuedUserMessages).not.toHaveBeenCalled();
    expect(onQueuedDiscarded).not.toHaveBeenCalled();
    expect(getDiscardButton()?.disabled).toBe(false);
  });

  it('hides the discard control when no team name is supplied', async () => {
    await renderBlock({ teamName: undefined });

    expect(host.textContent).toContain('Queued');
    expect(getDiscardButton()).toBeNull();
  });
});
