import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getReadSet,
  getReadSetSnapshot,
  markBulkRead,
  markRead,
  seedPersistedReadKeysOnce,
  subscribeTeamMessageReadStore,
} from '@renderer/utils/teamMessageReadStorage';

describe('teamMessageReadStorage subscribe', () => {
  afterEach(() => {
    localStorage.clear();
    vi.restoreAllMocks();
  });

  it('notifies a second subscriber and keeps the existing key', () => {
    const seen: Set<string>[] = [];
    const unsubA = subscribeTeamMessageReadStore(() => {
      seen.push(getReadSetSnapshot('alpha'));
    });
    const unsubB = subscribeTeamMessageReadStore(() => {
      seen.push(getReadSetSnapshot('alpha'));
    });

    markRead('alpha', 'm1');
    expect(getReadSet('alpha').has('m1')).toBe(true);
    expect(seen.length).toBeGreaterThanOrEqual(2);
    unsubA();
    markBulkRead('alpha', new Set(['m1', 'm2']));
    expect(getReadSet('alpha').has('m2')).toBe(true);
    unsubB();
  });
});

describe('seedPersistedReadKeysOnce', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('seeds unread keys once and ignores later persisted flags', () => {
    seedPersistedReadKeysOnce('alpha', ['old-read']);
    expect(getReadSet('alpha').has('old-read')).toBe(true);
    expect(localStorage.getItem('team-messages-read-backfill:alpha')).toBe('1');

    seedPersistedReadKeysOnce('alpha', ['new-read']);
    expect(getReadSet('alpha').has('new-read')).toBe(false);
  });

  it('still records the backfill after a hydrated feed with no persisted-read keys', () => {
    seedPersistedReadKeysOnce('alpha', []);
    expect(localStorage.getItem('team-messages-read-backfill:alpha')).toBe('1');
    seedPersistedReadKeysOnce('alpha', ['later']);
    expect(getReadSet('alpha').has('later')).toBe(false);
  });
});
