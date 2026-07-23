import React, { act, useCallback } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewDraftHistoryController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewDraftHistoryController,
  ChangeReviewDraftHistoryPort,
  ReviewOperationScopeToken,
} from '@features/change-review/renderer';
import type { ReviewDraftHistoryHydrationState } from '@features/change-review/renderer';
import type {
  ReviewDraftHistoryEntry,
  ReviewDraftHistorySnapshot,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';
import type { ReviewChangeSetLike } from '@renderer/utils/reviewDecisionScope';
import type { ReviewFileScope } from '@shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function editorState(doc: string): ReviewSerializedEditorState {
  return { doc, history: { done: [], undone: [] } };
}

function entry(
  filePath: string,
  doc: string,
  revision = 1,
  generation = `generation-${revision}`,
  diskBaseline = 'disk'
): ReviewDraftHistoryEntry {
  return {
    filePath,
    codec: 'codemirror-history-v1',
    revision,
    generation,
    diskBaseline,
    editorState: editorState(doc),
    updatedAt: '2026-07-23T00:00:00.000Z',
  };
}

const activeChangeSet: ReviewChangeSetLike = {
  teamName: 'team-a',
  taskId: 'task-a',
  files: [
    {
      filePath: '/Project/Case.ts',
      relativePath: 'Case.ts',
      snippets: [],
      linesAdded: 1,
      linesRemoved: 0,
      isNewFile: false,
    },
  ],
  totalLinesAdded: 1,
  totalLinesRemoved: 0,
  totalFiles: 1,
  confidence: 'high',
  computedAt: '2026-07-23T00:00:00.000Z',
};
const reviewScope: ReviewFileScope = { teamName: 'team-a', taskId: 'task-a' };

function createPortHarness() {
  const load = vi.fn<ChangeReviewDraftHistoryPort['load']>(() => Promise.resolve(null));
  const saveEntry = vi.fn<ChangeReviewDraftHistoryPort['saveEntry']>(({ entry: draftEntry }) =>
    Promise.resolve({
      ...draftEntry,
      generation: `generation-${draftEntry.revision}`,
      updatedAt: '2026-07-23T00:00:00.000Z',
    })
  );
  const clear = vi.fn<ChangeReviewDraftHistoryPort['clear']>(() => Promise.resolve());
  const checkConflict = vi.fn<ChangeReviewDraftHistoryPort['checkConflict']>(
    ({ expectedModified }) =>
      Promise.resolve({
        hasConflict: false,
        conflictContent: null,
        currentContent: expectedModified,
        originalContent: expectedModified,
      })
  );
  const replaceConflictCandidate = vi.fn<ChangeReviewDraftHistoryPort['replaceConflictCandidate']>(
    ({ replacementEntry }) =>
      Promise.resolve({
        id: 'promoted-candidate',
        capturedAt: '2026-07-23T00:00:00.000Z',
        origin: 'current-snapshot',
        recoverability: 'recoverable',
        filePath: replacementEntry.filePath,
        expectedRevision: replacementEntry.revision - 1,
        expectedGeneration: null,
        observedCurrentRevision: replacementEntry.revision,
        observedCurrentGeneration: null,
        entryRevision: replacementEntry.revision,
      })
  );
  const resolveConflictCandidate = vi.fn<ChangeReviewDraftHistoryPort['resolveConflictCandidate']>(
    () => Promise.resolve(null)
  );
  const port: ChangeReviewDraftHistoryPort = {
    load,
    saveEntry,
    clear,
    checkConflict,
    replaceConflictCandidate,
    resolveConflictCandidate,
  };
  return {
    port,
    load,
    saveEntry,
    clear,
    checkConflict,
    replaceConflictCandidate,
    resolveConflictCandidate,
  };
}

interface ProbeProps {
  hydrationKey: string;
  scopeToken: string;
  changeSetEpoch: number;
  expectedHydrationKey: () => string;
  operationScope: () => ReviewOperationScopeToken;
  port: ChangeReviewDraftHistoryPort;
  commitHydratedDrafts: (state: {
    scopeFilePaths: string[];
    recoveredDrafts: Record<string, string>;
    externalChanges: Record<string, { type: 'change' }>;
    errorMessage?: string;
  }) => void;
  setHydration: (state: ReviewDraftHistoryHydrationState) => void;
  reportError: (message: string | null) => void;
  refreshConflictCandidates: () => Promise<void>;
}

