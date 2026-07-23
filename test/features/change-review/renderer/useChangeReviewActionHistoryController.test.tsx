import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  useChangeReviewActionHistoryController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewActionHistoryController,
  ChangeReviewActionHistoryStorePort,
} from '@features/change-review/renderer';
import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';

interface ProbeProps {
  resetKey: string;
  hydrationKey: string | null;
  hydrationScopeKey: string | null;
  hydrationStatus: 'idle' | 'loading' | 'loaded' | 'error';
  undo: ReviewUndoAction[];
  redo: ReviewRedoAction[];
  store: ChangeReviewActionHistoryStorePort;
}

let latest: ChangeReviewActionHistoryController | null = null;

function Probe(props: ProbeProps): React.JSX.Element {
  latest = useChangeReviewActionHistoryController({
    resetKey: props.resetKey,
    hydrationKey: props.hydrationKey,
    hydrationScopeKey: props.hydrationScopeKey,
    hydrationStatus: props.hydrationStatus,
    hydratedUndoHistory: props.undo,
    hydratedRedoHistory: props.redo,
    store: props.store,
  });
  return <div />;
}

function hunkAction(id: string, filePath = '/repo/file.ts'): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-23T00:00:00.000Z',
    kind: 'hunk',
    action: { filePath, originalIndex: 0 },
  };
}

function bulkAction(id: string): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-23T00:00:00.000Z',
    kind: 'bulk',
    decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
    diskSnapshots: [],
  };
}

function redoAction(action: ReviewUndoAction): ReviewRedoAction {
  return {
    action,
    decisionSnapshot: { hunkDecisions: {}, fileDecisions: {} },
  };
}

function createStore(): ChangeReviewActionHistoryStorePort & {
  undo: ReviewUndoAction[];
  redo: ReviewRedoAction[];
  legacyClears: number;
} {
  return {
    undo: [],
    redo: [],
    legacyClears: 0,
    publishUndoHistory(history) {
      this.undo = history;
    },
    publishRedoHistory(history) {
      this.redo = history;
    },
    clearLegacyUndoStack() {
      this.legacyClears += 1;
    },
  };
}

describe('useChangeReviewActionHistoryController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('hydrates only the matching loaded scope across A -> B -> A', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const store = createStore();
    const render = async (props: Omit<ProbeProps, 'store'>) => {
      await act(async () => root.render(<Probe {...props} store={store} />));
    };
    const firstA = hunkAction('first-a');
    const reopenedA = hunkAction('reopened-a');

    await render({
      resetKey: 'a:1',
      hydrationKey: 'a',
      hydrationScopeKey: 'a',
      hydrationStatus: 'loaded',
      undo: [firstA],
      redo: [],
    });
    expect(latest!.getUndoHistory()).toEqual([firstA]);

    await render({
      resetKey: 'b:1',
      hydrationKey: 'b',
      hydrationScopeKey: 'a',
      hydrationStatus: 'loaded',
      undo: [firstA],
      redo: [],
    });
    expect(latest!.getUndoHistory()).toEqual([]);

    await render({
      resetKey: 'a:2',
      hydrationKey: 'a',
      hydrationScopeKey: 'a',
      hydrationStatus: 'loaded',
      undo: [reopenedA],
      redo: [],
    });
    expect(latest!.getUndoHistory()).toEqual([reopenedA]);
    await act(async () => root.unmount());
  });

  it('restores redo only when the exact optimistic top action is discarded', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const store = createStore();
    const previousRedo = redoAction(hunkAction('redo-old'));
    await act(async () => {
      root.render(
        <Probe
          resetKey="a"
          hydrationKey="a"
          hydrationScopeKey="a"
          hydrationStatus="loaded"
          undo={[]}
          redo={[previousRedo]}
          store={store}
        />
      );
    });

    let optimistic!: ReviewUndoAction;
    await act(async () => {
      optimistic = latest!.pushUndoAction({
        kind: 'hunk',
        action: { filePath: '/repo/file.ts', originalIndex: 1 },
      });
    });
    expect(store.redo).toEqual([]);
    await act(async () => {
      root.render(
        <Probe
          resetKey="a"
          hydrationKey="a"
          hydrationScopeKey="a"
          hydrationStatus="loaded"
          undo={store.undo}
          redo={store.redo}
          store={store}
        />
      );
    });
    const cloned = { ...optimistic };
    let discardedClone = true;
    await act(async () => {
      discardedClone = latest!.discardLatestAction(cloned);
    });
    expect(discardedClone).toBe(false);
    expect(store.redo).toEqual([]);
    let discardedOptimistic = false;
    await act(async () => {
      discardedOptimistic = latest!.discardLatestAction(optimistic);
    });
    expect(discardedOptimistic).toBe(true);
    expect(store.redo).toEqual([previousRedo]);
    await act(async () => root.unmount());
  });

  it('binds, completes and replaces histories without truncating strict LIFO order', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const store = createStore();
    const initial = Array.from({ length: 24 }, (_, index) => hunkAction(`a-${index}`));
    await act(async () => {
      root.render(
        <Probe
          resetKey="a"
          hydrationKey="a"
          hydrationScopeKey="a"
          hydrationStatus="loaded"
          undo={initial}
          redo={[]}
          store={store}
        />
      );
    });
    expect(latest!.undoDepth).toBe(24);
    let optimistic!: ReviewUndoAction;
    await act(async () => {
      optimistic = latest!.pushUndoAction({
        kind: 'hunk',
        action: { filePath: '/repo/new.ts', originalIndex: 0 },
      });
    });
    const committed = {
      ...optimistic,
      kind: 'hunk',
      action: { filePath: '/repo/new.ts', originalIndex: 7 },
    } as ReviewUndoAction;
    let bound = false;
    await act(async () => {
      bound = latest!.bindCommittedAction(optimistic, committed);
    });
    expect(bound).toBe(true);
    expect(latest!.getLatestUndoAction()).toBe(committed);
    let completed = false;
    await act(async () => {
      completed = latest!.completeUndoAction(committed, redoAction(committed));
    });
    expect(completed).toBe(true);
    expect(latest!.getUndoHistory()).toEqual(initial);
    expect(latest!.getLatestRedoAction()?.action).toBe(committed);

    const replacement = [hunkAction('replacement')];
    await act(async () => latest!.replaceHistories(replacement, []));
    expect(latest!.getUndoHistory()).toBe(replacement);
    expect(latest!.undoDepth).toBe(1);
    await act(async () => root.unmount());
  });

  it('clears normalized file history and clears every stack for bulk history', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));
    const store = createStore();
    const retained = hunkAction('keep', '/repo/other.ts');
    await act(async () => {
      root.render(
        <Probe
          resetKey="a"
          hydrationKey="a"
          hydrationScopeKey="a"
          hydrationStatus="loaded"
          undo={[hunkAction('drop', 'C:\\Repo\\File.ts'), retained]}
          redo={[redoAction(retained)]}
          store={store}
        />
      );
    });
    await act(async () => latest!.clearForFile('c:/repo/file.ts'));
    expect(store.undo).toEqual([retained]);
    expect(store.redo).toEqual([]);

    await act(async () => latest!.replaceHistories([bulkAction('bulk')], [redoAction(retained)]));
    await act(async () => latest!.clearForFile('/repo/other.ts'));
    expect(store.undo).toEqual([]);
    expect(store.redo).toEqual([]);
    expect(store.legacyClears).toBe(1);
    await act(async () => root.unmount());
  });
});
