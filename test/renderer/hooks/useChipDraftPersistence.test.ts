import { act, createElement, type ReactElement } from 'react';
import { createRoot } from 'react-dom/client';

import { useChipDraftPersistence } from '@renderer/hooks/useChipDraftPersistence';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Mock idb-keyval before importing draftStorage
const store = new Map<string, unknown>();

vi.mock('idb-keyval', async (importOriginal) => ({
  ...(await importOriginal<typeof import('idb-keyval')>()),
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

  it('does not show Saved when an older chip write finishes after an edit', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    let releaseSave!: () => void;
    const oldWrite = new Promise<void>((resolve) => { releaseSave = resolve; });
    const save = vi.spyOn(draftStorage, 'saveDraft')
      .mockImplementationOnce(() => oldWrite)
      .mockResolvedValue(undefined);
    let draft!: ReturnType<typeof useChipDraftPersistence>;
    function Input(): ReactElement {
      draft = useChipDraftPersistence('createTeam:prompt:chips');
      return createElement('span', { 'data-saved': draft.isSaved });
    }
    const root = createRoot(document.createElement('div'));
    vi.useFakeTimers();
    try {
      await act(async () => { root.render(createElement(Input)); });
      await act(async () => { draft.setChips([makeChip()]); });
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(save).toHaveBeenCalledTimes(1);
      await act(async () => { draft.setChips([makeChip({ id: 'newer-chip' })]); });
      await act(async () => { releaseSave(); await Promise.resolve(); });
      expect(draft.chips[0]?.id).toBe('newer-chip');
      expect(draft.isSaved).toBe(false);
      await act(async () => { await vi.advanceTimersByTimeAsync(500); });
      expect(draft.isSaved).toBe(true);
    } finally {
      await act(async () => { root.unmount(); });
      vi.useRealTimers();
      save.mockRestore();
      vi.unstubAllGlobals();
    }
  });

  it('handles empty array', async () => {
    await draftStorage.saveDraft('test:chips', JSON.stringify([]));
    const raw = await draftStorage.loadDraft('test:chips');
    const parsed = JSON.parse(raw!);
    expect(parsed).toEqual([]);
  });
});
