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
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStateSnapshot,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
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
  editorPort: ChangeReviewBulkDecisionEditorPort;
  statusPort: ChangeReviewBulkDecisionStatusPort;
  writeEvidencePort: ChangeReviewBulkDecisionWriteEvidencePort;
  buildRejectDiskSnapshot: BuildBulkRejectDiskSnapshot;
  instantApply: boolean;
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

function makeRenameFile(filePath: string): FileChangeSummary {
  return {
    ...makeFile(filePath),
    snippets: [
      {
        toolUseId: 'rename',
        filePath,
        toolName: 'PostToolUse',
        type: 'hook-snapshot',
        oldString: '',
        newString: '',
        replaceAll: false,
        timestamp: '2026-07-23T00:00:00.000Z',
        isError: false,
        ledger: {
          eventId: 'rename-event',
          source: 'ledger-exact',
          confidence: 'exact',
          originalFullContent: 'before',
          modifiedFullContent: 'after',
          beforeHash: null,
          afterHash: null,
          relation: {
            kind: 'rename',
            oldPath: '/repo/original.ts',
            newPath: filePath,
          },
        },
      },
    ],
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
  const editorPort: ChangeReviewBulkDecisionEditorPort = {
    scheduleEditorSync: vi.fn<ChangeReviewBulkDecisionEditorPort['scheduleEditorSync']>(
      (callback) => callback()
    ),
    acceptAllEditorChunks: vi.fn<ChangeReviewBulkDecisionEditorPort['acceptAllEditorChunks']>(),
    rejectAllEditorChunks: vi.fn<ChangeReviewBulkDecisionEditorPort['rejectAllEditorChunks']>(),
    rollbackEditorContent: vi.fn<ChangeReviewBulkDecisionEditorPort['rollbackEditorContent']>(),
  };
  const activeMutations = new Set<string>();
  const statusPort: ChangeReviewBulkDecisionStatusPort = {
    beginFileMutation: vi.fn<ChangeReviewBulkDecisionStatusPort['beginFileMutation']>(
      (filePath) => {
        activeMutations.add(filePath);
        harness.inFlight = true;
      }
    ),
    finishFileMutation: vi.fn<ChangeReviewBulkDecisionStatusPort['finishFileMutation']>(
      (filePath) => {
        activeMutations.delete(filePath);
        harness.inFlight = activeMutations.size > 0;
      }
    ),
    markFilesApplying: vi.fn<ChangeReviewBulkDecisionStatusPort['markFilesApplying']>(),
    clearFilesApplying: vi.fn<ChangeReviewBulkDecisionStatusPort['clearFilesApplying']>(),
    incrementDiscardCounter: vi.fn<ChangeReviewBulkDecisionStatusPort['incrementDiscardCounter']>(),
    setUndoInFlight: vi.fn<ChangeReviewBulkDecisionStatusPort['setUndoInFlight']>(),
  };
  const writeEvidencePort: ChangeReviewBulkDecisionWriteEvidencePort = {
    markExpectedWrite: vi.fn<ChangeReviewBulkDecisionWriteEvidencePort['markExpectedWrite']>(),
    markCommittedPostimages:
      vi.fn<ChangeReviewBulkDecisionWriteEvidencePort['markCommittedPostimages']>(),
  };
  Object.assign(harness, {
    files,
    rejectableFiles: files,
    state,
    history,
    statePort,
    commandPort,
    editorPort,
    statusPort,
    writeEvidencePort,
    buildRejectDiskSnapshot: vi.fn<BuildBulkRejectDiskSnapshot>((file) => ({
      filePath: file.filePath,
      beforeContent: `before:${file.filePath}`,
      afterContent: `after:${file.filePath}`,
      file,
    })),
    instantApply: true,
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
    instantApply: harness.instantApply,
    teamName: 'team',
    taskId: 'task',
    memberName: undefined,
    history: harness.history,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    editorPort: harness.editorPort,
    statusPort: harness.statusPort,
    writeEvidencePort: harness.writeEvidencePort,
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
    expect(harness.statusPort.clearFilesApplying).toHaveBeenLastCalledWith(
      new Set(harness.rejectableFiles.map((file) => file.filePath))
    );
  });
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

async function expectUnknownApplyCleanup(harness: Harness): Promise<void> {
  await waitForRejectAllToSettle(harness);
  expect(harness.state.fileDecisions).toEqual({});
  expect(harness.editorPort.rollbackEditorContent).toHaveBeenCalledTimes(2);
  expect(harness.history.discardLatestAction).toHaveBeenCalledTimes(1);
  expect(harness.statusPort.finishFileMutation).toHaveBeenCalledTimes(2);
  expect(harness.statusPort.setUndoInFlight).toHaveBeenLastCalledWith(false);
  expect(harness.inFlight).toBe(false);
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
    expect(harness.editorPort.acceptAllEditorChunks).toHaveBeenCalledWith(new Set(['/repo/a.ts']));
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
    expect(harness.editorPort.rollbackEditorContent).toHaveBeenCalledWith(
      '/repo/b.ts',
      'before:/repo/b.ts'
    );
    expect(harness.statePort.invalidateResolvedFileContent).toHaveBeenCalledWith('/repo/b.ts');
    expect(harness.commandPort.fetchFileContent).toHaveBeenCalledWith(
      'team',
      undefined,
      '/repo/b.ts'
    );
    expect(harness.statusPort.incrementDiscardCounter).toHaveBeenCalledWith('/repo/b.ts');
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
    expect(harness.editorPort.rollbackEditorContent).toHaveBeenCalledTimes(2);
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
    vi.mocked(harness.editorPort.scheduleEditorSync).mockImplementation((callback) => {
      scheduled = callback;
    });
    renderHarness(harness);

    act(() => latest!.acceptAll());
    harness.current = false;
    if (scheduled) scheduled();

    expect(harness.editorPort.acceptAllEditorChunks).not.toHaveBeenCalled();
  });

  it.each(['scope', 'epoch'] as const)(
    'fences a stale %s apply completion without clearing replacement-generation state',
    async (staleBoundary) => {
      const harness = createHarness();
      const apply = deferred<ApplyReviewResult | null>();
      vi.mocked(harness.commandPort.applyReview).mockReturnValue(apply.promise);
      renderHarness(harness);

      act(() => latest!.rejectAll());
      await vi.waitFor(() => expect(harness.commandPort.applyReview).toHaveBeenCalledTimes(1));
      if (staleBoundary === 'scope') {
        harness.current = false;
      } else {
        harness.state.changeSetEpoch += 1;
      }
      await act(async () => {
        apply.resolve(successfulApply());
        await apply.promise;
      });

      expect(harness.writeEvidencePort.markCommittedPostimages).not.toHaveBeenCalled();
      expect(harness.history.bindCommittedAction).not.toHaveBeenCalled();
      expect(harness.history.publishUndoHistory).not.toHaveBeenCalled();
      expect(harness.statusPort.finishFileMutation).not.toHaveBeenCalled();
      expect(harness.statusPort.clearFilesApplying).not.toHaveBeenCalled();
    }
  );

  it('blocks a second Reject All while the first operation owns the file mutations', async () => {
    const harness = createHarness();
    const apply = deferred<ApplyReviewResult | null>();
    vi.mocked(harness.commandPort.applyReview).mockReturnValue(apply.promise);
    renderHarness(harness);

    act(() => {
      latest!.rejectAll();
      latest!.rejectAll();
    });

    expect(harness.history.pushUndoAction).toHaveBeenCalledTimes(1);
    expect(harness.commandPort.applyReview).toHaveBeenCalledTimes(1);
    expect(harness.statusPort.beginFileMutation).toHaveBeenCalledTimes(2);
    await act(async () => {
      apply.resolve(successfulApply());
      await apply.promise;
    });
    await waitForRejectAllToSettle(harness);
  });

  it('fails closed and cleans up when apply returns null', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockResolvedValue(null);
    renderHarness(harness);

    act(() => latest!.rejectAll());

    await expectUnknownApplyCleanup(harness);
  });

  it('fails closed and cleans up when apply reports an unknown file', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockResolvedValue(
      successfulApply({
        applied: 0,
        errors: [{ filePath: '/repo/not-requested.ts', error: 'unknown path' }],
      })
    );
    renderHarness(harness);

    act(() => latest!.rejectAll());

    await expectUnknownApplyCleanup(harness);
  });

  it('fails closed and cleans up when apply throws', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applyReview).mockRejectedValue(new Error('transport failed'));
    renderHarness(harness);

    act(() => latest!.rejectAll());

    await expectUnknownApplyCleanup(harness);
  });

  it('keeps pending decisions but releases transient status when instant apply is disabled', () => {
    const harness = createHarness();
    harness.instantApply = false;
    renderHarness(harness);

    act(() => latest!.rejectAll());

    expect(harness.commandPort.applyReview).not.toHaveBeenCalled();
    expect(harness.state.fileDecisions).toEqual({
      '/repo/a.ts': 'rejected',
      '/repo/b.ts': 'rejected',
    });
    expect(harness.editorPort.rejectAllEditorChunks).toHaveBeenCalledTimes(1);
    expect(harness.history.discardLatestAction).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).toHaveBeenCalledTimes(2);
    expect(harness.statusPort.clearFilesApplying).toHaveBeenCalledTimes(1);
    expect(harness.inFlight).toBe(false);
  });

  it('preserves rename, new-file, and deleted-file disk snapshot semantics', async () => {
    const harness = createHarness();
    const renamed = makeRenameFile('/repo/renamed.ts');
    const created = makeFile('/repo/created.ts', true);
    const deleted = makeFile('/repo/deleted.ts');
    harness.files = [renamed, created, deleted];
    harness.rejectableFiles = harness.files;
    harness.state.hunkDecisions = {};
    harness.buildRejectDiskSnapshot = vi.fn<BuildBulkRejectDiskSnapshot>((file) => {
      let restoreMode: 'create-file' | 'delete-file' | undefined;
      if (file === created) {
        restoreMode = 'create-file';
      } else if (file === deleted) {
        restoreMode = 'delete-file';
      }
      return {
        filePath: file.filePath,
        beforeContent: `before:${file.filePath}`,
        afterContent: file === created ? null : `after:${file.filePath}`,
        file,
        restoreMode,
      };
    });
    vi.mocked(harness.commandPort.applyReview).mockResolvedValue(successfulApply({ applied: 3 }));
    renderHarness(harness);

    act(() => latest!.rejectAll());
    await waitForRejectAllToSettle(harness);

    expect(harness.commandPort.readCurrentDiskContent).not.toHaveBeenCalled();
    expect(harness.latestAction).toMatchObject({
      kind: 'bulk',
      diskSnapshots: [
        { filePath: renamed.filePath, restoreMode: undefined },
        { filePath: created.filePath, restoreMode: 'create-file', afterContent: null },
        { filePath: deleted.filePath, restoreMode: 'delete-file' },
      ],
    });
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenNthCalledWith(
      1,
      renamed.filePath,
      null
    );
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenNthCalledWith(
      2,
      created.filePath,
      null
    );
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenNthCalledWith(
      3,
      deleted.filePath,
      `after:${deleted.filePath}`
    );
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenCalledTimes(6);
  });

  it('fences Undo when applied content conflicts with the captured rejected content', async () => {
    const harness = createHarness();
    const [file] = harness.files;
    harness.files = [file];
    harness.rejectableFiles = [file];
    harness.state.hunkDecisions = {};
    harness.buildRejectDiskSnapshot = vi.fn<BuildBulkRejectDiskSnapshot>(() => ({
      filePath: file.filePath,
      beforeContent: 'header\nrejected\nfooter',
      afterContent: 'header\nbase\nfooter',
      file,
    }));
    vi.mocked(harness.commandPort.readCurrentDiskContent).mockResolvedValue(
      'header\napplied\nfooter'
    );
    renderHarness(harness);

    act(() => latest!.rejectAll());
    await waitForRejectAllToSettle(harness);

    const action = harness.latestAction;
    if (!action || action.kind !== 'bulk') throw new Error('Expected a retained bulk action');
    expect(action.diskSnapshots[0]).toMatchObject({
      beforeContent: 'header\nrejected\nfooter',
      afterContent: 'header\napplied\nfooter',
      restoreConflict:
        'Undo conflicts with edits that were preserved while applying the rejection.',
    });
    expect(harness.history.publishUndoHistory).toHaveBeenCalledTimes(1);
  });
});
