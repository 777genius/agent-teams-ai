import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock idb-keyval before importing draftStorage
const store = new Map<string, unknown>();

vi.mock('idb-keyval', () => ({
  get: vi.fn((key: string) => Promise.resolve(store.get(key) ?? undefined)),
  set: vi.fn((key: string, value: unknown) => {
    store.set(key, value);
    return Promise.resolve();
  }),
  del: vi.fn((key: string) => {
    store.delete(key);
    return Promise.resolve();
  }),
  keys: vi.fn(() => Promise.resolve([...store.keys()])),
}));

import { draftStorage } from '@renderer/services/draftStorage';

import type { InlineChip } from '@renderer/types/inlineChip';

function makeChip(overrides: Partial<InlineChip> = {}): InlineChip {
  return {
    id: 'chip-1',
    filePath: '/src/auth.ts',
    fileName: 'auth.ts',
    fromLine: 10,
    toLine: 15,
    codeText: 'const x = 1;',
    language: 'typescript',
    ...overrides,
  };
}

describe('chip draft persistence via draftStorage', () => {
  beforeEach(() => {
    store.clear();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('saves and loads chips as JSON', async () => {
    const chips = [makeChip()];
    await draftStorage.saveDraft('test:chips', JSON.stringify(chips));
    const raw = await draftStorage.loadDraft('test:chips');
    expect(raw).not.toBeNull();
    const parsed = JSON.parse(raw!);
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].id).toBe('chip-1');
    expect(parsed[0].filePath).toBe('/src/auth.ts');
  });

  it('round-trips multiple chips', async () => {
    const chips = [
      makeChip({ id: 'c1', fileName: 'a.ts' }),
      makeChip({ id: 'c2', fileName: 'b.ts' }),
    ];
    await draftStorage.saveDraft('test:chips', JSON.stringify(chips));
    const raw = await draftStorage.loadDraft('test:chips');
    const parsed = JSON.parse(raw!);
    expect(parsed).toHaveLength(2);
    expect(parsed[0].fileName).toBe('a.ts');
    expect(parsed[1].fileName).toBe('b.ts');
  });

  it('deletes chip draft', async () => {
    await draftStorage.saveDraft('test:chips', JSON.stringify([makeChip()]));
    await draftStorage.deleteDraft('test:chips');
    const raw = await draftStorage.loadDraft('test:chips');
    expect(raw).toBeNull();
  });

  it('returns null for non-existent key', async () => {
    const raw = await draftStorage.loadDraft('nonexistent:chips');
    expect(raw).toBeNull();
  });

  it('handles invalid JSON gracefully (at consumer level)', async () => {
    await draftStorage.saveDraft('test:chips', 'not valid json{{{');
    const raw = await draftStorage.loadDraft('test:chips');
    // Raw value is returned; consumer (useChipDraftPersistence) handles parse errors
    expect(raw).toBe('not valid json{{{');
    expect(() => JSON.parse(raw!)).toThrow();
  });

  it('handles empty array', async () => {
    await draftStorage.saveDraft('test:chips', JSON.stringify([]));
    const raw = await draftStorage.loadDraft('test:chips');
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual([]);
  });
});