let latestController: ChangeReviewDraftHistoryController | null = null;

function DraftHistoryProbe(props: Readonly<ProbeProps>): React.JSX.Element {
  const isExpectedHydrationKey = useCallback(
    (key: string): boolean => key === props.expectedHydrationKey(),
    [props.expectedHydrationKey]
  );
  const captureOperationScope = useCallback(
    (): ReviewOperationScopeToken => props.operationScope(),
    [props.operationScope]
  );
  const isCurrentOperationScope = useCallback(
    (scope: ReviewOperationScopeToken | null): scope is ReviewOperationScopeToken =>
      scope === props.operationScope(),
    [props.operationScope]
  );
  latestController = useChangeReviewDraftHistoryController({
    open: true,
    changeSetEpoch: props.changeSetEpoch,
    scopeKey: 'task:task-a',
    teamName: 'team-a',
    activeChangeSet,
    decisionScopeKey: 'task-task-a',
    decisionScopeToken: props.scopeToken,
    decisionHydrationKey: props.hydrationKey,
    draftHistoryHydrationReady: true,
    reviewScope,
    draftHistoryConflictCandidates: [],
    setHydration: props.setHydration,
    isExpectedHydrationKey,
    refreshConflictCandidates: props.refreshConflictCandidates,
    captureOperationScope,
    isCurrentOperationScope,
    commitHydratedDrafts: props.commitHydratedDrafts,
    reportError: props.reportError,
    port: props.port,
  });
  return <div data-entry-count={Object.keys(latestController.entries).length} />;
}

function createHarness(port = createPortHarness().port) {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  const commitHydratedDrafts = vi.fn();
  const setHydration = vi.fn();
  const reportError = vi.fn();
  const refreshConflictCandidates = vi.fn(() => Promise.resolve());
  let expectedHydrationKey = 'scope-a';
  let operationScope = createReviewOperationScopeToken('scope-a');
  const getExpectedHydrationKey = (): string => expectedHydrationKey;
  const getOperationScope = (): ReviewOperationScopeToken => operationScope;

  const render = async (
    hydrationKey = expectedHydrationKey,
    scopeToken = `token-${hydrationKey}`,
    changeSetEpoch = 1
  ) => {
    await act(async () => {
      root.render(
        <DraftHistoryProbe
          hydrationKey={hydrationKey}
          scopeToken={scopeToken}
          changeSetEpoch={changeSetEpoch}
          expectedHydrationKey={getExpectedHydrationKey}
          operationScope={getOperationScope}
          port={port}
          commitHydratedDrafts={commitHydratedDrafts}
          setHydration={setHydration}
          reportError={reportError}
          refreshConflictCandidates={refreshConflictCandidates}
        />
      );
      await Promise.resolve();
    });
  };

  return {
    root,
    port,
    commitHydratedDrafts,
    setHydration,
    reportError,
    refreshConflictCandidates,
    render,
    setScope(key: string) {
      expectedHydrationKey = key;
      operationScope = createReviewOperationScopeToken(key);
    },
    currentOperationScope: getOperationScope,
  };
}

async function settle(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });
}

async function flushReact(action: () => void): Promise<void> {
  await act(async () => {
    action();
    await Promise.resolve();
  });
}

