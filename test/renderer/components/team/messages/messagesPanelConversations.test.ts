import {
  collectThreadUnreadSnapshotKeys,
  conversationDisplayTitle,
  resolveConversationParticipantName,
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
});

describe('conversationDisplayTitle', () => {
  it('maps team-lead to lead in a direct thread', () => {
    expect(
      conversationDisplayTitle('thread', { kind: 'direct', participant: 'team-lead' }, labels)
    ).toBe('lead');
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

