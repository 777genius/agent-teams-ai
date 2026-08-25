import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewFileDraftController,
} from '@features/change-review/renderer';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewFileDraftActionHistoryPort,
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftController,
  ChangeReviewFileDraftHistoryPort,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStateSnapshot,
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
} from '@features/change-review/renderer';
import type { ReviewDraftHistoryEntry } from '@features/change-review-history/contracts';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason: unknown) => void;
}

interface Harness {
  files: FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  state: ChangeReviewFileDraftStateSnapshot;
  baselines: Map<string, string | null>;
  entries: Record<string, ReviewDraftHistoryEntry>;
  undoHistory: ReviewUndoAction[];
  redoHistory: ReviewRedoAction[];
  actionHistory: ChangeReviewFileDraftActionHistoryPort;
  draftHistory: ChangeReviewFileDraftHistoryPort;
  statePort: ChangeReviewFileDraftStatePort;
  commandPort: ChangeReviewFileDraftCommandPort;
  statusPort: ChangeReviewFileDraftStatusPort;
  writeEvidencePort: ChangeReviewFileDraftWriteEvidencePort;
  current: boolean;
  inFlight: boolean;
}

let latest: ChangeReviewFileDraftController | null = null;

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function makeFile(filePath = '/repo/a.ts'): FileChangeSummary {
  return {
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile: false,
  };
}

function makeFileContent(file: FileChangeSummary): FileChangeWithContent {
  return {
    ...file,
    originalFullContent: 'original',
    modifiedFullContent: 'agent',
    contentSource: 'ledger-exact',
  };
}

function makeEntry(filePath: string, doc = 'draft'): ReviewDraftHistoryEntry {
  return {
    filePath,
    codec: 'codemirror-history-v1',
    revision: 1,
    generation: 'generation-1',
    diskBaseline: 'disk',
    editorState: { doc, history: { done: [], undone: [] } },
    updatedAt: '2026-07-24T00:00:00.000Z',
  };
}

function makeHunkAction(filePath: string, id: string): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-24T00:00:00.000Z',
    kind: 'hunk',
    descriptor: { intent: 'accept-hunk', filePath, hunkIndex: 0 },
    action: { filePath, originalIndex: 0 },
  };
}

