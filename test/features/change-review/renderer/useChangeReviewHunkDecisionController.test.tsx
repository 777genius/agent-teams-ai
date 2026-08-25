import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import {
  createReviewOperationScopeToken,
  useChangeReviewHunkDecisionController,
} from '@features/change-review/renderer';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type {
  ChangeReviewHunkDecisionCommandPort,
  ChangeReviewHunkDecisionController,
  ChangeReviewHunkDecisionEditorPort,
  ChangeReviewHunkDecisionHistoryPort,
  ChangeReviewHunkDecisionPolicy,
  ChangeReviewHunkDecisionStatePort,
  ChangeReviewHunkDecisionStateSnapshot,
  ChangeReviewHunkDecisionStatusPort,
  ChangeReviewHunkDecisionWriteEvidencePort,
} from '@features/change-review/renderer';
import type {
  ApplyReviewResult,
  FileChangeSummary,
  FileChangeWithContent,
  ReviewUndoAction,
} from '@shared/types';

interface Harness {
  file: FileChangeSummary;
  content: FileChangeWithContent;
  state: ChangeReviewHunkDecisionStateSnapshot;
  statePort: ChangeReviewHunkDecisionStatePort;
  commandPort: ChangeReviewHunkDecisionCommandPort;
  editorPort: ChangeReviewHunkDecisionEditorPort;
  statusPort: ChangeReviewHunkDecisionStatusPort;
  historyPort: ChangeReviewHunkDecisionHistoryPort;
  writeEvidencePort: ChangeReviewHunkDecisionWriteEvidencePort;
  policy: ChangeReviewHunkDecisionPolicy;
  events: string[];
  undoHistory: ReviewUndoAction[];
  instantApply: boolean;
  current: boolean;
  durable: boolean;
  blocked: boolean;
  draft: boolean;
  inFlight: boolean;
}

let latest: ChangeReviewHunkDecisionController | null = null;
let activeRoot: ReturnType<typeof createRoot> | null = null;

function successfulApply(): ApplyReviewResult {
  return {
    applied: 1,
    skipped: 0,
    conflicts: 0,
    errors: [],
    diskPostimages: [{ filePath: '/repo/file.ts', content: 'disk-after' }],
  };
}

