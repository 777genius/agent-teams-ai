import {
  collectThreadUnreadSnapshotKeys,
  conversationChrome,
  conversationDisplayTitle,
  resolveConversationParticipantName,
  scopedUnreadKeys,
} from '@renderer/components/team/messages/messagesPanelConversations';
import { describe, expect, it } from 'vitest';

import { msg, toTestKey } from '../../../../features/team-direct-chats/core/domain/fixtures';

import type { ResolvedTeamMember } from '@shared/types';

const labels = { list: 'Messages', teamFeed: 'This team' };

function member(name: string, agentType?: string): ResolvedTeamMember {
  return { name, agentType } as ResolvedTeamMember;
}

describe('collectThreadUnreadSnapshotKeys', () => {
  it('keeps unread keys from open time and ignores later arrivals', () => {
    const openedAt = Date.parse('2026-09-17T12:30:00.000Z');
    const existing = msg({
      from: 'alice',
      to: 'user',
      text: 'before',
      messageId: 'before',
      timestamp: '2026-09-17T12:00:00.000Z',
    });
    const later = msg({
      from: 'alice',
      to: 'user',
      text: 'after',
      messageId: 'after',
      timestamp: '2026-09-17T13:00:00.000Z',
    });
    const keys = collectThreadUnreadSnapshotKeys({
      messages: [later, existing],
      readSetAtOpen: new Set(),
      toKey: toTestKey,
      openedAt,
    });
    expect([...keys]).toEqual(['before']);
  });

  it('does not add keys that were already read at open', () => {
    const message = msg({
      from: 'alice',
      to: 'user',
      text: 'seen',
      messageId: 'seen',
    });
    const keys = collectThreadUnreadSnapshotKeys({
      messages: [message],
      readSetAtOpen: new Set(['seen']),
      toKey: toTestKey,
      openedAt: Date.parse(message.timestamp),
    });
    expect(keys.size).toBe(0);
  });

  it('removes the open-time dot after the message is read', () => {
    const message = msg({ from: 'alice', to: 'user', text: 'seen', messageId: 'seen-now' });
    const keys = collectThreadUnreadSnapshotKeys({
      messages: [message],
      readSetAtOpen: new Set(),
      readSetNow: new Set(['seen-now']),
      toKey: toTestKey,
      openedAt: Date.parse(message.timestamp),
      existing: new Set(['seen-now']),
    });
    expect(keys.size).toBe(0);
  });
});

describe('conversationDisplayTitle', () => {
  it('uses the roster name rather than the display alias for a lead thread title', () => {
    expect(
      conversationDisplayTitle(
        'thread',
        { kind: 'direct', participant: 'team-lead' },
        labels,
        [member('team-lead', 'team-lead')]
      )
    ).toBe('lead');
    expect(
      resolveConversationParticipantName([member('team-lead', 'team-lead')], 'lead')
    ).toBe('team-lead');
  });

  it('uses the roster lead name when the participant is a lead alias', () => {
    expect(
      conversationDisplayTitle(
        'thread',
        { kind: 'direct', participant: 'lead' },
        labels,
        [member('oscar', 'team-lead'), member('alice')]
      )
    ).toBe('oscar');
  });

  it('keeps the list title and This team label', () => {
    expect(conversationDisplayTitle('list', { kind: 'direct', participant: 'alice' }, labels)).toBe(
      'Messages'
    );
    expect(conversationDisplayTitle('thread', { kind: 'team-feed' }, labels)).toBe('This team');
  });
});

describe('conversationChrome', () => {
  it('locks MemberBadge to the roster name while the title can stay display-facing', () => {
    const chrome = conversationChrome(
      'thread',
      { kind: 'direct', participant: 'lead' },
      [member('team-lead', 'team-lead')],
      labels
    );
    expect(chrome.lockedRecipient).toBe('team-lead');
    expect(chrome.conversationTitle).toBe('lead');
  });

  it('does not lock a recipient on the chat list', () => {
    const chrome = conversationChrome(
      'list',
      { kind: 'direct', participant: 'alice' },
      [member('alice')],
      labels
    );
    expect(chrome.lockedRecipient).toBeUndefined();
    expect(chrome.conversationTitle).toBe('Messages');
  });
});

describe('scopedUnreadKeys', () => {
  it('marks only the visible filtered rows, not hidden matches', () => {
    const visible = msg({ from: 'alice', to: 'user', text: 'shown', messageId: 'shown' });
    const hidden = msg({ from: 'alice', to: 'user', text: 'hidden', messageId: 'hidden' });
    expect(scopedUnreadKeys([visible], new Set(), toTestKey)).toEqual(['shown']);
    expect(scopedUnreadKeys([visible, hidden], new Set(), toTestKey)).toEqual(['shown', 'hidden']);
  });
});

describe('resolveConversationParticipantName', () => {
  it('returns the exact roster name for a lowercase scope participant', () => {
    expect(
      resolveConversationParticipantName([member('Alice'), member('oscar', 'team-lead')], 'alice')
    ).toBe('Alice');
  });

  it('resolves lead aliases to the lead roster name', () => {
    expect(
      resolveConversationParticipantName(
        [member('oscar', 'team-lead'), member('alice')],
        'team-lead'
      )
    ).toBe('oscar');
  });
});
