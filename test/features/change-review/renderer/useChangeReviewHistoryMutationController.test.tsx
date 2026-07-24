import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewHistoryMutationController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewActionHistoryController,
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationController,
  ChangeReviewHistoryMutationScope,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryMutationViewPort,
  ChangeReviewHistoryStateSnapshot,
  ReviewActionPersistenceStatus,
  ReviewOperationScopeToken,
} from '@features/change-review/renderer';
import type {
  FileChangeSummary,
  RestoreReviewHistoryResult,
  RetryReviewMutationRecoveryResult,
  ReviewPersistedStateSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';

type ActionHistory = Pick<
  ChangeReviewActionHistoryController,
  | 'getUndoHistory'
  | 'getRedoHistory'
  | 'getLatestUndoAction'
  | 'getLatestRedoAction'
  | 'completeUndoAction'
  | 'completeRedoAction'
  | 'replaceHistories'
>;

interface Harness {
  files: FileChangeSummary[];
  history: ActionHistory;
  commandPort: ChangeReviewHistoryMutationCommandPort;
  statePort: ChangeReviewHistoryMutationStatePort;
  viewPort: ChangeReviewHistoryMutationViewPort;
  scope: ChangeReviewHistoryMutationScope;
  current: boolean;
  editedCount: number;
  persistenceStatus: ReviewActionPersistenceStatus;
  hasActionInFlight: boolean;
  externalChange: boolean;
}

interface ProbeProps {
  readonly harness: Harness;
}

let latest: ChangeReviewHistoryMutationController | null = null;

function Probe({ harness }: ProbeProps): React.JSX.Element {
  latest = useChangeReviewHistoryMutationController({
    teamName: 'team',
    memberName: 'member',
    files: harness.files,
    editedCount: harness.editedCount,
    decisionHydrationReady: true,
    scope: harness.scope,
    history: harness.history,
    commandPort: harness.commandPort,
    statePort: harness.statePort,
    viewPort: harness.viewPort,
    captureOperationScope: () => createReviewOperationScopeToken('scope'),
    isCurrentOperationScope: (_scope: ReviewOperationScopeToken | null) => harness.current,
    hasActionInFlight: () => harness.hasActionInFlight,
    isFileMutationInFlight: () => false,
    blockForExternalChange: () => harness.externalChange,
    getPersistenceStatus: () => harness.persistenceStatus,
  });
  return <div />;
}

function hunkAction(id = 'action-1'): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-23T00:00:00.000Z',
    kind: 'hunk',
    action: { filePath: '/repo/file.ts', originalIndex: 0 },
  };
}

function diskAction(id = 'disk-1'): ReviewUndoAction {
  return {
    id,
    createdAt: '2026-07-23T00:00:00.000Z',
    kind: 'disk',
    action: {
      originalIndex: 0,
      snapshot: {
        filePath: '/repo/file.ts',
        beforeContent: 'before',
        afterContent: 'after',
      },
    },
  } as ReviewUndoAction;
}

function persistedState(
  undo: ReviewUndoAction[] = [],
  redo: ReviewRedoAction[] = []
): ReviewPersistedStateSnapshot {
  return {
    hunkDecisions: {},
    fileDecisions: {},
    hunkContextHashesByFile: {},
    reviewActionHistory: undo,
    reviewRedoHistory: redo,
  };
}

function recoveryResult(
  input: Partial<RetryReviewMutationRecoveryResult> = {}
): RetryReviewMutationRecoveryResult {
  return {
    decisionRevision: 4,
    recoveredMutation: false,
    recoveredRestoreHistory: false,
    differentMutationPending: false,
    persistedState: null,
    expectedRestoreCompleted: false,
    diskPostimages: [],
    retried: false,
    ...input,
  };
}