function createHarness(): Harness {
  const file = makeFile();
  const state: ChangeReviewFileDraftStateSnapshot = {
    activeFiles: [file],
    editedContents: {},
    reviewExternalChangesByFile: {},
    hunkDecisions: { '/repo/a.ts:0': 'accepted' },
    fileDecisions: { '/repo/a.ts': 'accepted' },
    hunkContextHashesByFile: { '/repo/a.ts': { 0: 'hash' } },
    decisionRevision: 7,
    changeSetEpoch: 3,
  };
  const harness = {} as Harness;
  const baselines = new Map<string, string | null>();
  const entries: Record<string, ReviewDraftHistoryEntry> = {};
  const statePort: ChangeReviewFileDraftStatePort = {
    getSnapshot: vi.fn<ChangeReviewFileDraftStatePort['getSnapshot']>(() => state),
    readExternalChange: vi.fn<ChangeReviewFileDraftStatePort['readExternalChange']>(
      (filePath) => state.reviewExternalChangesByFile[filePath]
    ),
    updateEditedContent: vi.fn<ChangeReviewFileDraftStatePort['updateEditedContent']>(
      (filePath, content) => {
        state.editedContents[filePath] = content;
      }
    ),
    discardFileEdits: vi.fn<ChangeReviewFileDraftStatePort['discardFileEdits']>((filePath) => {
      delete state.editedContents[filePath];
    }),
    clearExternalChange: vi.fn<ChangeReviewFileDraftStatePort['clearExternalChange']>(
      (filePath, observedChange) => {
        if (state.reviewExternalChangesByFile[filePath] !== observedChange) return false;
        delete state.reviewExternalChangesByFile[filePath];
        return true;
      }
    ),
    reloadFileFromDisk: vi.fn<ChangeReviewFileDraftStatePort['reloadFileFromDisk']>((filePath) => {
      delete state.editedContents[filePath];
      delete state.reviewExternalChangesByFile[filePath];
    }),
    applyReloadedReviewState: vi.fn<ChangeReviewFileDraftStatePort['applyReloadedReviewState']>(
      (next) => {
        state.hunkDecisions = { ...next.hunkDecisions };
        state.fileDecisions = { ...next.fileDecisions };
        state.hunkContextHashesByFile = { ...(next.hunkContextHashesByFile ?? {}) };
      }
    ),
    reportError: vi.fn<ChangeReviewFileDraftStatePort['reportError']>(),
  };
  const commandPort: ChangeReviewFileDraftCommandPort = {
    saveEditedFile: vi
      .fn<ChangeReviewFileDraftCommandPort['saveEditedFile']>()
      .mockResolvedValue({ ok: true }),
    checkConflict: vi.fn<ChangeReviewFileDraftCommandPort['checkConflict']>().mockResolvedValue({
      hasConflict: false,
      conflictContent: null,
      currentContent: 'disk-current',
    }),
    commitExternalReload: vi
      .fn<ChangeReviewFileDraftCommandPort['commitExternalReload']>()
      .mockResolvedValue({
        decisionRevision: 8,
        diskPostimages: [],
      }),
    quiescePersistence: vi
      .fn<ChangeReviewFileDraftCommandPort['quiescePersistence']>()
      .mockResolvedValue(true),
    recordDecisionRevision: vi.fn<ChangeReviewFileDraftCommandPort['recordDecisionRevision']>(),
    fetchFileContent: vi.fn<ChangeReviewFileDraftCommandPort['fetchFileContent']>(),
  };
  const statusPort: ChangeReviewFileDraftStatusPort = {
    beginFileMutation: vi.fn<ChangeReviewFileDraftStatusPort['beginFileMutation']>(),
    finishFileMutation: vi.fn<ChangeReviewFileDraftStatusPort['finishFileMutation']>(),
    incrementDiscardCounter: vi.fn<ChangeReviewFileDraftStatusPort['incrementDiscardCounter']>(),
  };
  const writeEvidencePort: ChangeReviewFileDraftWriteEvidencePort = {
    markExpectedWrite: vi.fn<ChangeReviewFileDraftWriteEvidencePort['markExpectedWrite']>(),
  };
  const actionHistory: ChangeReviewFileDraftActionHistoryPort = {
    clearForFile: vi.fn<ChangeReviewFileDraftActionHistoryPort['clearForFile']>((filePath) => {
      harness.undoHistory = harness.undoHistory.filter((action) => {
        if (action.kind === 'bulk') return true;
        const actionPath =
          action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
        return normalizePathForComparison(actionPath) !== normalizePathForComparison(filePath);
      });
      harness.redoHistory = [];
    }),
    getUndoHistory: vi.fn<ChangeReviewFileDraftActionHistoryPort['getUndoHistory']>(
      () => harness.undoHistory
    ),
    getRedoHistory: vi.fn<ChangeReviewFileDraftActionHistoryPort['getRedoHistory']>(
      () => harness.redoHistory
    ),
    replaceHistories: vi.fn<ChangeReviewFileDraftActionHistoryPort['replaceHistories']>(
      (undoHistory, redoHistory) => {
        harness.undoHistory = undoHistory;
        harness.redoHistory = redoHistory;
      }
    ),
  };
  const draftHistory: ChangeReviewFileDraftHistoryPort = {
    getEntry: vi.fn<ChangeReviewFileDraftHistoryPort['getEntry']>(
      (filePath) => entries[normalizePathForComparison(filePath)]
    ),
    hasBaseline: vi.fn<ChangeReviewFileDraftHistoryPort['hasBaseline']>((filePath) =>
      baselines.has(normalizePathForComparison(filePath))
    ),
    getBaseline: vi.fn<ChangeReviewFileDraftHistoryPort['getBaseline']>((filePath) =>
      baselines.get(normalizePathForComparison(filePath))
    ),
    setBaseline: vi.fn<ChangeReviewFileDraftHistoryPort['setBaseline']>((filePath, baseline) => {
      baselines.set(normalizePathForComparison(filePath), baseline);
    }),
    deleteBaseline: vi.fn<ChangeReviewFileDraftHistoryPort['deleteBaseline']>((filePath) => {
      baselines.delete(normalizePathForComparison(filePath));
    }),
    unsuppressFile: vi.fn<ChangeReviewFileDraftHistoryPort['unsuppressFile']>(),
    publishCheckpoint: vi.fn<ChangeReviewFileDraftHistoryPort['publishCheckpoint']>(),
    flushWrites: vi.fn<ChangeReviewFileDraftHistoryPort['flushWrites']>().mockResolvedValue(true),
    clearFile: vi.fn<ChangeReviewFileDraftHistoryPort['clearFile']>().mockResolvedValue(undefined),
  };
  Object.assign(harness, {
    files: [file],
    fileContents: { [file.filePath]: makeFileContent(file) },
    state,
    baselines,
    entries,
    undoHistory: [],
    redoHistory: [],
    actionHistory,
    draftHistory,
    statePort,
    commandPort,
    statusPort,
    writeEvidencePort,
    current: true,
    inFlight: false,
  });
  return harness;
}

