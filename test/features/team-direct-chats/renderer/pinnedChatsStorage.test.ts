import {
  getPinnedChatKeysSnapshot,
  savePinnedChatKeys,
  subscribePinnedChats,
} from '@features/team-direct-chats/renderer/storage/pinnedChatsStorage';
import { afterEach, describe, expect, it, vi } from 'vitest';

describe('pinnedChatsStorage', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('persists pin order and notifies subscribers', () => {
    const seen: string[][] = [];
    const unsub = subscribePinnedChats(() => {
      seen.push([...getPinnedChatKeysSnapshot('robots')]);
    });

    savePinnedChatKeys('robots', ['direct:alice', 'team-feed']);
    expect([...getPinnedChatKeysSnapshot('robots')]).toEqual(['direct:alice', 'team-feed']);
    expect(seen.at(-1)).toEqual(['direct:alice', 'team-feed']);
    unsub();
  });

  it('ignores junk keys and empty team names', () => {
    savePinnedChatKeys('', ['direct:alice']);
    expect(getPinnedChatKeysSnapshot('')).toEqual([]);
    savePinnedChatKeys('robots', ['nope', 'direct:alice', 'direct:alice']);
    expect([...getPinnedChatKeysSnapshot('robots')]).toEqual(['direct:alice']);
  });

  it('keeps pin order in memory when localStorage writes fail', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('quota');
    });
    savePinnedChatKeys('robots', ['direct:alice', 'team-feed']);
    expect([...getPinnedChatKeysSnapshot('robots')]).toEqual(['direct:alice', 'team-feed']);
  });
});
