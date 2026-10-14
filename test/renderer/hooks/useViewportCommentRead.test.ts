import { describe, expect, it, vi } from 'vitest';

import { getVisibleCommentIdsFallback } from '../../../src/renderer/hooks/useViewportCommentRead';

function makeRect({
  top,
  bottom,
  left = 0,
  right = 100,
}: {
  top: number;
  bottom: number;
  left?: number;
  right?: number;
}): DOMRect {
  return {
    x: left,
    y: top,
    top,
    bottom,
    left,
    right,
    width: right - left,
    height: bottom - top,
    toJSON: () => ({}),
  } as DOMRect;
}

describe('getVisibleCommentIdsFallback', () => {
  it('returns comment IDs that are visibly inside the scroll container', () => {
    const container = document.createElement('div');
    const visible = document.createElement('div');
    const hidden = document.createElement('div');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 100, bottom: 300 })
    );
    vi.spyOn(visible, 'getBoundingClientRect').mockReturnValue(makeRect({ top: 120, bottom: 180 }));
    vi.spyOn(hidden, 'getBoundingClientRect').mockReturnValue(makeRect({ top: 320, bottom: 380 }));

    const result = getVisibleCommentIdsFallback(
      container,
      new Map([
        ['visible-comment', visible],
        ['hidden-comment', hidden],
      ])
    );

    expect(result).toEqual(['visible-comment']);
  });

  it('requires at least 10% of the comment height to be visible', () => {
    const container = document.createElement('div');
    const barelyVisible = document.createElement('div');
    const enoughVisible = document.createElement('div');

    vi.spyOn(container, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 100, bottom: 300 })
    );
    vi.spyOn(barelyVisible, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 295, bottom: 405 })
    );
    vi.spyOn(enoughVisible, 'getBoundingClientRect').mockReturnValue(
      makeRect({ top: 290, bottom: 390 })
    );

    const result = getVisibleCommentIdsFallback(
      container,
      new Map([
        ['barely-visible', barelyVisible],
        ['enough-visible', enoughVisible],
      ])
    );

    expect(result).toEqual(['enough-visible']);
  });
});

describe('context-scoped comment read persistence', () => {
  it('migrates old contextless markers only into the local context', async () => {
    vi.resetModules();
    localStorage.clear();
    localStorage.setItem(
      'comment-read-state-v2',
      JSON.stringify({
        'same-team/1': { readIds: ['same-comment'], lastUpdated: 1 },
      })
    );
    const storage = await import('../../../src/renderer/services/commentReadStorage');
    const comments = [{ id: 'same-comment', createdAt: '2026-01-01T00:00:00Z' }];
    expect(
      storage.getUnreadCount(
        storage.getSnapshot(),
        { contextId: 'local', teamName: 'same-team', taskId: '1' },
        comments
      )
    ).toBe(0);
    expect(
      storage.getUnreadCount(
        storage.getSnapshot(),
        { contextId: 'remote', teamName: 'same-team', taskId: '1' },
        comments
      )
    ).toBe(1);
    localStorage.clear();
  });

  it('does not resurrect a legacy manual-unread marker after a newer local read', async () => {
    vi.resetModules();
    localStorage.clear();
    let resolve!: (value: unknown) => void;
    const pending = new Promise((inner) => {
      resolve = inner;
    });
    const getStored = vi.fn(() => pending);
    vi.doMock('idb-keyval', () => ({ get: getStored, set: async () => undefined }));
    vi.stubGlobal('indexedDB', {});
    const storage = await import('../../../src/renderer/services/commentReadStorage');
    const unsubscribe = storage.subscribe(() => undefined);
    const identity = { contextId: 'local', teamName: 'same-team', taskId: '1' };
    storage.markCommentsRead(identity, ['same-comment']);
    const unsubscribeLaterSurface = storage.subscribe(() => undefined);
    expect(getStored).toHaveBeenCalledTimes(1);
    resolve({ 'same-team/1': { readIds: [], lastUpdated: 1, manualUnread: true } });
    await pending;
    await Promise.resolve();
    expect(
      storage.getUnreadCount(storage.getSnapshot(), identity, [
        { id: 'same-comment', createdAt: '2026-01-01T00:00:00Z' },
      ])
    ).toBe(0);
    unsubscribe();
    unsubscribeLaterSurface();
    vi.doUnmock('idb-keyval');
    vi.unstubAllGlobals();
    localStorage.clear();
  });
});
