import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  getReadSet,
  getReadSetSnapshot,
  markBulkRead,
  markRead,
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