function createHarness(
  input: {
    undo?: ReviewUndoAction[];
    redo?: ReviewRedoAction[];
    state?: Partial<ChangeReviewHistoryStateSnapshot>;
  } = {}
): Harness {
  let undo = input.undo ?? [];
  let redo = input.redo ?? [];
  const state: ChangeReviewHistoryStateSnapshot = {
    hunkDecisions: { '/repo/file.ts:0': 'accepted' },
    fileDecisions: {},
    hunkContextHashesByFile: {},
    decisionRevision: 4,
    ...input.state,
  };
  const history: ActionHistory = {
    getUndoHistory: vi.fn(() => undo),
    getRedoHistory: vi.fn(() => redo),
    getLatestUndoAction: vi.fn(() => undo.at(-1)),
    getLatestRedoAction: vi.fn(() => redo.at(-1)),
    completeUndoAction: vi.fn((action, redoAction) => {
      if (undo.at(-1) !== action) return false;
      undo = undo.slice(0, -1);
      redo = [...redo, redoAction];
      return true;
    }),
    completeRedoAction: vi.fn((redoAction) => {
      if (redo.at(-1) !== redoAction) return false;
      redo = redo.slice(0, -1);
      undo = [...undo, redoAction.action];
      return true;
    }),
    replaceHistories: vi.fn((nextUndo, nextRedo) => {
      undo = nextUndo;
      redo = nextRedo;
    }),
  };
  const commandPort: ChangeReviewHistoryMutationCommandPort = {
    executeMutation: vi.fn().mockResolvedValue({ decisionRevision: 5, diskPostimages: [] }),
    restoreHistory: vi.fn().mockResolvedValue({
      decisionRevision: 5,
      persistedState: persistedState(),
      direction: 'undo',
      actionCount: 1,
      diskPostimages: [],
    } satisfies RestoreReviewHistoryResult),
    retryRecovery: vi.fn().mockResolvedValue(recoveryResult()),
  };
  const statePort: ChangeReviewHistoryMutationStatePort = {
    getSnapshot: vi.fn(() => state),
    quiesceDecisionPersistence: vi.fn().mockResolvedValue(true),
    recordDecisionRevision: vi.fn(),
    applyDecisionState: vi.fn(),
    applyPersistedState: vi.fn(),
    reportError: vi.fn(),
    clearExternalChange: vi.fn(),
    invalidateResolvedFileContent: vi.fn(),
  };
  const viewPort: ChangeReviewHistoryMutationViewPort = {
    addMissingFile: vi.fn(),
    fetchFileContent: vi.fn(),
    incrementDiscardCounters: vi.fn(),
    navigateToAction: vi.fn(),
    markExpectedWrite: vi.fn(),
    clearExpectedWrite: vi.fn(),
    markCommittedPostimages: vi.fn(),
    setMutationInFlight: vi.fn(),
  };
  return {
    files: [
      {
        filePath: '/repo/file.ts',
        relativePath: 'file.ts',
        snippets: [],
        linesAdded: 1,
        linesRemoved: 0,
        isNewFile: false,
      },
    ],
    history,
    commandPort,
    statePort,
    viewPort,
    scope: {
      review: { teamName: 'team', memberName: 'member' },
      persistence: { teamName: 'team', scopeKey: 'scope', scopeToken: 'token' },
    },
    current: true,
    editedCount: 0,
    persistenceStatus: 'saved',
    hasActionInFlight: false,
    externalChange: false,
  };
}

async function renderHarness(harness: Harness): Promise<ReturnType<typeof createRoot>> {
  vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
  const root = createRoot(document.body.appendChild(document.createElement('div')));
  await act(async () => root.render(<Probe harness={harness} />));
  return root;
}

