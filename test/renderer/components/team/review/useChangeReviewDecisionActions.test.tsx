import React, { act } from 'react';
import { createRoot } from 'react-dom/client';

import { useChangeReviewDecisionActions } from '@renderer/components/team/review/useChangeReviewDecisionActions';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { EditorView } from '@codemirror/view';
import type {
  ChangeReviewActionHistoryController,
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDialogViewPorts,
  ChangeReviewExternalChangeController,
  ChangeReviewMutationGuards,
  ChangeReviewOperationState,
} from '@features/change-review/renderer';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
} from '@shared/types';

const decisionMocks = vi.hoisted(() => ({
  bulkCommandPort: { kind: 'bulk-command' },
  fileCommandPort: { kind: 'file-command' },
  hunkCommandPort: { kind: 'hunk-command' },
  createBulkCommandPort: vi.fn(),
  createFileCommandPort: vi.fn(),
  createHunkCommandPort: vi.fn(),
  acceptAll: vi.fn(),
  rejectAll: vi.fn(),
  acceptFile: vi.fn(),
  rejectFile: vi.fn(),
  acceptHunk: vi.fn(),
  rejectHunk: vi.fn(),
  useBulkController: vi.fn(),
  useFileController: vi.fn(),
  useHunkController: vi.fn(),
}));

vi.mock('@features/change-review/renderer', async () => {
  const actual = await vi.importActual<typeof import('@features/change-review/renderer')>(
    '@features/change-review/renderer'
  );
  decisionMocks.createBulkCommandPort.mockReturnValue(decisionMocks.bulkCommandPort);
  decisionMocks.createFileCommandPort.mockReturnValue(decisionMocks.fileCommandPort);
  decisionMocks.createHunkCommandPort.mockReturnValue(decisionMocks.hunkCommandPort);
  decisionMocks.useBulkController.mockReturnValue({
    acceptAll: decisionMocks.acceptAll,
    rejectAll: decisionMocks.rejectAll,
  });
  decisionMocks.useFileController.mockReturnValue({
    acceptFile: decisionMocks.acceptFile,
    rejectFile: decisionMocks.rejectFile,
  });
  decisionMocks.useHunkController.mockReturnValue({
    acceptHunk: decisionMocks.acceptHunk,
    rejectHunk: decisionMocks.rejectHunk,
  });
  return {
    ...actual,
    createChangeReviewBulkDecisionCommandPort: decisionMocks.createBulkCommandPort,
    createChangeReviewFileDecisionCommandPort: decisionMocks.createFileCommandPort,
    createChangeReviewHunkDecisionCommandPort: decisionMocks.createHunkCommandPort,
    useChangeReviewBulkDecisionController: decisionMocks.useBulkController,
    useChangeReviewFileDecisionController: decisionMocks.useFileController,
    useChangeReviewHunkDecisionController: decisionMocks.useHunkController,
  };
});

const file: FileChangeSummary = {
  filePath: '/repo/a.ts',
  relativePath: 'a.ts',
  snippets: [],
  linesAdded: 1,
  linesRemoved: 0,
  isNewFile: true,
};
const fileContent: FileChangeWithContent = {
  ...file,
  originalFullContent: '',
  modifiedFullContent: 'agent content',
  contentSource: 'ledger-exact',
};
const editorViewMapRef = {
  current: new Map([
    [
      file.filePath,
      {
        state: { doc: { toString: () => 'current editor content' } },
      } as unknown as EditorView,
    ],
  ]),
};

const history = {
  pushUndoAction: vi.fn(),
  bindCommittedAction: vi.fn(),
  discardLatestAction: vi.fn(),
  getLatestUndoAction: vi.fn(),
  getUndoHistory: vi.fn(),
  getRedoHistory: vi.fn(),
  publishUndoHistory: vi.fn(),
} as unknown as ChangeReviewActionHistoryController;
const persistence = {
  persistLatest: vi.fn(() => Promise.resolve(true)),
} as unknown as ChangeReviewDecisionPersistenceController;
const mutationGuards = {
  ensureDurableReviewScope: vi.fn(() => true),
  hasReviewActionInFlight: vi.fn(() => false),
} as unknown as ChangeReviewMutationGuards;
const operation = {
  captureReviewOperationScope: vi.fn(),
  isCurrentReviewOperationScope: vi.fn(),
} as unknown as ChangeReviewOperationState;
const externalChange = {
  blockReviewMutationForExternalChange: vi.fn(() => false),
} as unknown as ChangeReviewExternalChangeController;
const viewPorts = {
  bulkDecision: {
    editor: { kind: 'bulk-editor' },
    status: { kind: 'bulk-status' },
    writeEvidence: { kind: 'bulk-write' },
  },
  fileDecision: {
    editor: { kind: 'file-editor' },
    status: { kind: 'file-status' },
    writeEvidence: { kind: 'file-write' },
  },
  hunkDecision: {
    editor: { kind: 'hunk-editor' },
    status: { kind: 'hunk-status' },
    writeEvidence: { kind: 'hunk-write' },
  },
} as unknown as ChangeReviewDialogViewPorts;

