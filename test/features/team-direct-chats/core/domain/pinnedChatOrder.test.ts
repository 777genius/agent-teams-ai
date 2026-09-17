import { conversationScopeKey } from '@features/team-direct-chats/core/domain/conversationScope';
import {
  applyPinnedChatOrder,
  movePinnedChatKey,
  normalizePinnedChatKeys,
  prunePinnedChatKeys,
  togglePinnedChatKey,
} from '@features/team-direct-chats/core/domain/pinnedChatOrder';
import { describe, expect, it } from 'vitest';

describe('pinnedChatOrder', () => {
  const teamFeed = { scope: { kind: 'team-feed' as const } };
  const alice = { scope: { kind: 'direct' as const, participant: 'alice' } };
  const oscar = { scope: { kind: 'direct' as const, participant: 'oscar' } };
  const cody = { scope: { kind: 'direct' as const, participant: 'cody' } };

  it('drops junk and duplicates while keeping first-seen pin order', () => {
    expect(
      normalizePinnedChatKeys(['direct:alice', 'nope', 'team-feed', 'direct:alice', 3, 'direct:oscar'])
    ).toEqual(['direct:alice', 'team-feed', 'direct:oscar']);
  });

  it('pins a chat at the front and unpins it in place', () => {
    expect(togglePinnedChatKey(['direct:alice'], 'direct:oscar')).toEqual([
      'direct:oscar',
      'direct:alice',
    ]);
    expect(togglePinnedChatKey(['direct:oscar', 'direct:alice'], 'direct:oscar')).toEqual([
      'direct:alice',
    ]);
  });

  it('reorders only among existing pinned keys', () => {
    expect(movePinnedChatKey(['direct:alice', 'team-feed', 'direct:oscar'], 'direct:oscar', 'direct:alice')).toEqual([
      'direct:oscar',
      'direct:alice',
      'team-feed',
    ]);
    expect(movePinnedChatKey(['direct:alice'], 'direct:alice', 'missing')).toEqual(['direct:alice']);
  });

  it('keeps roster order when nothing is pinned', () => {
    const rows = [teamFeed, oscar, alice];
    expect(
      applyPinnedChatOrder(rows, []).map((row) => conversationScopeKey(row.scope))
    ).toEqual(['team-feed', 'direct:oscar', 'direct:alice']);
  });

  it('floats pinned chats above the rest in stored order', () => {
    const rows = [teamFeed, oscar, alice, cody];
    expect(
      applyPinnedChatOrder(rows, ['direct:cody', 'team-feed']).map((row) =>
        conversationScopeKey(row.scope)
      )
    ).toEqual(['direct:cody', 'team-feed', 'direct:oscar', 'direct:alice']);
  });

  it('skips stale pin keys and prunes them against the live list', () => {
    expect(
      applyPinnedChatOrder([teamFeed, alice], ['direct:gone', 'direct:alice']).map((row) =>
        conversationScopeKey(row.scope)
      )
    ).toEqual(['direct:alice', 'team-feed']);
    expect(
      prunePinnedChatKeys(['direct:alice', 'direct:gone', 'team-feed'], new Set(['direct:alice', 'team-feed']))
    ).toEqual(['direct:alice', 'team-feed']);
  });
});
