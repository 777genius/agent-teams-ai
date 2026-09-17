import { describe, expect, it } from 'vitest';

import {
  countUniqueUnread,
  countUnreadByConversation,
} from '@features/team-direct-chats/core/domain/countUnreadByConversation';
import { conversationScopeKey } from '@features/team-direct-chats/core/domain/conversationScope';
import {
  isAddressedToUser,
  isAttentionUnread,
  isUserUnreadMessage,
} from '@features/team-direct-chats/core/domain/isUserUnreadMessage';
import { pickPreviewMessage } from '@features/team-direct-chats/core/domain/pickPreviewMessage';

import { msg, toTestKey } from './fixtures';

const leadNames = ['oscar'];
const alice = { kind: 'direct' as const, participant: 'alice' };
const oscar = { kind: 'direct' as const, participant: 'oscar' };
const teamFeed = { kind: 'team-feed' as const };

describe('unread and attention', () => {
  it('treats agent read=true as still unread for the user', () => {
    const incoming = msg({
      from: 'alice',
      to: 'user',
      text: 'please look',
      read: true,
      messageId: 'm1',
    });
    expect(isUserUnreadMessage(incoming, new Set(), toTestKey)).toBe(true);
    expect(isAddressedToUser(incoming)).toBe(true);
  });

  it('does not count outbound as unread or attention', () => {
    const outgoing = msg({ from: 'user', to: 'alice', text: 'sent', source: 'user_sent' });
    expect(isUserUnreadMessage(outgoing, new Set(), toTestKey)).toBe(false);
    expect(isAddressedToUser(outgoing)).toBe(false);
    expect(isAttentionUnread(outgoing, new Set(), toTestKey)).toBe(false);
  });

  it('counts a2a as activity only and alice→user as both', () => {
    const a2a = msg({ from: 'cody', to: 'oscar', text: 'handoff', messageId: 'a2a' });
    const dm = msg({ from: 'alice', to: 'user', text: 'need you', messageId: 'dm' });
    const counts = countUnreadByConversation(
      [a2a, dm],
      [teamFeed, alice, oscar],
      new Set(),
      toTestKey,
      leadNames
    );

    expect(counts.get(conversationScopeKey(teamFeed))).toEqual({
      unreadCount: 2,
      attentionCount: 1,
    });
    expect(counts.get(conversationScopeKey(alice))).toEqual({
      unreadCount: 1,
      attentionCount: 1,
    });
    expect(counts.get(conversationScopeKey(oscar))).toEqual({
      unreadCount: 1,
      attentionCount: 0,
    });
  });

  it('counts lead thoughts as activity without attention', () => {
    const thought = msg({
      from: 'oscar',
      text: 'thinking',
      source: 'lead_process',
      messageId: 'th',
    });
    const counts = countUnreadByConversation(
      [thought],
      [teamFeed, oscar, alice],
      new Set(),
      toTestKey,
      leadNames
    );
    expect(counts.get(conversationScopeKey(oscar))).toEqual({
      unreadCount: 1,
      attentionCount: 0,
    });
    expect(isAddressedToUser(thought)).toBe(false);
  });

  it('does not treat bootstrap lead→member as attention', () => {
    const bootstrap = msg({ from: 'lead', to: 'oscar', text: 'start', messageId: 'b' });
    const counts = countUnreadByConversation(
      [bootstrap],
      [teamFeed, oscar],
      new Set(),
      toTestKey,
      leadNames
    );
    expect(counts.get(conversationScopeKey(oscar))).toEqual({
      unreadCount: 1,
      attentionCount: 0,
    });
  });

  it('does not double-count unique header keys across alice and team-feed', () => {
    const dm = msg({ from: 'alice', to: 'user', text: 'need you', messageId: 'dm' });
    const unique = countUniqueUnread([dm], new Set(), toTestKey);
    const perRow = countUnreadByConversation(
      [dm],
      [teamFeed, alice],
      new Set(),
      toTestKey,
      leadNames
    );
    expect(unique).toEqual({ unreadCount: 1, attentionCount: 1 });
    expect(
      (perRow.get(conversationScopeKey(teamFeed))?.unreadCount ?? 0) +
        (perRow.get(conversationScopeKey(alice))?.unreadCount ?? 0)
    ).toBe(2);
  });
});

describe('pickPreviewMessage', () => {
  it('prefers the newest to-user even when index 0 is a2a', () => {
    const a2a = msg({
      from: 'cody',
      to: 'oscar',
      text: 'later a2a',
      timestamp: '2026-09-17T13:00:00.000Z',
      messageId: 'a2a',
    });
    const dm = msg({
      from: 'alice',
      to: 'user',
      text: 'earlier dm',
      timestamp: '2026-09-17T12:00:00.000Z',
      messageId: 'dm',
    });
    const preview = pickPreviewMessage([a2a, dm]);
    expect(preview?.text).toBe('earlier dm');
    expect(preview?.timestamp).toBe(dm.timestamp);
  });

  it('falls back to newest visible when nothing is addressed to the user', () => {
    const newest = msg({ from: 'cody', to: 'oscar', text: 'newest', timestamp: '2026-09-17T13:00:00.000Z' });
    const older = msg({ from: 'system', to: 'lead', text: 'older', timestamp: '2026-09-17T12:00:00.000Z' });
    expect(pickPreviewMessage([newest, older])?.text).toBe('newest');
  });
});
