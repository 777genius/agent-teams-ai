import React, { act, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { wrapAgentBlock } from '@shared/constants/agentBlocks';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { TeamFeedMessageComposer } from './TeamFeedMessageComposer';
import { useMessagesGroupConversation } from './useMessagesGroupConversation';

import type { ComposerDraftContent } from '@renderer/types/composerDraft';
import type { InboxMessage, ResolvedTeamMember } from '@shared/types';

const ports = vi.hoisted(() => ({
  load: vi.fn(),
  save: vi.fn(),
  send: vi.fn(),
  contextId: 'root-a',
}));
// Queue transaction/transport behavior has its own real IndexedDB adapter tests.
// This boundary fixture uses synthetic context ids and isolates ordinary composer recovery.
vi.mock('@features/manual-message-queue/renderer', () => ({
  useGroupMessageQueue: () => ({ onEnqueue: () => {}, list: null }),
}));
vi.mock('@renderer/api', () => ({ api: { teamGroupChats: { send: ports.send } } }));
vi.mock('@renderer/services/composerDraftRepository', () => ({
  composerDraftRepository: { loadWorking: ports.load, saveWorking: ports.save },
}));
vi.mock('@features/localization/renderer', () => ({
  useAppTranslation: () => ({ t: (key: string) => key }),
}));
const group = {
  id: 'group-a',
  name: 'Discussion',
  memberNames: ['lead', 'bob'],
  canSend: false,
  availableRecipientNames: ['bob'],
};
vi.mock('@features/team-group-chats/renderer', async () => {
  const { useGroupChatComposer } =
    await import('../../../../features/team-group-chats/renderer/hooks/useGroupChatComposer');
  return {
    useGroupChatComposer,
    useTeamGroupChats: () => ({ groups: [group], setArchived: vi.fn() }),
    useGroupChatHistory: () => ({ refresh: async () => {} }),
    GroupChatArchiveAction: () => null,
  };
});
vi.mock('@renderer/store', () => ({
  useStore: (select: (state: object) => unknown) =>
    select({
      activeContextId: ports.contextId,
      refreshTeamData: async () => {},
      showGroupTasks: () => {},
    }),
}));
vi.mock('./ThreadAwareMessageComposer', async () => ({
  ThreadAwareMessageComposer: (await import('./TextMessageComposer')).TextMessageComposer,
}));
// Keep the controlled composer and its real admission/length policy; stub only rich input UI.
vi.mock('./MessageComposerInput', () => ({
  MessageComposerInput: ({
    value,
    readOnly,
    disabled,
    onValueChange,
    canSend,
    onSend,
    sendLabel,
    footerRight,
  }: {
    value: string;
    readOnly: boolean;
    disabled: boolean;
    onValueChange: (value: string) => void;
    canSend: boolean;
    onSend: () => void;
    sendLabel: string;
    footerRight?: React.ReactNode;
  }) => (
    <>
      <textarea
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={(event) => onValueChange(event.target.value)}
      />
      <button data-send disabled={!canSend} onClick={onSend}>
        {sendLabel}
      </button>
      {footerRight}
    </>
  ),
}));
vi.mock('./MessageComposerRecipientSelector', () => ({
  MessageComposerRecipientSelector: ({
    selectedName,
    disabled,
    onSelect,
  }: {
    selectedName: string | null;
    disabled: boolean;
    onSelect: (name: string) => void;
  }) => (
    <button data-recipient disabled={disabled} onClick={() => onSelect('bob')}>
      {selectedName ?? 'All'}
    </button>
  ),
}));

const members = [
  { name: 'lead', role: 'team-lead', agentType: 'team-lead' },
  { name: 'bob', role: 'developer' },
] as ResolvedTeamMember[];
const message = {
  from: 'bob',
  to: 'user',
  text: 'Visible answer',
  timestamp: '2026-10-10T18:00:00Z',
} as InboxMessage;
const draft = (text: string, attemptId?: string): ComposerDraftContent => ({
  text,
  chips: [],
  attachments: [],
  actionMode: 'do',
  groupRecipient: { kind: 'all' },
  ...(attemptId
    ? {
        restoredOrigin: { kind: 'unconfirmed-send' as const, attemptId, messageId: attemptId },
      }
    : {}),
});
const loaded = (content: ComposerDraftContent | null, blocked = false) => ({
  working: { workingRevision: 'loaded', content },
  writeBlocked: blocked,
  readError: blocked ? 'Draft needs recovery' : undefined,
});
let host: HTMLDivElement;
let root: ReturnType<typeof createRoot>;
const input = () => host.querySelector('textarea')!;
const sendButton = () => host.querySelector<HTMLButtonElement>('[data-send]')!;
const recipient = () => host.querySelector<HTMLButtonElement>('[data-recipient]');
beforeEach(() => {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  ports.contextId = 'root-a';
  ports.load.mockReset();
  ports.send.mockReset();
  ports.save.mockReset().mockImplementation(async (_a, _r, revision) => ({
    kind: 'saved',
    workingRevision: revision,
    status: 'durable',
  }));
  host = document.createElement('div');
  document.body.appendChild(host);
  root = createRoot(host);
});
afterEach(() => {
  act(() => root.unmount());
  host.remove();
  vi.unstubAllGlobals();
});

describe('group and All composer ownership boundary', () => {
  it('keeps offline quotes editable, admits the selected member, locks unknown retry and hides an old root before effects', async () => {
    ports.load.mockResolvedValue(loaded(draft('Draft')));
    ports.send.mockRejectedValue(new Error('Connection interrupted'));
    const commits: { context: string; text: string; html: string }[] = [];
    const Conversation = ({ context }: Readonly<{ context: string }>) => {
      const conversation = useMessagesGroupConversation(
        'team-a',
        context,
        members,
        { kind: 'group', groupChatId: 'group-a' },
        {}
      );
      useLayoutEffect(() => {
        commits.push({ context, text: input().value, html: host.innerHTML });
      });
      return (
        <>
          {conversation.renderComposer()}
          {conversation.quote ? (
            <button
              data-quote
              onClick={() =>
                conversation.quote?.({
                  ...message,
                  text: 'Visible answer\n' + wrapAgentBlock('Hidden instruction'),
                })
              }
            >
              Quote
            </button>
          ) : null}
        </>
      );
    };
    await act(async () => root.render(<Conversation context="root-a" />));
    expect(sendButton().disabled).toBe(true);
    await act(async () => host.querySelector<HTMLButtonElement>('[data-quote]')!.click());
    expect(input().value).toContain('> Visible answer');
    expect(input().value).not.toContain('Hidden instruction');
    expect(recipient()?.textContent).toBe('All');
    expect(sendButton().disabled).toBe(true);
    await act(async () => recipient()!.click());
    expect(recipient()?.textContent).toBe('bob');
    expect(sendButton().disabled).toBe(false);
    await act(async () => sendButton().click());
    expect(ports.send.mock.calls[0][0].recipientName).toBe('bob');
    expect(sendButton().textContent).toBe('messages.groups.retrySend');
    expect(input().readOnly).toBe(true);
    expect(recipient()?.disabled).toBe(true);
    expect(host.querySelector('[data-quote]')).toBeNull();
    let finishLoad!: (value: ReturnType<typeof loaded>) => void;
    ports.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    await act(async () => root.render(<Conversation context="root-b" />));
    const first = commits.find((commit) => commit.context === 'root-b')!;
    expect(first.text).toBe('');
    expect(first.html).not.toContain('bob');
    expect(first.html).not.toContain('Connection interrupted');
    expect(first.html).not.toContain('messages.groups.retrySend');
    expect(recipient()).toBeNull();
    await act(async () => finishLoad(loaded(draft('Current recovered text'), true)));
    expect(input().value).toBe('Current recovered text');
    expect(input().readOnly).toBe(true);
    expect(input().disabled).toBe(false);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Draft needs recovery');
    expect(sendButton().disabled).toBe(true);
    expect(recipient()?.disabled).toBe(true);
    expect(host.querySelector('[data-quote]')).toBeNull();
  });

  it('keeps an unknown All attempt out of member navigation and preserves writeBlocked recovery after a root change', async () => {
    ports.load.mockResolvedValue(loaded(draft('Unknown All', 'saved-attempt')));
    const renderMember = vi.fn(() => <span data-private>Private draft</span>);
    const commits: { context: string; text: string; html: string }[] = [];
    const Feed = () => {
      useLayoutEffect(() => {
        commits.push({ context: ports.contextId, text: input().value, html: host.innerHTML });
      });
      return (
        <TeamFeedMessageComposer
          teamName="team-a"
          members={members}
          isTeamAlive={false}
          sending={false}
          sendError={null}
          onSend={vi.fn()}
          renderMember={renderMember}
        />
      );
    };
    await act(async () => root.render(<Feed />));
    expect(input().value).toBe('Unknown All');
    expect(input().readOnly).toBe(true);
    expect(recipient()?.disabled).toBe(true);
    expect(sendButton().disabled).toBe(false);
    expect(renderMember).not.toHaveBeenCalled();
    let finishLoad!: (value: ReturnType<typeof loaded>) => void;
    ports.load.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishLoad = resolve;
        })
    );
    ports.contextId = 'root-b';
    await act(async () => root.render(<Feed />));
    expect(commits.find((commit) => commit.context === 'root-b')?.text).toBe('');
    expect(recipient()).toBeNull();
    await act(async () => finishLoad(loaded(draft('Recover All'), true)));
    expect(input().value).toBe('Recover All');
    expect(input().readOnly).toBe(true);
    expect(input().disabled).toBe(false);
    expect(sendButton().disabled).toBe(true);
    expect(host.querySelector('[role="alert"]')?.textContent).toBe('Draft needs recovery');
    expect(renderMember).not.toHaveBeenCalled();
  });
});
