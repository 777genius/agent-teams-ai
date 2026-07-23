import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewBulkDecisionController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  BuildBulkRejectDiskSnapshot,
  ChangeReviewActionHistoryController,
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionController,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
  ChangeReviewBulkDecisionViewPort,
} from '@features/change-review/renderer';
import type { ApplyReviewResult, FileChangeSummary, ReviewUndoAction } from '@shared/types';

type ActionHistory = Pick<
  ChangeReviewActionHistoryController,
  | 'pushUndoAction'
  | 'bindCommittedAction'
  | 'discardLatestAction'
  | 'getLatestUndoAction'
  | 'publishUndoHistory'
>;

interface Harness {
  files: FileChangeSummary[];
  rejectableFiles: FileChangeSummary[];
  state: ChangeReviewBulkDecisionStateSnapshot;
  history: ActionHistory;
  statePort: ChangeReviewBulkDecisionStatePort;
  commandPort: ChangeReviewBulkDecisionCommandPort;
  viewPort: ChangeReviewBulkDecisionViewPort;
  buildRejectDiskSnapshot: BuildBulkRejectDiskSnapshot;
  current: boolean;
  durable: boolean;
  blocked: boolean;
  inFlight: boolean;
  latestAction: ReviewUndoAction | undefined;
}

let latest: ChangeReviewBulkDecisionController | null = null;

function makeFile(filePath: string, isNewFile = false): FileChangeSummary {
  return {
    filePath,
    relativePath: filePath.split('/').at(-1) ?? filePath,
    snippets: [],
    linesAdded: 1,
    linesRemoved: 0,
    isNewFile,
  };
}

function successfulApply(input: Partial<ApplyReviewResult> = {}): ApplyReviewResult {
  return { applied: 1, skipped: 0, conflicts: 0, errors: [], ...input };
}

