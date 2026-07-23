import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewFileDecisionController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewFileDecisionCommandPort,
  ChangeReviewFileDecisionController,
  ChangeReviewFileDecisionEditorPort,
  ChangeReviewFileDecisionHistoryPort,
  ChangeReviewFileDecisionPolicy,
  ChangeReviewFileDecisionStatePort,
  ChangeReviewFileDecisionStateSnapshot,
  ChangeReviewFileDecisionStatusPort,
  ChangeReviewFileDecisionWriteEvidencePort,
} from '@features/change-review/renderer';
import type {
  ApplyReviewResult,
  ExecuteReviewMutationResult,
  FileChangeSummary,
  FileChangeWithContent,
  ReviewUndoAction,
} from '@shared/types';

interface Harness {
  file: FileChangeSummary;
  content: FileChangeWithContent;
  state: ChangeReviewFileDecisionStateSnapshot;
  history: ChangeReviewFileDecisionHistoryPort;
  statePort: ChangeReviewFileDecisionStatePort;
  commandPort: ChangeReviewFileDecisionCommandPort;
  editorPort: ChangeReviewFileDecisionEditorPort;
  statusPort: ChangeReviewFileDecisionStatusPort;
  writeEvidencePort: ChangeReviewFileDecisionWriteEvidencePort;
  policy: ChangeReviewFileDecisionPolicy;
  persistLatest: ReturnType<typeof vi.fn<() => Promise<boolean>>>;
  undoHistory: ReviewUndoAction[];
  events: string[];
  current: boolean;
  durable: boolean;
}

let latest: ChangeReviewFileDecisionController | null = null;