function createHarness(): Harness {
  const file: FileChangeSummary = {
    filePath: '/repo/file.ts',
    relativePath: 'file.ts',
    snippets: [],
    linesAdded: 1,
    linesRemoved: 1,
    isNewFile: false,
  };
  const content: FileChangeWithContent = {
    ...file,
    originalFullContent: 'before',
    modifiedFullContent: 'after',
    contentSource: 'ledger-exact',
  };
  const state: ChangeReviewHunkDecisionStateSnapshot = {
    hunkDecisions: {},
    fileDecisions: {},
    fileChunkCounts: { [file.filePath]: 1 },
    changeSetEpoch: 7,
  };
  const events: string[] = [];
  const undoHistory: ReviewUndoAction[] = [];
  const statePort: ChangeReviewHunkDecisionStatePort = {
    getSnapshot: vi.fn<ChangeReviewHunkDecisionStatePort['getSnapshot']>(() => state),
    setDecision: vi.fn<ChangeReviewHunkDecisionStatePort['setDecision']>(
      (filePath, hunkIndex, decision) => {
        events.push(`state:${decision}`);
        state.hunkDecisions[`${filePath}:${hunkIndex}`] = decision;
        return hunkIndex;
      }
    ),
    clearDecision: vi.fn<ChangeReviewHunkDecisionStatePort['clearDecision']>(
      (filePath, originalIndex) => {
        events.push('state:clear');
        delete state.hunkDecisions[`${filePath}:${originalIndex}`];
      }
    ),
    invalidateResolvedFileContent: vi.fn<
      ChangeReviewHunkDecisionStatePort['invalidateResolvedFileContent']
    >(() => events.push('state:invalidate')),
  };
  const commandPort: ChangeReviewHunkDecisionCommandPort = {
    applySingleFileDecision: vi.fn<ChangeReviewHunkDecisionCommandPort['applySingleFileDecision']>(
      () => {
        events.push('command:apply');
        return Promise.resolve({ status: 'applied', result: successfulApply() });
      }
    ),
    fetchFileContent: vi.fn<ChangeReviewHunkDecisionCommandPort['fetchFileContent']>(() =>
      events.push('command:fetch')
    ),
    readCurrentDiskContent: vi.fn<ChangeReviewHunkDecisionCommandPort['readCurrentDiskContent']>(
      () => {
        events.push('command:read');
        return Promise.resolve('disk-after');
      }
    ),
  };
  const editorPort: ChangeReviewHunkDecisionEditorPort = {
    guardIgnoredMutation: vi.fn(() => events.push('editor:guard')),
    rejectChunk: vi.fn(() => {
      events.push('editor:reject');
      return { beforeContent: 'before', afterContent: 'after' };
    }),
    rollbackContent: vi.fn(() => events.push('editor:rollback')),
  };
  const statusPort: ChangeReviewHunkDecisionStatusPort = {
    beginFileMutation: vi.fn(() => events.push('status:begin')),
    finishFileMutation: vi.fn(() => events.push('status:finish')),
    incrementDiscardCounter: vi.fn(() => events.push('status:discard-counter')),
  };
  const historyPort: ChangeReviewHunkDecisionHistoryPort = {
    pushUndoAction: vi.fn<ChangeReviewHunkDecisionHistoryPort['pushUndoAction']>((input) => {
      events.push('history:push');
      const action = {
        ...input,
        id: `action-${undoHistory.length + 1}`,
        createdAt: '2026-07-24T00:00:00.000Z',
      } as ReviewUndoAction;
      undoHistory.push(action);
      return action;
    }),
    bindCommittedAction: vi.fn<ChangeReviewHunkDecisionHistoryPort['bindCommittedAction']>(() => {
      events.push('history:bind');
      return true;
    }),
    discardLatestAction: vi.fn<ChangeReviewHunkDecisionHistoryPort['discardLatestAction']>(
      (action) => {
        events.push('history:discard');
        if (undoHistory.at(-1)?.id !== action.id) return false;
        undoHistory.pop();
        return true;
      }
    ),
    publishUndoHistory: vi.fn<ChangeReviewHunkDecisionHistoryPort['publishUndoHistory']>(() =>
      events.push('history:publish')
    ),
  };
  const writeEvidencePort: ChangeReviewHunkDecisionWriteEvidencePort = {
    markExpectedWrite: vi.fn(() => events.push('write:expected')),
    clearExpectedWrite: vi.fn(() => events.push('write:clear')),
    markCommittedPostimages: vi.fn(() => events.push('write:committed')),
  };
  const policy: ChangeReviewHunkDecisionPolicy = {
    getHunkCount: (_candidate, snapshot) => snapshot.fileChunkCounts[file.filePath] ?? 0,
    resolveFileIsNew: (candidate, candidateContent) =>
      candidateContent?.isNewFile ?? candidate.isNewFile,
    shouldDeleteWhenUndoingReject: () => false,
    shouldCreateWhenUndoingReject: () => false,
    getRenameRecoveryExpectation: () => null,
  };

  return {
    file,
    content,
    state,
    statePort,
    commandPort,
    editorPort,
    statusPort,
    historyPort,
    writeEvidencePort,
    policy,
    events,
    undoHistory,
    instantApply: true,
    current: true,
    durable: true,
    blocked: false,
    draft: false,
    inFlight: false,
  };
}