let latest: ReturnType<typeof useChangeReviewDecisionActions> | null = null;

function Probe(): React.JSX.Element {
  latest = useChangeReviewDecisionActions({
    activeChangeSet: { files: [file] },
    fileContents: { [file.filePath]: fileContent },
    fileChunkCounts: {},
    rejectableFiles: [file],
    canAcceptAll: true,
    changeSetEpoch: 3,
    teamName: 'team-a',
    taskId: 'task-a',
    memberName: undefined,
    reviewScope: { teamName: 'team-a', taskId: 'task-a' },
    decisionScopeKey: 'task-task-a',
    decisionScopeToken: 'token-a',
    editorViewMapRef,
    readCurrentDiskContent: (_filePath, fallback) => Promise.resolve(fallback),
    hasDraft: () => false,
    history,
    persistence,
    mutationGuards,
    operation,
    externalChange,
    viewPorts,
  });
  return <div />;
}

describe('useChangeReviewDecisionActions', () => {
  afterEach(() => {
    latest = null;
    document.body.innerHTML = '';
    vi.clearAllMocks();
    vi.unstubAllGlobals();
  });

  it('wires bulk, file and hunk decision controllers to one review scope', async () => {
    vi.stubGlobal('IS_REACT_ACT_ENVIRONMENT', true);
    const root = createRoot(document.body.appendChild(document.createElement('div')));

    await act(async () => {
      root.render(<Probe />);
      await Promise.resolve();
    });

    expect(latest).toEqual({
      acceptAll: decisionMocks.acceptAll,
      rejectAll: decisionMocks.rejectAll,
      acceptFile: decisionMocks.acceptFile,
      rejectFile: decisionMocks.rejectFile,
      acceptHunk: decisionMocks.acceptHunk,
      rejectHunk: decisionMocks.rejectHunk,
    });
    expect(decisionMocks.useBulkController).toHaveBeenCalledWith(
      expect.objectContaining({
        active: true,
        files: [file],
        history,
        persistLatestAcceptedAction: persistence.persistLatest,
        ensureDurableScope: mutationGuards.ensureDurableReviewScope,
      })
    );
    const bulkInput = decisionMocks.useBulkController.mock.calls[0]?.[0] as {
      buildRejectDiskSnapshot: (
        file: FileChangeSummary,
        decisionSnapshot: ReviewDecisionSnapshot
      ) => ReviewDiskUndoSnapshot | null;
    };
    expect(
      bulkInput.buildRejectDiskSnapshot(file, {
        hunkDecisions: {},
        fileDecisions: {},
      })
    ).toMatchObject({
      filePath: file.filePath,
      beforeContent: 'current editor content',
      afterContent: null,
      file,
      restoreMode: 'create-file',
      fileIndex: 0,
    });
    expect(decisionMocks.useFileController).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [file],
        persistenceScope: {
          teamName: 'team-a',
          scopeKey: 'task-task-a',
          scopeToken: 'token-a',
        },
        history,
        blockForExternalChange: externalChange.blockReviewMutationForExternalChange,
      })
    );
    expect(decisionMocks.useHunkController).toHaveBeenCalledWith(
      expect.objectContaining({
        files: [file],
        captureOperationScope: operation.captureReviewOperationScope,
        isCurrentOperationScope: operation.isCurrentReviewOperationScope,
        historyPort: {
          pushUndoAction: history.pushUndoAction,
          bindCommittedAction: history.bindCommittedAction,
          discardLatestAction: history.discardLatestAction,
          publishUndoHistory: history.publishUndoHistory,
        },
      })
    );

    await act(async () => {
      root.unmount();
      await Promise.resolve();
    });
  });
});