function createHarness(): Harness {
  const files = [makeFile('/repo/a.ts'), makeFile('/repo/b.ts')];
  const state: ChangeReviewBulkDecisionStateSnapshot = {
    editedContents: {},
    hunkDecisions: { '/repo/a.ts:0': 'pending', '/repo/b.ts:0': 'pending' },
    fileDecisions: {},
    changeSetEpoch: 3,
  };
  const harness = {} as Harness;
  const history: ActionHistory = {
    pushUndoAction: vi.fn<ActionHistory['pushUndoAction']>((input) => {
      const action = {
        ...input,
        id: 'bulk-action',
        createdAt: '2026-07-23T00:00:00.000Z',
      } as ReviewUndoAction;
      harness.latestAction = action;
      return action;
    }),
    bindCommittedAction: vi.fn<ActionHistory['bindCommittedAction']>((optimistic, committed) => {
      if (!committed || harness.latestAction?.id !== optimistic.id) return false;
      harness.latestAction = structuredClone(committed);
      return true;
    }),
    discardLatestAction: vi.fn<ActionHistory['discardLatestAction']>((action) => {
      if (harness.latestAction?.id !== action.id) return false;
      harness.latestAction = undefined;
      return true;
    }),
    getLatestUndoAction: vi.fn<ActionHistory['getLatestUndoAction']>(() => harness.latestAction),
    publishUndoHistory: vi.fn<ActionHistory['publishUndoHistory']>(),
  };
  const statePort: ChangeReviewBulkDecisionStatePort = {
    getSnapshot: vi.fn<ChangeReviewBulkDecisionStatePort['getSnapshot']>(() => state),
    acceptAllFile: vi.fn<ChangeReviewBulkDecisionStatePort['acceptAllFile']>((filePath) => {
      state.fileDecisions[filePath] = 'accepted';
      return true;
    }),
    rejectAllFile: vi.fn<ChangeReviewBulkDecisionStatePort['rejectAllFile']>((filePath) => {
      state.fileDecisions[filePath] = 'rejected';
    }),
    restoreDecisionSnapshot: vi.fn<ChangeReviewBulkDecisionStatePort['restoreDecisionSnapshot']>(
      (snapshot) => {
        state.hunkDecisions = { ...snapshot.hunkDecisions };
        state.fileDecisions = { ...snapshot.fileDecisions };
      }
    ),
    invalidateResolvedFileContent:
      vi.fn<ChangeReviewBulkDecisionStatePort['invalidateResolvedFileContent']>(),
  };
  const commandPort: ChangeReviewBulkDecisionCommandPort = {
    applyReview: vi
      .fn<ChangeReviewBulkDecisionCommandPort['applyReview']>()
      .mockResolvedValue(successfulApply()),
    fetchFileContent: vi.fn<ChangeReviewBulkDecisionCommandPort['fetchFileContent']>(),
    readCurrentDiskContent: vi.fn<ChangeReviewBulkDecisionCommandPort['readCurrentDiskContent']>(
      (_filePath, fallback) => Promise.resolve(fallback)
    ),
  };
  const viewPort: ChangeReviewBulkDecisionViewPort = {
    scheduleEditorSync: vi.fn<ChangeReviewBulkDecisionViewPort['scheduleEditorSync']>((callback) =>
      callback()
    ),
    acceptAllEditorChunks: vi.fn<ChangeReviewBulkDecisionViewPort['acceptAllEditorChunks']>(),
    rejectAllEditorChunks: vi.fn<ChangeReviewBulkDecisionViewPort['rejectAllEditorChunks']>(),
    rollbackEditorContent: vi.fn<ChangeReviewBulkDecisionViewPort['rollbackEditorContent']>(),
    markExpectedWrite: vi.fn<ChangeReviewBulkDecisionViewPort['markExpectedWrite']>(),
    markCommittedPostimages: vi.fn<ChangeReviewBulkDecisionViewPort['markCommittedPostimages']>(),
    beginFileMutation: vi.fn<ChangeReviewBulkDecisionViewPort['beginFileMutation']>(),
    finishFileMutation: vi.fn<ChangeReviewBulkDecisionViewPort['finishFileMutation']>(),
    markFilesApplying: vi.fn<ChangeReviewBulkDecisionViewPort['markFilesApplying']>(),
    clearFilesApplying: vi.fn<ChangeReviewBulkDecisionViewPort['clearFilesApplying']>(),
    incrementDiscardCounter: vi.fn<ChangeReviewBulkDecisionViewPort['incrementDiscardCounter']>(),
    setUndoInFlight: vi.fn<ChangeReviewBulkDecisionViewPort['setUndoInFlight']>(),
  };
  Object.assign(harness, {
    files,
    rejectableFiles: files,
    state,
    history,
    statePort,
    commandPort,
    viewPort,
    buildRejectDiskSnapshot: vi.fn<BuildBulkRejectDiskSnapshot>((file) => ({
      filePath: file.filePath,
      beforeContent: `before:${file.filePath}`,
      afterContent: `after:${file.filePath}`,
      file,
    })),
    current: true,
    durable: true,
    blocked: false,
    inFlight: false,
    latestAction: undefined,
  });
  return harness;
}

function Probe({ harness }: { readonly harness: Harness }): React.JSX.Element {
  latest = useChangeReviewBulkDecisionController({
    active: true,
    files: harness.files,
    rejectableFiles: harness.rejectableFiles,
    canAcceptAll: true,
    changeSetEpoch: 3,
    instantApply: true,
    teamName: 'team',
    taskId: 'task',
    memberName: undefined,
    history: harness.history,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    viewPort: harness.viewPort,
    buildRejectDiskSnapshot: harness.buildRejectDiskSnapshot,
    persistLatestAcceptedAction: vi.fn(() => Promise.resolve(true)),
    ensureDurableScope: () => harness.durable,
    hasActionInFlight: () => harness.inFlight,
    blockForExternalChange: () => harness.blocked,
    captureOperationScope: () => createReviewOperationScopeToken('scope'),
    isCurrentOperationScope: () => harness.current,
  });
  return <div />;
}

function renderHarness(harness: Harness): ReturnType<typeof createRoot> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  act(() => root.render(<Probe harness={harness} />));
  return root;
}

function waitForRejectAllToSettle(harness: Harness): Promise<void> {
  return vi.waitFor(() => {
    expect(harness.commandPort.applyReview).toHaveBeenCalledTimes(1);
    expect(harness.viewPort.clearFilesApplying).toHaveBeenLastCalledWith(
      new Set(harness.rejectableFiles.map((file) => file.filePath))
    );
  });
}

