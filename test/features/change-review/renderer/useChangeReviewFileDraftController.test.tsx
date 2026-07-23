import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewFileDraftController,
} from '@features/change-review/renderer';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewActionHistoryController,
  ChangeReviewDraftHistoryController,
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftController,
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

type ActionHistory = Pick<
  ChangeReviewActionHistoryController,
  'clearForFile' | 'getUndoHistory' | 'getRedoHistory' | 'replaceHistories'
>;
type DraftHistory = Pick<
  ChangeReviewDraftHistoryController,
  | 'getEntry'
  | 'hasBaseline'
  | 'getBaseline'
  | 'setBaseline'
  | 'deleteBaseline'
  | 'unsuppressFile'
  | 'publishCheckpoint'
  | 'flushWrites'
  | 'clearFile'
>;

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T) => void;
}

interface Harness {
  files: FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  state: ChangeReviewFileDraftStateSnapshot;
  baselines: Map<string, string | null>;
  entries: Record<string, ReviewDraftHistoryEntry>;
  undoHistory: ReviewUndoAction[];
  redoHistory: ReviewRedoAction[];
  actionHistory: ActionHistory;
  draftHistory: DraftHistory;
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
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
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
    applyError: null,
  };
  const harness = {} as Harness;
  const baselines = new Map<string, string | null>();
  const entries: Record<string, ReviewDraftHistoryEntry> = {};
  const statePort: ChangeReviewFileDraftStatePort = {
    getSnapshot: vi.fn<ChangeReviewFileDraftStatePort['getSnapshot']>(() => state),
    updateEditedContent: vi.fn<ChangeReviewFileDraftStatePort['updateEditedContent']>(
      (filePath, content) => {
        state.editedContents[filePath] = content;
      }
    ),
    discardFileEdits: vi.fn<ChangeReviewFileDraftStatePort['discardFileEdits']>((filePath) => {
      delete state.editedContents[filePath];
    }),
    clearExternalChange: vi.fn<ChangeReviewFileDraftStatePort['clearExternalChange']>(
      (filePath) => {
        delete state.reviewExternalChangesByFile[filePath];
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
        state.applyError = null;
      }
    ),
    reportError: vi.fn<ChangeReviewFileDraftStatePort['reportError']>((message) => {
      state.applyError = message;
    }),
  };
  const commandPort: ChangeReviewFileDraftCommandPort = {
    saveEditedFile: vi
      .fn<ChangeReviewFileDraftCommandPort['saveEditedFile']>()
      .mockResolvedValue(undefined),
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
  const actionHistory: ActionHistory = {
    clearForFile: vi.fn<ActionHistory['clearForFile']>((filePath) => {
      harness.undoHistory = harness.undoHistory.filter((action) => {
        if (action.kind === 'bulk') return true;
        const actionPath =
          action.kind === 'disk' ? action.action.snapshot.filePath : action.action.filePath;
        return normalizePathForComparison(actionPath) !== normalizePathForComparison(filePath);
      });
      harness.redoHistory = [];
    }),
    getUndoHistory: vi.fn<ActionHistory['getUndoHistory']>(() => harness.undoHistory),
    getRedoHistory: vi.fn<ActionHistory['getRedoHistory']>(() => harness.redoHistory),
    replaceHistories: vi.fn<ActionHistory['replaceHistories']>((undoHistory, redoHistory) => {
      harness.undoHistory = undoHistory;
      harness.redoHistory = redoHistory;
    }),
  };
  const draftHistory: DraftHistory = {
    getEntry: vi.fn<DraftHistory['getEntry']>(
      (filePath) => entries[normalizePathForComparison(filePath)]
    ),
    hasBaseline: vi.fn<DraftHistory['hasBaseline']>((filePath) =>
      baselines.has(normalizePathForComparison(filePath))
    ),
    getBaseline: vi.fn<DraftHistory['getBaseline']>((filePath) =>
      baselines.get(normalizePathForComparison(filePath))
    ),
    setBaseline: vi.fn<DraftHistory['setBaseline']>((filePath, baseline) => {
      baselines.set(normalizePathForComparison(filePath), baseline);
    }),
    deleteBaseline: vi.fn<DraftHistory['deleteBaseline']>((filePath) => {
      baselines.delete(normalizePathForComparison(filePath));
    }),
    unsuppressFile: vi.fn<DraftHistory['unsuppressFile']>(),
    publishCheckpoint: vi.fn<DraftHistory['publishCheckpoint']>(),
    flushWrites: vi.fn<DraftHistory['flushWrites']>().mockResolvedValue(true),
    clearFile: vi.fn<DraftHistory['clearFile']>().mockResolvedValue(undefined),
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
    const save = deferred<void>();
    harness.state.editedContents['/repo/a.ts'] = 'manual';
    harness.baselines.set('/repo/a.ts', 'agent');
    vi.mocked(harness.commandPort.saveEditedFile).mockReturnValue(save.promise);
    renderHarness(harness);

    let saving!: Promise<void>;
    act(() => {
      saving = latest!.saveFile('/repo/a.ts');
    });
    harness.current = false;
    save.resolve(undefined);
    await act(async () => saving);

    expect(harness.actionHistory.clearForFile).not.toHaveBeenCalled();
    expect(harness.draftHistory.publishCheckpoint).not.toHaveBeenCalled();
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenCalledOnce();
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
      expect(harness.statePort.clearExternalChange).toHaveBeenCalledWith('/repo/a.ts')
    );

    expect(harness.baselines.get('/repo/a.ts')).toBeNull();
    expect(harness.draftHistory.publishCheckpoint).toHaveBeenCalledWith(
      '/repo/a.ts',
      expect.objectContaining({ doc: 'manual' }),
      null
    );
    expect(harness.statePort.reportError).toHaveBeenLastCalledWith(null);
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledWith('/repo/a.ts');
  });
});
