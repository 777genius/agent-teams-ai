import { beforeEach, describe, expect, it, vi } from 'vitest';

const persisted = vi.hoisted(() => new Map<string, { value: string; timestamp: number }>());

vi.mock('idb-keyval', () => ({
  get: async (key: string) => persisted.get(key),
  set: async (key: string, value: { value: string; timestamp: number }) => {
    persisted.set(key, value);
  },
  del: async (key: string) => {
    persisted.delete(key);
  },
  keys: async () => [...persisted.keys()],
}));

import { draftStorage } from '@renderer/services/draftStorage';

describe('create-team template choice retention', () => {
  beforeEach(() => {
    persisted.clear();
    vi.useRealTimers();
  });

  it('keeps the template source in step with retained creation form data after the normal TTL', async () => {
    const now = new Date('2026-11-21T10:00:00Z').getTime();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    const template = JSON.stringify({ source: 'custom', value: 'custom:preserved' });
    persisted.set('draft:createTeam:templateSelection', {
      value: template,
      timestamp: now - 2 * 24 * 60 * 60 * 1000,
    });
    persisted.set('draft:other:temporary', {
      value: 'expired',
      timestamp: now - 2 * 24 * 60 * 60 * 1000,
    });
    await draftStorage.cleanupExpired();
    expect(await draftStorage.loadDraft('createTeam:templateSelection')).toBe(template);
    expect(await draftStorage.loadDraft('other:temporary')).toBe(null);
  });
});