describe('useChangeReviewBulkDecisionController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('accepts only files without drafts and records the exact pre-action decision snapshot', () => {
    const harness = createHarness();
    harness.state.editedContents['/repo/b.ts'] = 'draft';
    renderHarness(harness);

    act(() => latest!.acceptAll());

    expect(harness.statePort.acceptAllFile).toHaveBeenCalledWith('/repo/a.ts');
    expect(harness.statePort.acceptAllFile).not.toHaveBeenCalledWith('/repo/b.ts');
    const input = vi.mocked(harness.history.pushUndoAction).mock.calls[0][0];
    expect(input).toMatchObject({
      kind: 'bulk',
      descriptor: { intent: 'accept-all', fileCount: 1 },
      decisionSnapshot: {
        hunkDecisions: { '/repo/a.ts:0': 'pending', '/repo/b.ts:0': 'pending' },
        fileDecisions: {},
      },
    });
    expect(harness.viewPort.acceptAllEditorChunks).toHaveBeenCalledWith(new Set(['/repo/a.ts']));
    expect(harness.commandPort.applyReview).not.toHaveBeenCalled();
  });

  it('keeps successful bulk rejects while rolling back and refreshing failed files', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockImplementation(() => {
      const committed = structuredClone(harness.latestAction!);
      return Promise.resolve(
        successfulApply({
          errors: [{ filePath: '/repo/b.ts', error: 'conflict' }],
          committedReviewAction: committed,
          diskPostimages: [{ filePath: '/repo/a.ts', content: 'after:/repo/a.ts' }],
        })
      );
    });
    renderHarness(harness);

    act(() => latest!.rejectAll());
    await waitForRejectAllToSettle(harness);

    expect(harness.state.fileDecisions).toEqual({ '/repo/a.ts': 'rejected' });
    expect(harness.viewPort.rollbackEditorContent).toHaveBeenCalledWith(
      '/repo/b.ts',
      'before:/repo/b.ts'
    );
    expect(harness.statePort.invalidateResolvedFileContent).toHaveBeenCalledWith('/repo/b.ts');
    expect(harness.commandPort.fetchFileContent).toHaveBeenCalledWith(
      'team',
      undefined,
      '/repo/b.ts'
    );
    expect(harness.viewPort.incrementDiscardCounter).toHaveBeenCalledWith('/repo/b.ts');
    expect(harness.latestAction).toMatchObject({
      kind: 'bulk',
      descriptor: { intent: 'reject-all', fileCount: 1 },
    });
    expect(harness.history.publishUndoHistory).toHaveBeenCalledTimes(1);
  });

  it('rolls back optimistic state without touching disk when durable scope is unavailable', async () => {
    const harness = createHarness();
    harness.durable = false;
    renderHarness(harness);

    act(() => latest!.rejectAll());
    await vi.waitFor(() => expect(harness.history.discardLatestAction).toHaveBeenCalledTimes(1));

    expect(harness.commandPort.applyReview).not.toHaveBeenCalled();
    expect(harness.state.fileDecisions).toEqual({});
    expect(harness.viewPort.rollbackEditorContent).toHaveBeenCalledTimes(2);
    expect(harness.latestAction).toBeUndefined();
  });

  it('discards a main-bound optimistic action by stable id when every file fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockImplementation(() => {
      const committed = structuredClone(harness.latestAction!);
      return Promise.resolve(
        successfulApply({
          applied: 0,
          errors: harness.files.map((file) => ({ filePath: file.filePath, error: 'conflict' })),
          committedReviewAction: committed,
        })
      );
    });
    renderHarness(harness);

    act(() => latest!.rejectAll());
    await waitForRejectAllToSettle(harness);

    expect(harness.history.bindCommittedAction).toHaveBeenCalledTimes(1);
    expect(harness.history.discardLatestAction).toHaveBeenCalledTimes(1);
    expect(harness.latestAction).toBeUndefined();
    expect(harness.history.publishUndoHistory).not.toHaveBeenCalled();
  });

  it('fences delayed editor synchronization after the review operation scope changes', () => {
    const harness = createHarness();
    let scheduled: (() => void) | undefined;
    vi.mocked(harness.viewPort.scheduleEditorSync).mockImplementation((callback) => {
      scheduled = callback;
    });
    renderHarness(harness);

    act(() => latest!.acceptAll());
    harness.current = false;
    if (scheduled) scheduled();

    expect(harness.viewPort.acceptAllEditorChunks).not.toHaveBeenCalled();
  });
});