describe('useChangeReviewHistoryMutationController', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.unstubAllGlobals();
  });

  it('commits Undo with exact top-action and revision CAS before popping local history', async () => {
    const action = hunkAction();
    const harness = createHarness({ undo: [action] });
    await renderHarness(harness);

    await act(async () => latest!.undoLatest());

    const request = vi.mocked(harness.commandPort.executeMutation).mock.calls[0]![0];
    expect(request.expectedTopActionId).toBe(action.id);
    expect(request.expectedDecisionRevision).toBe(4);
    expect(request.decisionPersistenceScope).toEqual({ scopeKey: 'scope', scopeToken: 'token' });
    expect(request.persistedState.hunkDecisions).toEqual({});
    expect(request.persistedState.reviewActionHistory).toEqual([]);
    expect(harness.history.completeUndoAction).toHaveBeenCalledTimes(1);
    expect(harness.statePort.recordDecisionRevision).toHaveBeenCalledWith(
      harness.scope.persistence,
      5
    );
    expect(harness.viewPort.setMutationInFlight).toHaveBeenNthCalledWith(1, true);
    expect(harness.viewPort.setMutationInFlight).toHaveBeenLastCalledWith(false);
  });

  it('does not execute or publish Undo after the operation scope becomes stale', async () => {
    const action = hunkAction();
    const harness = createHarness({ undo: [action] });
    vi.mocked(harness.statePort.quiesceDecisionPersistence).mockImplementation(async () => {
      harness.current = false;
      return true;
    });
    await renderHarness(harness);

    await act(async () => latest!.undoLatest());

    expect(harness.commandPort.executeMutation).not.toHaveBeenCalled();
    expect(harness.history.completeUndoAction).not.toHaveBeenCalled();
    expect(harness.statePort.applyDecisionState).not.toHaveBeenCalled();
    expect(harness.viewPort.setMutationInFlight).toHaveBeenCalledTimes(1);
  });

  it('prepares Redo disk expectations and commits the exact redo-head CAS', async () => {
    const action = diskAction();
    const redoAction: ReviewRedoAction = {
      action,
      decisionSnapshot: { hunkDecisions: { restored: 'rejected' }, fileDecisions: {} },
    };
    const harness = createHarness({ redo: [redoAction] });
    const order: string[] = [];
    vi.mocked(harness.viewPort.markExpectedWrite).mockImplementation(() => order.push('expect'));
    vi.mocked(harness.commandPort.executeMutation).mockImplementation(async () => {
      order.push('execute');
      return { decisionRevision: 5, diskPostimages: [] };
    });
    await renderHarness(harness);

    await act(async () => latest!.redoLatest());

    const request = vi.mocked(harness.commandPort.executeMutation).mock.calls[0]![0];
    expect(order).toEqual(['expect', 'execute']);
    expect(harness.viewPort.markExpectedWrite).toHaveBeenCalledWith('/repo/file.ts', 'after');
    expect(request.expectedTopRedoActionId).toBe(action.id);
    expect(request.expectedDecisionRevision).toBe(4);
    expect(harness.history.completeRedoAction).toHaveBeenCalledWith(redoAction);
  });

  it('retries the original Restore only after a no-journal recovery finishes its busy scope', async () => {
    const action = hunkAction();
    const harness = createHarness({ undo: [action] });
    vi.mocked(harness.commandPort.retryRecovery).mockResolvedValue(
      recoveryResult({ decisionRevision: 4 })
    );
    await renderHarness(harness);

    await act(async () => latest!.recoverFailedHistory({ kind: 'start' }));

    expect(harness.commandPort.retryRecovery).toHaveBeenCalledTimes(1);
    expect(harness.commandPort.restoreHistory).toHaveBeenCalledTimes(1);
    expect(harness.viewPort.setMutationInFlight).toHaveBeenNthCalledWith(1, true);
    expect(harness.viewPort.setMutationInFlight).toHaveBeenNthCalledWith(2, false);
    expect(harness.viewPort.setMutationInFlight).toHaveBeenNthCalledWith(3, true);
    expect(harness.viewPort.setMutationInFlight).toHaveBeenLastCalledWith(false);
  });

  it('clears prepared expectations and fails closed for a different pending mutation', async () => {
    const action = diskAction();
    const harness = createHarness({ undo: [action] });
    vi.mocked(harness.commandPort.retryRecovery).mockResolvedValue(
      recoveryResult({ differentMutationPending: true })
    );
    await renderHarness(harness);

    let recoveryError: unknown;
    await act(async () => {
      try {
        await latest!.recoverFailedHistory({ kind: 'start' });
      } catch (error) {
        recoveryError = error;
      }
    });

    expect(recoveryError).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('different interrupted review update'),
      })
    );
    expect(harness.viewPort.clearExpectedWrite).toHaveBeenCalledWith('/repo/file.ts');
    expect(harness.commandPort.restoreHistory).not.toHaveBeenCalled();
    expect(harness.statePort.reportError).toHaveBeenCalledWith(
      expect.stringContaining('different interrupted review update')
    );
  });

  it('blocks Restore before IPC while decision persistence is not saved', async () => {
    const harness = createHarness({ undo: [hunkAction()] });
    harness.persistenceStatus = 'saving';
    await renderHarness(harness);

    let restoreError: unknown;
    await act(async () => {
      try {
        await latest!.restoreHistory({ kind: 'start' });
      } catch (error) {
        restoreError = error;
      }
    });
    expect(restoreError).toEqual(
      expect.objectContaining({
        message: expect.stringContaining('Latest review action is not saved'),
      })
    );
    expect(harness.commandPort.restoreHistory).not.toHaveBeenCalled();
  });
});