function Probe({ harness }: { readonly harness: Harness }): React.JSX.Element {
  latest = useChangeReviewFileDraftController({
    files: harness.files,
    fileContents: harness.fileContents,
    teamName: 'team',
    memberName: undefined,
    reviewScope: { teamName: 'team', taskId: 'task' },
    persistenceScope: { teamName: 'team', scopeKey: 'task-task', scopeToken: 'token' },
    actionHistory: harness.actionHistory,
    draftHistory: harness.draftHistory,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    statusPort: harness.statusPort,
    writeEvidencePort: harness.writeEvidencePort,
    hasActionInFlight: () => harness.inFlight,
    captureOperationScope: () => createReviewOperationScopeToken('scope'),
    isCurrentOperationScope: () => harness.current,
    resolveModifiedContent: (_file, content) => content?.modifiedFullContent ?? null,
    isFileMissingOnDisk: (content) => Boolean(content && content.modifiedFullContent == null),
    hasUnresolvedExternalChange: (filePath, changes) => {
      const normalized = normalizePathForComparison(filePath);
      return Object.keys(changes).some(
        (candidate) => normalizePathForComparison(candidate) === normalized
      );
    },
  });
  return <div />;
}

function renderHarness(harness: Harness): ReturnType<typeof createRoot> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root.render(<Probe harness={harness} />));
  return root;
}

