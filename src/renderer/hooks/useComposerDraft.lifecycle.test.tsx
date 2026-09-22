import React, { act, useEffect } from 'react';
import { createRoot } from 'react-dom/client';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const {
  deleteSnapshotIfMatchesMock,
  deleteSnapshotMock,
  emptySnapshotMock,
  loadSnapshotMock,
  migrateLegacyMock,
  saveSnapshotMock,
} = vi.hoisted(() => {
  interface MockSnapshot {
    version: number;
    teamName: string;
    text: string;
    chips: unknown[];
    attachments: unknown[];
    actionMode?: string;
    pendingSendId?: string;
    updatedAt: number;
  }

  const deleteSnapshot = vi.fn();
  const loadSnapshot = vi.fn();

  return {
    deleteSnapshotIfMatchesMock: vi.fn(
      async (teamName: string, predicate: (snapshot: MockSnapshot | null) => boolean) => {
        const snapshot = (await loadSnapshot(teamName)) as MockSnapshot | null;
        if (predicate(snapshot)) {
          await deleteSnapshot(teamName);
        }
      }
    ),
    deleteSnapshotMock: deleteSnapshot,
    emptySnapshotMock: vi.fn((teamName: string) => ({
      version: 1,
      teamName,
      text: '',
      chips: [],
      attachments: [],
      actionMode: 'do',
      updatedAt: Date.now(),
    })),
    loadSnapshotMock: loadSnapshot,
    migrateLegacyMock: vi.fn(),
    saveSnapshotMock: vi.fn(),
  };
});

vi.mock('@renderer/services/composerDraftStorage', () => ({
  composerDraftStorage: {
    deleteSnapshotIfMatches: deleteSnapshotIfMatchesMock,
    deleteSnapshot: deleteSnapshotMock,
    emptySnapshot: emptySnapshotMock,
    loadSnapshot: loadSnapshotMock,
    migrateLegacy: migrateLegacyMock,
    saveSnapshot: saveSnapshotMock,
  },
}));

import { useComposerDraft } from './useComposerDraft';

const HookProbe = ({
  onLoaded,
}: {
  onLoaded: (draft: ReturnType<typeof useComposerDraft>) => void;
}): React.JSX.Element | null => {
  const draft = useComposerDraft('team-alpha');

  useEffect(() => {
    if (draft.isLoaded) {
      onLoaded(draft);
    }
  }, [draft, onLoaded]);

  return null;
};

async function renderLoadedHook(): Promise<{
  getDraft: () => ReturnType<typeof useComposerDraft>;
  root: ReturnType<typeof createRoot>;
}> {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  let latestDraft: ReturnType<typeof useComposerDraft> | null = null;

  await act(async () => {
    root.render(
      React.createElement(HookProbe, {
        onLoaded: (draft) => {
          latestDraft = draft;
        },
      })
    );
    await Promise.resolve();
    await Promise.resolve();
  });

  if (!latestDraft) {
    throw new Error('useComposerDraft did not load');
  }

  return {
    getDraft: () => {
      if (!latestDraft) throw new Error('useComposerDraft did not load');
      return latestDraft;
    },
    root,
  };
}