describe('useChangeReviewDraftHistoryController', () => {
  afterEach(() => {
    latestController = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('ignores stale A -> B -> A hydration and rejects case-only path aliases', async () => {
    const { port, load, checkConflict } = createPortHarness();
    const firstA = deferred<ReviewDraftHistorySnapshot | null>();
    const scopeB = deferred<ReviewDraftHistorySnapshot | null>();
    const reopenedA = deferred<ReviewDraftHistorySnapshot | null>();
    load.mockImplementation(({ scopeToken }) => {
      if (scopeToken === 'token-a-first') return firstA.promise;
      if (scopeToken === 'token-b') return scopeB.promise;
      return reopenedA.promise;
    });
    const harness = createHarness(port);

    await harness.render('scope-a', 'token-a-first');
    harness.setScope('scope-b');
    await harness.render('scope-b', 'token-b');
    harness.setScope('scope-a');
    await harness.render('scope-a', 'token-a-reopened');

    reopenedA.resolve({
      entries: {
        exact: entry('/Project/Case.ts', 'current draft'),
        alias: entry('/Project/case.ts', 'wrong-case draft'),
      },
    });
    await settle();

    expect(latestController!.getEntry('/Project/Case.ts')?.editorState.doc).toBe('current draft');
    expect(latestController!.getEntry('/Project/case.ts')).toBeUndefined();
    expect(checkConflict).toHaveBeenCalledOnce();
    expect(harness.commitHydratedDrafts).toHaveBeenCalledOnce();
    expect(harness.commitHydratedDrafts).toHaveBeenLastCalledWith(
      expect.objectContaining({ recoveredDrafts: { '/Project/Case.ts': 'current draft' } })
    );

    firstA.resolve({ entries: { stale: entry('/Project/Case.ts', 'stale draft') } });
    scopeB.resolve(null);
    await settle();

    expect(harness.commitHydratedDrafts).toHaveBeenCalledOnce();
    expect(latestController!.getEntry('/Project/Case.ts')?.editorState.doc).toBe('current draft');
    await flushReact(() => harness.root.unmount());
  });

  it('does not commit stale A hydration after a deferred per-file conflict check', async () => {
    const { port, load, checkConflict } = createPortHarness();
    const oldConflict =
      deferred<Awaited<ReturnType<ChangeReviewDraftHistoryPort['checkConflict']>>>();
    load.mockImplementation(({ scopeToken }) =>
      Promise.resolve(
        scopeToken === 'token-a-first'
          ? { entries: { stale: entry('/Project/Case.ts', 'stale draft') } }
          : null
      )
    );
    checkConflict.mockReturnValueOnce(oldConflict.promise);
    const harness = createHarness(port);

    await harness.render('scope-a', 'token-a-first');
    await settle();
    expect(checkConflict).toHaveBeenCalledOnce();
    harness.setScope('scope-b');
    await harness.render('scope-b', 'token-b');
    harness.setScope('scope-a');
    await harness.render('scope-a', 'token-a-reopened');
    await settle();
    const commitsBeforeOldConflict = harness.commitHydratedDrafts.mock.calls.length;

    oldConflict.resolve({
      hasConflict: false,
      conflictContent: null,
      currentContent: 'disk',
      originalContent: 'disk',
    });
    await settle();

    expect(harness.commitHydratedDrafts).toHaveBeenCalledTimes(commitsBeforeOldConflict);
    expect(latestController!.getEntry('/Project/Case.ts')).toBeUndefined();
    await flushReact(() => harness.root.unmount());
  });

  it('retries a failed predecessor before its coalesced descendant', async () => {
    const { port, saveEntry } = createPortHarness();
    saveEntry
      .mockRejectedValueOnce(new Error('reply lost after commit'))
      .mockImplementation(({ entry: draftEntry }) =>
        Promise.resolve({
          ...draftEntry,
          generation: `generation-${draftEntry.revision}`,
          updatedAt: '2026-07-23T00:00:00.000Z',
        })
      );
    const harness = createHarness(port);
    await harness.render();
    await settle();

    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-1'), 'disk')
    );
    await settle();
    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-2'), 'disk')
    );
    let flushed = false;
    await act(async () => {
      flushed = await latestController!.flushWrites();
    });

    expect(flushed).toBe(true);
    expect(saveEntry).toHaveBeenCalledTimes(3);
    expect(saveEntry.mock.calls.map(([call]) => call.entry.editorState.doc)).toEqual([
      'draft-1',
      'draft-1',
      'draft-2',
    ]);
    expect(saveEntry.mock.calls[1]?.[0].expectedVersion).toEqual({
      revision: 0,
      generation: null,
    });
    expect(saveEntry.mock.calls[2]?.[0].expectedVersion).toEqual({
      revision: 1,
      generation: 'generation-1',
    });
    expect(latestController!.getEntry('/Project/Case.ts')?.editorState.doc).toBe('draft-2');
    await flushReact(() => harness.root.unmount());
  });

  it('keeps an in-flight write bound to its captured scope and isolates the new scope flush', async () => {
    const { port, saveEntry } = createPortHarness();
    const firstSave = deferred<ReviewDraftHistoryEntry>();
    saveEntry.mockReturnValueOnce(firstSave.promise);
    const harness = createHarness(port);
    await harness.render('scope-a', 'token-a');
    await settle();

    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('scope-a draft'), 'disk')
    );
    expect(saveEntry).toHaveBeenCalledOnce();
    harness.setScope('scope-b');
    await harness.render('scope-b', 'token-b');
    await settle();

    let flushed = false;
    await act(async () => {
      flushed = await latestController!.flushWrites();
    });
    expect(flushed).toBe(true);
    expect(saveEntry.mock.calls[0]?.[0].scope).toEqual({
      teamName: 'team-a',
      scopeKey: 'task-task-a',
      scopeToken: 'token-a',
    });

    firstSave.resolve(entry('/Project/Case.ts', 'scope-a draft'));
    await settle();
    expect(latestController!.getEntry('/Project/Case.ts')).toBeUndefined();
    await flushReact(() => harness.root.unmount());
  });

  it('serializes clear after the active write and restarts a newer pending checkpoint', async () => {
    const { port, saveEntry, clear: clearHistory } = createPortHarness();
    const firstSave = deferred<ReviewDraftHistoryEntry>();
    const clear = deferred<void>();
    saveEntry
      .mockReturnValueOnce(firstSave.promise)
      .mockImplementationOnce(({ entry: draftEntry }) =>
        Promise.resolve({
          ...draftEntry,
          generation: 'generation-after-clear',
          updatedAt: '2026-07-23T00:00:00.000Z',
        })
      );
    clearHistory.mockReturnValueOnce(clear.promise);
    const harness = createHarness(port);
    await harness.render();
    await settle();

    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-1'), 'disk')
    );
    let clearPromise!: Promise<void>;
    act(() => {
      clearPromise = latestController!.clearFile('/Project/Case.ts');
    });
    expect(clearHistory).not.toHaveBeenCalled();

    firstSave.resolve(entry('/Project/Case.ts', 'draft-1'));
    await settle();
    expect(clearHistory).toHaveBeenCalledWith({
      scope: { teamName: 'team-a', scopeKey: 'task-task-a', scopeToken: 'token-scope-a' },
      filePath: '/Project/Case.ts',
      expectedVersion: { revision: 1, generation: 'generation-1' },
    });
    expect(saveEntry).toHaveBeenCalledOnce();

    act(() => {
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-2'), 'disk');
    });
    expect(saveEntry).toHaveBeenCalledOnce();

    clear.resolve();
    await act(async () => {
      await clearPromise;
    });
    await act(async () => {
      expect(await latestController!.flushWrites()).toBe(true);
    });

    expect(saveEntry).toHaveBeenCalledTimes(2);
    expect(saveEntry.mock.calls[1]?.[0]).toMatchObject({
      entry: { revision: 2, editorState: { doc: 'draft-2' } },
      expectedVersion: { revision: 0, generation: null },
    });
    await flushReact(() => harness.root.unmount());
  });

  it('does not restart a deferred clear after the operation scope changes', async () => {
    const { port, saveEntry, clear: clearHistory } = createPortHarness();
    const clear = deferred<void>();
    clearHistory.mockReturnValueOnce(clear.promise);
    const harness = createHarness(port);
    await harness.render();
    await settle();

    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-1'), 'disk')
    );
    await act(async () => {
      expect(await latestController!.flushWrites()).toBe(true);
    });
    let clearPromise!: Promise<void>;
    act(() => {
      clearPromise = latestController!.clearFile('/Project/Case.ts');
    });
    await settle();
    expect(clearHistory).toHaveBeenCalledOnce();
    act(() =>
      latestController!.publishCheckpoint('/Project/Case.ts', editorState('draft-2'), 'disk')
    );

    harness.setScope('scope-b');
    await harness.render('scope-b', 'token-b');
    clear.resolve();
    await act(async () => {
      await clearPromise;
    });
    await settle();

    expect(saveEntry).toHaveBeenCalledOnce();
    expect(latestController!.getEntry('/Project/Case.ts')).toBeUndefined();
    expect(harness.reportError).not.toHaveBeenCalled();
    await flushReact(() => harness.root.unmount());
  });
});