describe('useChangeReviewFileDraftController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('captures the exact disk baseline and removes a draft that returns to it', () => {
    const harness = createHarness();
    renderHarness(harness);

    act(() => latest!.contentChanged('/repo/a.ts', 'manual', 'agent'));
    expect(harness.draftHistory.setBaseline).toHaveBeenCalledWith('/repo/a.ts', 'agent');
    expect(harness.state.editedContents).toEqual({ '/repo/a.ts': 'manual' });

    act(() => latest!.contentChanged('/repo/a.ts', 'agent'));
    expect(harness.statePort.discardFileEdits).toHaveBeenCalledWith('/repo/a.ts');
    expect(harness.state.editedContents).toEqual({});
  });

  it('saves against the captured baseline and durably checkpoints native Undo history', async () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    renderHarness(harness);

    await act(async () => latest!.saveFile('/repo/a.ts'));

    expect(harness.commandPort.saveEditedFile).toHaveBeenCalledWith(
      '/repo/a.ts',
      { teamName: 'team', taskId: 'task' },
      'agent'
    );
    expect(harness.draftHistory.publishCheckpoint).toHaveBeenCalledWith(
      '/repo/a.ts',
      expect.objectContaining({ doc: 'manual' }),
      'manual'
    );
    expect(harness.actionHistory.clearForFile).toHaveBeenCalledWith('/repo/a.ts');
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenCalledTimes(2);
  });

  it('ignores a late Save completion from a stale operation generation', async () => {
    const harness = createHarness();
    const save = deferred<{ ok: true }>();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    vi.mocked(harness.commandPort.saveEditedFile).mockReturnValue(save.promise);
    renderHarness(harness);

    let saving!: Promise<void>;
    act(() => {
      saving = latest!.saveFile('/repo/a.ts');
    });
    harness.current = false;
    save.resolve({ ok: true });
    await act(async () => saving);

    expect(harness.actionHistory.clearForFile).not.toHaveBeenCalled();
    expect(harness.draftHistory.publishCheckpoint).not.toHaveBeenCalled();
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenCalledOnce();
  });

  it('reports an explicit Save failure without committing draft history', async () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    vi.mocked(harness.commandPort.saveEditedFile).mockResolvedValue({
      ok: false,
      error: 'disk changed again',
    });
    renderHarness(harness);

    await act(async () => latest!.saveFile('/repo/a.ts'));

    expect(harness.statePort.reportError).toHaveBeenCalledWith('disk changed again');
    expect(harness.actionHistory.clearForFile).not.toHaveBeenCalled();
    expect(harness.draftHistory.publishCheckpoint).not.toHaveBeenCalled();
  });

  it('reports a rejected Save without committing draft history', async () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    vi.mocked(harness.commandPort.saveEditedFile).mockRejectedValue(
      new Error('save transport failed')
    );
    renderHarness(harness);

    await act(async () => latest!.saveFile('/repo/a.ts'));

    expect(harness.statePort.reportError).toHaveBeenCalledWith('save transport failed');
    expect(harness.actionHistory.clearForFile).not.toHaveBeenCalled();
    expect(harness.draftHistory.publishCheckpoint).not.toHaveBeenCalled();
  });

  it('reports a rejected Restore and keeps the draft retryable', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.saveEditedFile).mockRejectedValue(
      new Error('restore transport failed')
    );
    renderHarness(harness);

    act(() => latest!.restoreMissingFile('/repo/a.ts', 'manual'));
    await vi.waitFor(() =>
      expect(harness.statePort.reportError).toHaveBeenCalledWith('restore transport failed')
    );

    expect(harness.state.editedContents['/repo/a.ts']).toBe('manual');
    expect(harness.baselines.get('/repo/a.ts')).toBeNull();
    expect(harness.actionHistory.clearForFile).not.toHaveBeenCalled();
  });

  it('commits Reload before clearing recoverable draft history and retains unrelated actions', async () => {
    const harness = createHarness();
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };
    harness.undoHistory = [
      makeHunkAction('/repo/a.ts', 'a-action'),
      makeHunkAction('/repo/b.ts', 'b-action'),
    ];
    harness.baselines.set('/repo/a.ts', 'agent');
    renderHarness(harness);

    act(() => latest!.reloadFromDisk('/repo/a.ts'));
    await vi.waitFor(() =>
      expect(harness.commandPort.fetchFileContent).toHaveBeenCalledWith(
        'team',
        undefined,
        '/repo/a.ts'
      )
    );

    const reloadInput = vi.mocked(harness.commandPort.commitExternalReload).mock.calls[0]?.[0];
    expect(reloadInput?.filePath).toBe('/repo/a.ts');
    expect(reloadInput?.expectedDecisionRevision).toBe(7);
    expect(reloadInput?.persistedState.reviewActionHistory.map((action) => action.id)).toEqual([
      'b-action',
    ]);
    expect(reloadInput?.persistedState.reviewRedoHistory).toEqual([]);
    expect(harness.actionHistory.replaceHistories).toHaveBeenCalledWith(
      [expect.objectContaining({ id: 'b-action' })],
      []
    );
    expect(harness.commandPort.recordDecisionRevision).toHaveBeenCalledWith(
      { teamName: 'team', scopeKey: 'task-task', scopeToken: 'token' },
      8
    );
    expect(
      vi.mocked(harness.commandPort.commitExternalReload).mock.invocationCallOrder[0]
    ).toBeLessThan(vi.mocked(harness.draftHistory.clearFile).mock.invocationCallOrder[0]);
    expect(harness.statePort.reloadFileFromDisk).toHaveBeenCalledWith('/repo/a.ts');
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });

  it('does not let a stale Reload completion mutate the newly opened scope', async () => {
    const harness = createHarness();
    const commit = deferred<{ decisionRevision: number; diskPostimages: [] }>();
    vi.mocked(harness.commandPort.commitExternalReload).mockReturnValue(commit.promise);
    renderHarness(harness);

    act(() => latest!.reloadFromDisk('/repo/a.ts'));
    await vi.waitFor(() => expect(harness.commandPort.commitExternalReload).toHaveBeenCalledOnce());
    harness.current = false;
    commit.resolve({ decisionRevision: 8, diskPostimages: [] });
    await act(async () => commit.promise);

    expect(harness.actionHistory.replaceHistories).not.toHaveBeenCalled();
    expect(harness.draftHistory.clearFile).not.toHaveBeenCalled();
    expect(harness.statePort.reloadFileFromDisk).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).not.toHaveBeenCalled();
  });

  it('keeps the edited draft recoverable when Reload history cleanup rejects', async () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };
    vi.mocked(harness.draftHistory.clearFile).mockRejectedValue(new Error('reload cleanup failed'));
    renderHarness(harness);

    act(() => latest!.reloadFromDisk('/repo/a.ts'));
    await vi.waitFor(() =>
      expect(harness.statePort.reportError).toHaveBeenCalledWith('reload cleanup failed')
    );

    expect(harness.state.editedContents['/repo/a.ts']).toBe('manual');
    expect(harness.entries['/repo/a.ts']).toBeDefined();
    expect(harness.statePort.reloadFileFromDisk).not.toHaveBeenCalled();
    expect(harness.commandPort.fetchFileContent).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });

  it('rebases Keep draft onto a missing disk file and preserves its durable editor branch', async () => {
    const harness = createHarness();
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'unlink' };
    vi.mocked(harness.commandPort.checkConflict).mockResolvedValue({
      hasConflict: true,
      conflictContent: null,
      currentContent: '',
    });
    renderHarness(harness);

    act(() => latest!.keepDraft('/repo/a.ts'));
    await vi.waitFor(() =>
      expect(harness.statePort.clearExternalChange).toHaveBeenCalledWith(
        '/repo/a.ts',
        expect.objectContaining({ type: 'unlink' })
      )
    );

    expect(harness.baselines.get('/repo/a.ts')).toBeNull();
    expect(harness.draftHistory.publishCheckpoint).toHaveBeenCalledWith(
      '/repo/a.ts',
      expect.objectContaining({ doc: 'manual' }),
      null
    );
    expect(harness.statePort.reportError).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });

  it('rechecks Keep draft when a newer watcher event arrives during durable flush', async () => {
    const harness = createHarness();
    const firstFlush = deferred<boolean>();
    const firstEvent = { type: 'change' };
    const secondEvent = { type: 'change' };
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = firstEvent;
    vi.mocked(harness.commandPort.checkConflict)
      .mockResolvedValueOnce({
        hasConflict: true,
        conflictContent: 'disk-first',
        currentContent: 'disk-first',
      })
      .mockResolvedValueOnce({
        hasConflict: true,
        conflictContent: 'disk-second',
        currentContent: 'disk-second',
      });
    vi.mocked(harness.draftHistory.flushWrites)
      .mockReturnValueOnce(firstFlush.promise)
      .mockResolvedValue(true);
    renderHarness(harness);

    act(() => latest!.keepDraft('/repo/a.ts'));
    await vi.waitFor(() => expect(harness.draftHistory.flushWrites).toHaveBeenCalledOnce());
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = secondEvent;
    firstFlush.resolve(true);

    await vi.waitFor(() =>
      expect(harness.statePort.clearExternalChange).toHaveBeenLastCalledWith(
        '/repo/a.ts',
        secondEvent
      )
    );
    expect(harness.commandPort.checkConflict).toHaveBeenCalledTimes(2);
    expect(harness.draftHistory.flushWrites).toHaveBeenCalledTimes(2);
    expect(harness.baselines.get('/repo/a.ts')).toBe('disk-second');
    expect(harness.state.reviewExternalChangesByFile).toEqual({});
  });

  it('bounds Keep draft retries and leaves a noisy watcher event unresolved', async () => {
    const harness = createHarness();
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };
    vi.mocked(harness.commandPort.checkConflict).mockImplementation(() => {
      harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };
      return Promise.resolve({
        hasConflict: true,
        conflictContent: 'newer-disk',
        currentContent: 'newer-disk',
      });
    });
    renderHarness(harness);

    act(() => latest!.keepDraft('/repo/a.ts'));
    await vi.waitFor(() =>
      expect(harness.statePort.reportError).toHaveBeenCalledWith(
        'The file kept changing while the draft was rebased. Retry Keep my draft.'
      )
    );

    expect(harness.commandPort.checkConflict).toHaveBeenCalledTimes(3);
    expect(harness.statePort.clearExternalChange).not.toHaveBeenCalled();
    expect(harness.state.reviewExternalChangesByFile['/repo/a.ts']).toBeDefined();
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });

  it('does not clear an unrelated UI error after Keep draft succeeds', async () => {
    const harness = createHarness();
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.state.reviewExternalChangesByFile['/repo/a.ts'] = { type: 'change' };
    harness.statePort.reportError('unrelated background error');
    vi.mocked(harness.statePort.reportError).mockClear();
    renderHarness(harness);

    act(() => latest!.keepDraft('/repo/a.ts'));
    await vi.waitFor(() => expect(harness.statePort.clearExternalChange).toHaveBeenCalledOnce());

    expect(harness.statePort.reportError).not.toHaveBeenCalled();
  });

  it('retains edited content and reports a durable cleanup failure on Discard', async () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    harness.entries['/repo/a.ts'] = makeEntry('/repo/a.ts', 'manual');
    vi.mocked(harness.draftHistory.clearFile).mockRejectedValue(new Error('draft cleanup failed'));
    renderHarness(harness);

    act(() => latest!.discardFile('/repo/a.ts'));
    await vi.waitFor(() =>
      expect(harness.statePort.reportError).toHaveBeenCalledWith('draft cleanup failed')
    );

    expect(harness.state.editedContents['/repo/a.ts']).toBe('manual');
    expect(harness.entries['/repo/a.ts']).toBeDefined();
    expect(harness.draftHistory.deleteBaseline).not.toHaveBeenCalled();
    expect(harness.statePort.discardFileEdits).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });
});