function makeFile(filePath = '/repo/file.ts'): FileChangeSummary {
  return {
    filePath,
    relativePath: 'file.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
}

function makeContent(file: FileChangeSummary): FileChangeWithContent {
  return {
    ...file,
    originalFullContent: 'before',
    modifiedFullContent: 'after',
    contentSource: 'ledger-exact',
  };
}

function successfulApply(): ApplyReviewResult {
  return { applied: 1, skipped: 0, conflicts: 0, errors: [] };
}

function successfulMutation(): ExecuteReviewMutationResult {
  return {
    decisionRevision: 9,
    diskPostimages: [{ filePath: '/repo/file.ts', content: 'after' }],
  };
}

function createHarness(): Harness {
  const file = makeFile();
  const content = makeContent(file);
  const state: ChangeReviewFileDecisionStateSnapshot = {
    fileContents: { [file.filePath]: content },
    reviewExternalChangesByFile: {},
    hunkDecisions: {},
    fileDecisions: {},
    hunkContextHashesByFile: {},
    fileChunkCounts: { [file.filePath]: 1 },
    decisionRevision: 4,
    changeSetEpoch: 7,
  };
  const harness = {} as Harness;
  const undoHistory: ReviewUndoAction[] = [];
  const events: string[] = [];
  const history: ChangeReviewFileDecisionHistoryPort = {
    pushUndoAction: vi.fn<ChangeReviewFileDecisionHistoryPort['pushUndoAction']>((input) => {
      events.push('history:push');
      const action = {
        ...input,
        id: `action-${undoHistory.length + 1}`,
        createdAt: '2026-07-24T00:00:00.000Z',
      } as ReviewUndoAction;
      undoHistory.push(action);
      return action;
    }),
    bindCommittedAction: vi.fn<ChangeReviewFileDecisionHistoryPort['bindCommittedAction']>(() => {
      events.push('history:bind');
      return true;
    }),
    discardLatestAction: vi.fn<ChangeReviewFileDecisionHistoryPort['discardLatestAction']>(
      (action) => {
        events.push('history:discard');
        if (undoHistory.at(-1)?.id !== action.id) return false;
        undoHistory.pop();
        return true;
      }
    ),
    getUndoHistory: vi.fn<ChangeReviewFileDecisionHistoryPort['getUndoHistory']>(() => undoHistory),
    getRedoHistory: vi.fn<ChangeReviewFileDecisionHistoryPort['getRedoHistory']>(() => []),
    publishUndoHistory: vi.fn<ChangeReviewFileDecisionHistoryPort['publishUndoHistory']>(() => {
      events.push('history:publish');
    }),
  };
  const statePort: ChangeReviewFileDecisionStatePort = {
    getSnapshot: vi.fn<ChangeReviewFileDecisionStatePort['getSnapshot']>(() => state),
    acceptAllFile: vi.fn<ChangeReviewFileDecisionStatePort['acceptAllFile']>(() => {
      events.push('state:accept');
      state.fileDecisions[file.filePath] = 'accepted';
      return true;
    }),
    rejectAllFile: vi.fn<ChangeReviewFileDecisionStatePort['rejectAllFile']>(() => {
      events.push('state:reject');
      state.fileDecisions[file.filePath] = 'rejected';
    }),
    applyRestoredDecisionState: vi.fn<
      ChangeReviewFileDecisionStatePort['applyRestoredDecisionState']
    >(() => {
      events.push('state:restore');
      state.fileDecisions[file.filePath] = 'accepted';
    }),
    restoreFileDecisions: vi.fn<ChangeReviewFileDecisionStatePort['restoreFileDecisions']>(
      (_file, snapshot) => {
        events.push('state:rollback');
        state.hunkDecisions = { ...snapshot.hunkDecisions };
        state.fileDecisions = { ...snapshot.fileDecisions };
      }
    ),
    clearExternalChange: vi.fn<ChangeReviewFileDecisionStatePort['clearExternalChange']>(() =>
      events.push('state:clear-external')
    ),
    invalidateResolvedFileContent: vi.fn<
      ChangeReviewFileDecisionStatePort['invalidateResolvedFileContent']
    >(() => events.push('state:invalidate')),
    reportError: vi.fn<ChangeReviewFileDecisionStatePort['reportError']>((message) =>
      events.push(`state:error:${message ?? 'clear'}`)
    ),
  };
  const commandPort: ChangeReviewFileDecisionCommandPort = {
    checkConflict: vi.fn<ChangeReviewFileDecisionCommandPort['checkConflict']>(
      (_scope, _filePath, expectedContent) => {
        events.push('command:conflict');
        return Promise.resolve({
          hasConflict: false,
          conflictContent: null,
          originalContent: expectedContent,
          currentContent: expectedContent,
        });
      }
    ),
    executeMutation: vi.fn<ChangeReviewFileDecisionCommandPort['executeMutation']>(() => {
      events.push('command:execute');
      return Promise.resolve(successfulMutation());
    }),
    applySingleFileDecision: vi.fn<ChangeReviewFileDecisionCommandPort['applySingleFileDecision']>(
      () => {
        events.push('command:apply');
        return Promise.resolve(successfulApply());
      }
    ),
    quiescePersistence: vi.fn<ChangeReviewFileDecisionCommandPort['quiescePersistence']>(() => {
      events.push('command:quiesce');
      return Promise.resolve(true);
    }),
    recordDecisionRevision: vi.fn<ChangeReviewFileDecisionCommandPort['recordDecisionRevision']>(
      () => events.push('command:revision')
    ),
    fetchFileContent: vi.fn<ChangeReviewFileDecisionCommandPort['fetchFileContent']>(() =>
      events.push('command:fetch')
    ),
    readCurrentDiskContent: vi.fn<ChangeReviewFileDecisionCommandPort['readCurrentDiskContent']>(
      (_filePath, fallback) => {
        events.push('command:read');
        return Promise.resolve(fallback);
      }
    ),
  };
  const editorPort: ChangeReviewFileDecisionEditorPort = {
    getCurrentContent: vi.fn<ChangeReviewFileDecisionEditorPort['getCurrentContent']>(
      () => content.modifiedFullContent
    ),
    scheduleEditorSync: vi.fn<ChangeReviewFileDecisionEditorPort['scheduleEditorSync']>(
      (callback) => callback()
    ),
    acceptAllEditorChunks: vi.fn<ChangeReviewFileDecisionEditorPort['acceptAllEditorChunks']>(() =>
      events.push('editor:accept')
    ),
    rejectAllEditorChunks: vi.fn<ChangeReviewFileDecisionEditorPort['rejectAllEditorChunks']>(() =>
      events.push('editor:reject')
    ),
    rollbackEditorContent: vi.fn<ChangeReviewFileDecisionEditorPort['rollbackEditorContent']>(() =>
      events.push('editor:rollback')
    ),
  };
  const statusPort: ChangeReviewFileDecisionStatusPort = {
    beginFileMutation: vi.fn(() => events.push('status:begin')),
    finishFileMutation: vi.fn(() => events.push('status:finish')),
    incrementDiscardCounter: vi.fn(() => events.push('status:discard-counter')),
  };
  const writeEvidencePort: ChangeReviewFileDecisionWriteEvidencePort = {
    markExpectedWrite: vi.fn(() => events.push('write:expected')),
    markCommittedPostimages: vi.fn(() => events.push('write:committed')),
  };
  const policy: ChangeReviewFileDecisionPolicy = {
    getHunkCount: () => 1,
    getFileDecision: (candidate, snapshot) => snapshot.fileDecisions[candidate.filePath],
    resolveModifiedContent: (_candidate, candidateContent) =>
      candidateContent?.modifiedFullContent ?? null,
    resolveFileIsNew: (candidate, candidateContent) =>
      candidateContent?.isNewFile ?? candidate.isNewFile,
    isExpectedDeletion: () => false,
    isAcceptDisabled: () => false,
    isRejectable: () => true,
    hasFileRejections: (candidate, _count, decisions) =>
      decisions.fileDecisions[candidate.filePath] === 'rejected',
    isFileFullyRejected: (candidate, _count, decisions) =>
      decisions.fileDecisions[candidate.filePath] === 'rejected',
    shouldDeleteWhenUndoingReject: () => false,
    hasUnresolvedExternalChange: () => false,
    getRenameRecoveryExpectation: () => null,
  };
  Object.assign(harness, {
    file,
    content,
    state,
    history,
    statePort,
    commandPort,
    editorPort,
    statusPort,
    writeEvidencePort,
    policy,
    persistLatest: vi.fn<() => Promise<boolean>>().mockResolvedValue(true),
    undoHistory,
    events,
    current: true,
    durable: true,
  });
  return harness;
}

function Probe({ harness }: { readonly harness: Harness }): React.JSX.Element {
  latest = useChangeReviewFileDecisionController({
    files: [harness.file],
    fileContents: { [harness.file.filePath]: harness.content },
    changeSetEpoch: 7,
    instantApply: true,
    teamName: 'team',
    taskId: 'task',
    memberName: undefined,
    reviewScope: { teamName: 'team', taskId: 'task' },
    persistenceScope: { teamName: 'team', scopeKey: 'task', scopeToken: 'token' },
    history: harness.history,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    editorPort: harness.editorPort,
    statusPort: harness.statusPort,
    writeEvidencePort: harness.writeEvidencePort,
    policy: harness.policy,
    persistLatestAcceptedAction: harness.persistLatest,
    ensureDurableScope: () => harness.durable,
    hasDraft: () => false,
    hasActionInFlight: () => false,
    blockForExternalChange: () => false,
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

afterEach(() => {
  latest = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('useChangeReviewFileDecisionController', () => {
  it('accepts a pending file and records history before durable persistence', () => {
    const harness = createHarness();
    const root = renderHarness(harness);

    act(() => latest?.acceptFile(harness.file.filePath));

    expect(harness.events).toEqual(['state:accept', 'history:push', 'editor:accept']);
    expect(harness.persistLatest).toHaveBeenCalledTimes(1);
    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'bulk',
      descriptor: { intent: 'accept-file', filePath: harness.file.filePath },
    });
    act(() => root.unmount());
  });

  it('restores a rejected file with quiesce, history, WAL commit, then revision binding', async () => {
    const harness = createHarness();
    harness.state.fileDecisions[harness.file.filePath] = 'rejected';
    const root = renderHarness(harness);

    act(() => latest?.acceptFile(harness.file.filePath));
    await vi.waitFor(() => {
      expect(harness.commandPort.executeMutation).toHaveBeenCalledTimes(1);
      expect(harness.statusPort.finishFileMutation).toHaveBeenCalledTimes(1);
    });

    const quiesceIndex = harness.events.indexOf('command:quiesce');
    const restoreIndex = harness.events.indexOf('state:restore');
    const pushIndex = harness.events.indexOf('history:push');
    const executeIndex = harness.events.indexOf('command:execute');
    const bindIndex = harness.events.indexOf('history:bind');
    const revisionIndex = harness.events.indexOf('command:revision');
    expect(quiesceIndex).toBeLessThan(restoreIndex);
    expect(restoreIndex).toBeLessThan(pushIndex);
    expect(pushIndex).toBeLessThan(executeIndex);
    expect(executeIndex).toBeLessThan(bindIndex);
    expect(bindIndex).toBeLessThan(revisionIndex);

    const request = vi.mocked(harness.commandPort.executeMutation).mock.calls[0][0];
    expect(request).toMatchObject({
      kind: 'restore',
      expectedDecisionRevision: 4,
      persistedState: {
        fileDecisions: { [harness.file.filePath]: 'accepted' },
      },
    });
    expect(request.persistedState.reviewActionHistory).toHaveLength(1);
    act(() => root.unmount());
  });

  it('rolls back decision, editor, and optimistic history when instant reject fails', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applySingleFileDecision).mockResolvedValueOnce(null);
    const root = renderHarness(harness);

    await act(async () => {
      await latest?.rejectFile(harness.file.filePath);
    });

    expect(harness.events).toContain('state:reject');
    expect(harness.events).toContain('history:discard');
    expect(harness.events).toContain('state:rollback');
    expect(harness.events).toContain('editor:rollback');
    expect(harness.events).toContain('state:invalidate');
    expect(harness.events).toContain('status:discard-counter');
    expect(harness.events.at(-1)).toBe('status:finish');
    expect(harness.undoHistory).toHaveLength(0);
    act(() => root.unmount());
  });

  it('records exact create-file Undo state when rejecting a new file', async () => {
    const harness = createHarness();
    harness.file.isNewFile = true;
    harness.content.isNewFile = true;
    harness.content.originalFullContent = '';
    const root = renderHarness(harness);

    await act(async () => {
      await latest?.rejectFile(harness.file.filePath);
    });

    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'disk',
      action: {
        snapshot: {
          afterContent: null,
          beforeContent: 'after',
          fileIndex: 0,
          restoreMode: 'create-file',
        },
      },
    });
    expect(harness.commandPort.readCurrentDiskContent).not.toHaveBeenCalled();
    expect(harness.statePort.invalidateResolvedFileContent).toHaveBeenCalledWith(
      harness.file.filePath
    );
    act(() => root.unmount());
  });

  it('restores an expected deletion as an absent postimage without a conflict read', async () => {
    const harness = createHarness();
    harness.state.fileDecisions[harness.file.filePath] = 'rejected';
    harness.policy.isExpectedDeletion = () => true;
    const root = renderHarness(harness);

    act(() => latest?.acceptFile(harness.file.filePath));
    await vi.waitFor(() => expect(harness.commandPort.executeMutation).toHaveBeenCalledTimes(1));

    expect(harness.commandPort.checkConflict).not.toHaveBeenCalled();
    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'disk',
      action: {
        snapshot: {
          beforeContent: 'before',
          afterContent: null,
          restoreMode: 'create-file',
        },
      },
    });
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenCalledWith(
      harness.file.filePath,
      null
    );
    act(() => root.unmount());
  });

  it('ignores a late reject result from an obsolete operation generation', async () => {
    const harness = createHarness();
    let resolveApply: ((result: ApplyReviewResult) => void) | undefined;
    vi.mocked(harness.commandPort.applySingleFileDecision).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveApply = resolve;
        })
    );
    const root = renderHarness(harness);

    const pending = latest?.rejectFile(harness.file.filePath);
    await vi.waitFor(() =>
      expect(harness.commandPort.applySingleFileDecision).toHaveBeenCalledTimes(1)
    );
    harness.current = false;
    resolveApply?.(successfulApply());
    await pending;

    expect(harness.writeEvidencePort.markCommittedPostimages).not.toHaveBeenCalled();
    expect(harness.history.bindCommittedAction).not.toHaveBeenCalled();
    expect(harness.history.discardLatestAction).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).not.toHaveBeenCalled();
    act(() => root.unmount());
  });
});