function Probe({ harness }: { readonly harness: Harness }): React.JSX.Element {
  latest = useChangeReviewHunkDecisionController({
    files: [harness.file],
    fileContents: { [harness.file.filePath]: harness.content },
    changeSetEpoch: 7,
    instantApply: harness.instantApply,
    teamName: 'team',
    taskId: 'task',
    memberName: undefined,
    statePort: harness.statePort,
    commandPort: harness.commandPort,
    editorPort: harness.editorPort,
    statusPort: harness.statusPort,
    historyPort: harness.historyPort,
    writeEvidencePort: harness.writeEvidencePort,
    policy: harness.policy,
    persistLatestAcceptedAction: vi.fn(() => {
      harness.events.push('persist');
      return Promise.resolve(true);
    }),
    ensureDurableScope: () => harness.durable,
    hasDraft: () => harness.draft,
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
  activeRoot = root;
  return root;
}

function unmountHarness(root: ReturnType<typeof createRoot>): void {
  act(() => root.unmount());
  if (activeRoot === root) activeRoot = null;
}

afterEach(() => {
  if (activeRoot) {
    act(() => activeRoot?.unmount());
    activeRoot = null;
  }
  latest = null;
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

describe('useChangeReviewHunkDecisionController', () => {
  it('guards ignored accept mutations and preserves the legacy false result', () => {
    const harness = createHarness();
    harness.draft = true;
    const root = renderHarness(harness);

    expect(latest?.acceptHunk(harness.file.filePath, 0)).toBe(false);

    expect(harness.events).toEqual(['editor:guard']);
    expect(harness.statePort.setDecision).not.toHaveBeenCalled();
    unmountHarness(root);
  });

  it('records accepted hunk history before durable persistence', () => {
    const harness = createHarness();
    const root = renderHarness(harness);

    expect(latest?.acceptHunk(harness.file.filePath, 0)).toBe(true);

    expect(harness.events).toEqual(['state:accepted', 'history:push', 'persist']);
    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'hunk',
      descriptor: { intent: 'accept-hunk', hunkIndex: 0 },
    });
    unmountHarness(root);
  });

  it('supports the legacy reject callback by capturing exact editor bytes', () => {
    const harness = createHarness();
    harness.instantApply = false;
    const root = renderHarness(harness);

    expect(latest?.rejectHunk(harness.file.filePath, 0)).toBe(true);

    expect(harness.events).toEqual([
      'editor:reject',
      'status:begin',
      'state:rejected',
      'status:finish',
      'history:push',
    ]);
    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'hunk',
      action: { filePath: harness.file.filePath, originalIndex: 0 },
    });
    unmountHarness(root);
  });

  it('uses the stable original hunk index for history and failure rollback', async () => {
    const harness = createHarness();
    vi.mocked(harness.statePort.setDecision).mockImplementationOnce(
      (filePath, _hunkIndex, decision) => {
        harness.events.push(`state:${decision}`);
        harness.state.hunkDecisions[`${filePath}:4`] = decision;
        return 4;
      }
    );
    vi.mocked(harness.commandPort.applySingleFileDecision).mockResolvedValueOnce({
      status: 'failed',
      result: null,
    });
    const root = renderHarness(harness);

    expect(latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after')).toBe(true);
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    const pushedAction = vi.mocked(harness.historyPort.pushUndoAction).mock.calls[0]?.[0];
    expect(pushedAction?.descriptor).toMatchObject({ hunkIndex: 4 });
    if (pushedAction?.kind !== 'disk') {
      throw new Error('Expected reject hunk to create a disk undo action.');
    }
    expect(pushedAction.action).toMatchObject({ originalIndex: 4 });
    expect(harness.statePort.clearDecision).toHaveBeenCalledWith(harness.file.filePath, 4);
    expect(harness.state.hunkDecisions).not.toHaveProperty(`${harness.file.filePath}:4`);
    unmountHarness(root);
  });

  it('rejects a hunk external-change guard without touching editor, state, history, or disk', () => {
    const harness = createHarness();
    harness.blocked = true;
    const root = renderHarness(harness);

    expect(latest?.rejectHunk(harness.file.filePath, 0)).toBe(false);

    expect(harness.editorPort.rejectChunk).not.toHaveBeenCalled();
    expect(harness.statePort.setDecision).not.toHaveBeenCalled();
    expect(harness.historyPort.pushUndoAction).not.toHaveBeenCalled();
    expect(harness.commandPort.applySingleFileDecision).not.toHaveBeenCalled();
    expect(harness.events).toEqual([]);
    unmountHarness(root);
  });

  it('orders expected writes, apply, postimages, history binding, and disk reconciliation', async () => {
    const harness = createHarness();
    const root = renderHarness(harness);

    expect(latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after')).toBe(true);
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    expect(harness.events).toEqual([
      'status:begin',
      'state:rejected',
      'history:push',
      'write:expected',
      'command:apply',
      'write:clear',
      'write:committed',
      'history:bind',
      'command:read',
      'history:publish',
      'write:expected',
      'status:finish',
    ]);
    expect(harness.undoHistory[0]).toMatchObject({
      kind: 'disk',
      action: {
        snapshot: {
          beforeContent: 'before',
          afterContent: 'disk-after',
        },
      },
    });
    unmountHarness(root);
  });

  it('rolls back editor, decision, history, and cached content after apply failure', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applySingleFileDecision).mockImplementationOnce(() => {
      harness.events.push('command:apply');
      return Promise.resolve({ status: 'failed', result: null });
    });
    const root = renderHarness(harness);

    latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after');
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    expect(harness.events).toContain('editor:rollback');
    expect(harness.events).toContain('state:clear');
    expect(harness.events).toContain('history:discard');
    expect(harness.events).toContain('state:invalidate');
    expect(harness.events).toContain('status:discard-counter');
    expect(harness.events).toContain('command:fetch');
    expect(harness.writeEvidencePort.clearExpectedWrite).toHaveBeenCalledWith(
      harness.file.filePath
    );
    expect(harness.historyPort.bindCommittedAction).not.toHaveBeenCalled();
    expect(harness.events.at(-1)).toBe('status:finish');
    expect(harness.undoHistory).toHaveLength(0);
    unmountHarness(root);
  });

  it('rolls back and releases the busy state when the Apply command rejects', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.applySingleFileDecision).mockImplementationOnce(() => {
      harness.events.push('command:apply');
      return Promise.reject(new Error('transport unavailable'));
    });
    const root = renderHarness(harness);

    latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after');
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    expect(harness.events).toEqual([
      'status:begin',
      'state:rejected',
      'history:push',
      'write:expected',
      'command:apply',
      'write:clear',
      'write:committed',
      'editor:rollback',
      'state:clear',
      'history:discard',
      'state:invalidate',
      'status:discard-counter',
      'command:fetch',
      'status:finish',
    ]);
    expect(harness.historyPort.bindCommittedAction).not.toHaveBeenCalled();
    expect(harness.undoHistory).toHaveLength(0);
    unmountHarness(root);
  });

  it('publishes successful history with exact fallback bytes when disk reconciliation rejects', async () => {
    const harness = createHarness();
    vi.mocked(harness.commandPort.readCurrentDiskContent).mockRejectedValueOnce(
      new Error('read unavailable')
    );
    const root = renderHarness(harness);

    latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after');
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    expect(harness.historyPort.publishUndoHistory).toHaveBeenCalledOnce();
    const publishedAction = harness.undoHistory[0];
    if (publishedAction?.kind !== 'disk') {
      throw new Error('Expected successful reject hunk to publish a disk undo action.');
    }
    expect(publishedAction.action.snapshot.beforeContent).toBe('before');
    expect(publishedAction.action.snapshot.afterContent).toBe('after');
    expect(harness.writeEvidencePort.markExpectedWrite).toHaveBeenLastCalledWith(
      harness.file.filePath,
      'after'
    );
    expect(harness.events.at(-1)).toBe('status:finish');
    unmountHarness(root);
  });

  it('fences late apply results from an obsolete operation generation', async () => {
    const harness = createHarness();
    let resolveApply:
      | ((
          result: Awaited<
            ReturnType<ChangeReviewHunkDecisionCommandPort['applySingleFileDecision']>
          >
        ) => void)
      | undefined;
    vi.mocked(harness.commandPort.applySingleFileDecision).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          harness.events.push('command:apply');
          resolveApply = resolve;
        })
    );
    const root = renderHarness(harness);

    latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after');
    await vi.waitFor(() =>
      expect(harness.commandPort.applySingleFileDecision).toHaveBeenCalledOnce()
    );
    harness.current = false;
    resolveApply?.({ status: 'applied', result: successfulApply() });
    await Promise.resolve();

    expect(harness.writeEvidencePort.markCommittedPostimages).not.toHaveBeenCalled();
    expect(harness.historyPort.bindCommittedAction).not.toHaveBeenCalled();
    expect(harness.statusPort.finishFileMutation).not.toHaveBeenCalled();
    unmountHarness(root);
  });

  it('rolls back optimistic state when durable scope is unavailable', async () => {
    const harness = createHarness();
    harness.durable = false;
    const root = renderHarness(harness);

    latest?.rejectHunk(harness.file.filePath, 0, 'before', 'after');
    await vi.waitFor(() => expect(harness.statusPort.finishFileMutation).toHaveBeenCalledOnce());

    expect(harness.events).toEqual([
      'status:begin',
      'state:rejected',
      'history:push',
      'editor:rollback',
      'state:clear',
      'history:discard',
      'status:finish',
    ]);
    expect(harness.commandPort.applySingleFileDecision).not.toHaveBeenCalled();
    unmountHarness(root);
  });
});