describe('useComposerDraft pending send lifecycle', () => {
  beforeEach(() => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    deleteSnapshotIfMatchesMock.mockClear();
    deleteSnapshotMock.mockReset();
    emptySnapshotMock.mockClear();
    loadSnapshotMock.mockReset();
    migrateLegacyMock.mockReset();
    saveSnapshotMock.mockReset();
    loadSnapshotMock.mockResolvedValue(null);
    migrateLegacyMock.mockResolvedValue(null);
    saveSnapshotMock.mockResolvedValue(undefined);
    deleteSnapshotMock.mockResolvedValue(undefined);
  });

  afterEach(() => {
    document.body.innerHTML = '';
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('hides submitted content immediately and can restore it on failed delivery', async () => {
    const { getDraft, root } = await renderLoadedHook();

    act(() => {
      getDraft().setText('hello teammate');
    });
    expect(getDraft().text).toBe('hello teammate');

    act(() => {
      getDraft().hideDraftForPendingSend({
        text: 'hello teammate',
        chips: [],
        attachments: [],
        actionMode: 'do',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(getDraft().text).toBe('');
    expect(saveSnapshotMock).toHaveBeenCalledWith(
      'team-alpha',
      expect.objectContaining({ text: 'hello teammate' })
    );
    expect(deleteSnapshotMock).not.toHaveBeenCalled();

    act(() => {
      getDraft().restoreDraft({
        text: 'hello teammate',
        chips: [],
        attachments: [],
        actionMode: 'do',
      });
    });

    expect(getDraft().text).toBe('hello teammate');

    act(() => {
      root.unmount();
    });
  });

  it('waits for pending snapshot persistence before deleting on successful delivery', async () => {
    let resolveSave!: () => void;
    saveSnapshotMock.mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          resolveSave = resolve;
        })
    );
    const { getDraft, root } = await renderLoadedHook();

    act(() => {
      getDraft().hideDraftForPendingSend({
        text: 'fast success',
        chips: [],
        attachments: [],
        actionMode: 'do',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      getDraft().finalizePendingSendClear();
    });

    expect(deleteSnapshotMock).not.toHaveBeenCalled();

    resolveSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSnapshotMock).toHaveBeenCalledWith('team-alpha');

    act(() => {
      root.unmount();
    });
  });

  it('persists a new draft after the submitted draft is hidden and then completes', async () => {
    let resolveFirstSave!: () => void;
    saveSnapshotMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const { getDraft, root } = await renderLoadedHook();

    act(() => {
      getDraft().hideDraftForPendingSend({
        text: 'submitted text',
        chips: [],
        attachments: [],
        actionMode: 'do',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });
    act(() => {
      getDraft().setText('next draft');
    });
    act(() => {
      getDraft().finalizePendingSendClear();
    });

    expect(saveSnapshotMock).toHaveBeenCalledTimes(1);

    resolveFirstSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveSnapshotMock).toHaveBeenCalledTimes(2);
    expect(saveSnapshotMock).toHaveBeenNthCalledWith(
      2,
      'team-alpha',
      expect.objectContaining({ text: 'next draft' })
    );
    expect(deleteSnapshotMock).not.toHaveBeenCalled();
    expect(getDraft().text).toBe('next draft');

    act(() => {
      root.unmount();
    });
  });

  it('deletes a completed snapshot for another team without interrupting the current draft', async () => {
    vi.useFakeTimers();
    const { getDraft, root } = await renderLoadedHook();
    loadSnapshotMock.mockResolvedValueOnce({
      version: 1,
      teamName: 'team-beta',
      text: 'submitted elsewhere',
      chips: [],
      attachments: [],
      actionMode: 'do',
      pendingSendId: 'pending-beta',
      updatedAt: Date.now(),
    });

    act(() => {
      getDraft().setText('current draft');
    });
    act(() => {
      getDraft().finalizePendingSendClear('team-beta', {
        text: 'submitted elsewhere',
        chips: [],
        attachments: [],
        actionMode: 'do',
        pendingSendId: 'pending-beta',
      });
    });
    await act(async () => {
      await Promise.resolve();
    });

    expect(deleteSnapshotMock).toHaveBeenCalledWith('team-beta');
    expect(getDraft().text).toBe('current draft');

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveSnapshotMock).toHaveBeenCalledWith(
      'team-alpha',
      expect.objectContaining({ text: 'current draft' })
    );

    act(() => {
      root.unmount();
    });
  });

  it('does not delete another team draft when storage no longer matches the submitted snapshot', async () => {
    const { getDraft, root } = await renderLoadedHook();
    loadSnapshotMock.mockResolvedValueOnce({
      version: 1,
      teamName: 'team-beta',
      text: 'newer draft',
      chips: [],
      attachments: [],
      actionMode: 'do',
      updatedAt: Date.now(),
    });

    act(() => {
      getDraft().finalizePendingSendClear('team-beta', {
        text: 'submitted elsewhere',
        chips: [],
        attachments: [],
        actionMode: 'do',
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSnapshotMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('does not delete an identical newer draft when its pending send marker differs', async () => {
    const { getDraft, root } = await renderLoadedHook();
    loadSnapshotMock.mockResolvedValueOnce({
      version: 1,
      teamName: 'team-beta',
      text: 'same text',
      chips: [],
      attachments: [],
      actionMode: 'do',
      pendingSendId: 'newer-send',
      updatedAt: Date.now(),
    });

    act(() => {
      getDraft().finalizePendingSendClear('team-beta', {
        text: 'same text',
        chips: [],
        attachments: [],
        actionMode: 'do',
        pendingSendId: 'older-send',
      });
    });
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(deleteSnapshotMock).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
  });

  it('does not mark a changed draft saved when an older debounced save resolves late', async () => {
    vi.useFakeTimers();
    let resolveFirstSave!: () => void;
    saveSnapshotMock
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSave = resolve;
          })
      )
      .mockResolvedValue(undefined);
    const { getDraft, root } = await renderLoadedHook();

    act(() => {
      getDraft().setText('first draft');
    });
    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
    });
    expect(saveSnapshotMock).toHaveBeenCalledTimes(1);

    act(() => {
      getDraft().setText('second draft');
    });
    expect(getDraft().isSaved).toBe(false);

    resolveFirstSave();
    await act(async () => {
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(getDraft().isSaved).toBe(false);

    await act(async () => {
      vi.advanceTimersByTime(400);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(saveSnapshotMock).toHaveBeenCalledTimes(2);
    expect(saveSnapshotMock).toHaveBeenNthCalledWith(
      2,
      'team-alpha',
      expect.objectContaining({ text: 'second draft' })
    );
    expect(getDraft().isSaved).toBe(true);

    act(() => {
      root.unmount();
    });
  });
});
