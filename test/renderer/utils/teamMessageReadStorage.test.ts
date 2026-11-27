import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getReadSet,
  getReadSetSnapshot,
  getTeamMessageReadContextScope,
  getTeamMessageReadStorageKey,
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
    expect(localStorage.getItem('team-messages-read-backfill:alpha')).toBeNull();

    seedPersistedReadKeysOnce('alpha', ['new-read']);
    expect(getReadSet('alpha').has('new-read')).toBe(true);

    seedPersistedReadKeysOnce('alpha', ['old-read', 'new-read'], { finalize: true });
    expect(localStorage.getItem('team-messages-read-backfill:alpha')).toBe('1');
    seedPersistedReadKeysOnce('alpha', ['after-lock']);
    expect(getReadSet('alpha').has('after-lock')).toBe(false);
  });

  it('still records the backfill after a hydrated feed with no persisted-read keys', () => {
    seedPersistedReadKeysOnce('alpha', [], { finalize: true });
    expect(localStorage.getItem('team-messages-read-backfill:alpha')).toBe('1');
    seedPersistedReadKeysOnce('alpha', ['later']);
    expect(getReadSet('alpha').has('later')).toBe(false);
  });
});

describe('workspace-scoped message reads', () => {
  afterEach(() => localStorage.clear());

  it('keeps default local keys and isolates custom roots and SSH without copying legacy data', () => {
    const defaultScope = getTeamMessageReadContextScope('local', {
      defaultPath: '/default',
      resolvedPath: '/default',
    });
    const customA = getTeamMessageReadContextScope('local', {
      defaultPath: '/default',
      resolvedPath: '/custom-a',
    });
    const customB = getTeamMessageReadContextScope('local', {
      defaultPath: '/default',
      resolvedPath: '/custom-b',
    });
    const remote = getTeamMessageReadContextScope('ssh-example');
    const scopes = [defaultScope, customA, customB, remote];
    const directKeys = scopes.map((scope) => getTeamMessageReadStorageKey('same-team', scope));
    const groupKeys = scopes.map((scope) => getTeamMessageReadStorageKey('same-team', scope, 'group'));
    expect(directKeys[0]).toBe('same-team');
    expect(groupKeys[0]).toBe(JSON.stringify(['group', 'local', 'same-team']));
    expect(new Set([...directKeys, ...groupKeys]).size).toBe(8);

    markRead(directKeys[0], 'same-message');
    expect(directKeys.slice(1).every((key) => !getReadSet(key).has('same-message'))).toBe(true);
    markRead(directKeys[1], 'custom-only');
    expect(getReadSet(directKeys[2]).has('custom-only')).toBe(false);
    expect(getReadSet(directKeys[0]).has('custom-only')).toBe(false);
    expect(groupKeys.every((key) => getReadSet(key).size === 0)).toBe(true);
    expect(() => getTeamMessageReadContextScope('local')).toThrow('unavailable');
  });
});
