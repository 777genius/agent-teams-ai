import { Transaction } from '@codemirror/state';
import { serializeReviewDraftEditorState } from '@features/change-review-history/renderer';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import { markChangeReviewMutationDiskPostimages } from '../utils/changeReviewWriteEvidence';

import type {
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
} from '../ports/changeReviewBulkDecisionPorts';
import type {
  ChangeReviewDialogLifecycleEditorPort,
  ChangeReviewDialogLifecycleSessionPort,
  ChangeReviewDialogLifecycleStatusPort,
  ChangeReviewDialogLifecycleWriteEvidencePort,
} from '../ports/changeReviewDialogLifecyclePorts';
import type {
  ChangeReviewFileDecisionEditorPort,
  ChangeReviewFileDecisionStatusPort,
  ChangeReviewFileDecisionWriteEvidencePort,
} from '../ports/changeReviewFileDecisionPorts';
import type {
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
} from '../ports/changeReviewFileDraftPorts';
import type { ChangeReviewHistoryMutationViewPort } from '../ports/changeReviewHistoryMutationPorts';
import type {
  ChangeReviewHunkDecisionEditorPort,
  ChangeReviewHunkDecisionStatusPort,
  ChangeReviewHunkDecisionWriteEvidencePort,
} from '../ports/changeReviewHunkDecisionPorts';
import type { EditorView } from '@codemirror/view';
import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewMutationDiskPostimage,
  ReviewUndoAction,
} from '@shared/types';
import type { Dispatch, MutableRefObject, SetStateAction } from 'react';

export interface ChangeReviewRecentWrite {
  at: number;
  expectedContent: string | null;
}

interface FileMutationStatusDependencies {
  fileApplyInFlightRef: MutableRefObject<Set<string>>;
  setFilesApplying: Dispatch<SetStateAction<Set<string>>>;
  setDiscardCounters: Dispatch<SetStateAction<Record<string, number>>>;
}

interface LifecycleStatusDependencies {
  undoInFlightRef: MutableRefObject<boolean>;
  closingRef: MutableRefObject<boolean>;
  pendingApplyCleanupKeyRef: MutableRefObject<string | null>;
  expectedDraftHistoryKeyRef: MutableRefObject<string | null>;
  setUndoing: Dispatch<SetStateAction<boolean>>;
  setClosing: Dispatch<SetStateAction<boolean>>;
}

interface CreateChangeReviewDialogViewPortsInput
  extends FileMutationStatusDependencies, LifecycleStatusDependencies {
  editorViewMapRef: MutableRefObject<Map<string, EditorView>>;
  editorActions: {
    acceptAllChunks: (view: EditorView) => boolean;
    ignoreNextDocChange: (view: EditorView) => void;
    rejectAllChunks: (view: EditorView) => boolean;
    rejectChunk: (view: EditorView) => boolean;
  };
  recentReviewWritesRef: MutableRefObject<Map<string, ChangeReviewRecentWrite>>;
  handleSerializedStateChanged: (
    filePath: string,
    editorState: ReviewSerializedEditorState
  ) => void;
  addReviewFile: (
    file: FileChangeSummary,
    options?: { index?: number; content?: FileChangeWithContent }
  ) => void;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  navigateToHistoryAction: (action: ReviewUndoAction) => void;
}

export interface ChangeReviewDialogViewPorts {
  bulkDecision: {
    editor: ChangeReviewBulkDecisionEditorPort;
    status: ChangeReviewBulkDecisionStatusPort;
    writeEvidence: ChangeReviewBulkDecisionWriteEvidencePort;
  };
  fileDecision: {
    editor: ChangeReviewFileDecisionEditorPort;
    status: ChangeReviewFileDecisionStatusPort;
    writeEvidence: ChangeReviewFileDecisionWriteEvidencePort;
  };
  fileDraft: {
    status: ChangeReviewFileDraftStatusPort;
    writeEvidence: ChangeReviewFileDraftWriteEvidencePort;
  };
  historyMutation: ChangeReviewHistoryMutationViewPort;
  hunkDecision: {
    editor: ChangeReviewHunkDecisionEditorPort;
    status: ChangeReviewHunkDecisionStatusPort;
    writeEvidence: ChangeReviewHunkDecisionWriteEvidencePort;
  };
  lifecycle: {
    editor: ChangeReviewDialogLifecycleEditorPort;
    session: ChangeReviewDialogLifecycleSessionPort;
    status: ChangeReviewDialogLifecycleStatusPort;
    writeEvidence: ChangeReviewDialogLifecycleWriteEvidencePort;
  };
}

export function createChangeReviewDialogViewPorts({
  editorViewMapRef,
  editorActions,
  fileApplyInFlightRef,
  undoInFlightRef,
  closingRef,
  pendingApplyCleanupKeyRef,
  expectedDraftHistoryKeyRef,
  recentReviewWritesRef,
  setFilesApplying,
  setDiscardCounters,
  setUndoing,
  setClosing,
  handleSerializedStateChanged,
  addReviewFile,
  fetchFileContent,
  navigateToHistoryAction,
}: CreateChangeReviewDialogViewPortsInput): ChangeReviewDialogViewPorts {
  const scheduleEditorSync = (callback: () => void): void => {
    requestAnimationFrame(callback);
  };
  const rollbackEditorContent = (filePath: string, content: string): void => {
    const view = editorViewMapRef.current.get(filePath);
    if (!view?.dom.isConnected) return;
    editorActions.ignoreNextDocChange(view);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: Transaction.addToHistory.of(false),
    });
  };
  const markExpectedWrite = (filePath: string, expectedContent: string | null): void => {
    recentReviewWritesRef.current.set(normalizePathForComparison(filePath), {
      at: Date.now(),
      expectedContent,
    });
  };
  const clearExpectedWrite = (filePath: string): void => {
    recentReviewWritesRef.current.delete(normalizePathForComparison(filePath));
  };
  const markCommittedPostimages = (
    postimages: readonly ReviewMutationDiskPostimage[] | undefined
  ): void => {
    markChangeReviewMutationDiskPostimages(postimages, markExpectedWrite);
  };
  const setFileApplying = (filePath: string, value: boolean): void => {
    setFilesApplying((previous) => {
      const next = new Set(previous);
      if (value) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  };
  const beginFileMutation = (filePath: string): void => {
    fileApplyInFlightRef.current.add(filePath);
    setFileApplying(filePath, true);
  };
  const finishFileMutation = (filePath: string): void => {
    fileApplyInFlightRef.current.delete(filePath);
    setFileApplying(filePath, false);
  };
  const incrementDiscardCounter = (filePath: string): void => {
    setDiscardCounters((previous) => ({
      ...previous,
      [filePath]: (previous[filePath] ?? 0) + 1,
    }));
  };
  const setUndoInFlight = (value: boolean): void => {
    undoInFlightRef.current = value;
    setUndoing(value);
  };

  const writeEvidence = {
    markExpectedWrite,
    clearExpectedWrite,
    markCommittedPostimages,
  };
  const trackedFileStatus = {
    beginFileMutation,
    finishFileMutation,
    incrementDiscardCounter,
  };

  return {
    bulkDecision: {
      editor: {
        scheduleEditorSync,
        acceptAllEditorChunks: (filePaths) => {
          for (const [filePath, view] of editorViewMapRef.current.entries()) {
            if (filePaths.has(filePath)) editorActions.acceptAllChunks(view);
          }
        },
        rejectAllEditorChunks: (filePaths) => {
          for (const [filePath, view] of editorViewMapRef.current.entries()) {
            if (filePaths.has(filePath)) editorActions.rejectAllChunks(view);
          }
        },
        rollbackEditorContent,
      },
      writeEvidence,
      status: {
        beginFileMutation: (filePath) => fileApplyInFlightRef.current.add(filePath),
        finishFileMutation: (filePath) => fileApplyInFlightRef.current.delete(filePath),
        markFilesApplying: (filePaths) => {
          setFilesApplying((previous) => {
            const next = new Set(previous);
            for (const filePath of filePaths) next.add(filePath);
            return next;
          });
        },
        clearFilesApplying: (filePaths) => {
          setFilesApplying((previous) => {
            const next = new Set(previous);
            for (const filePath of filePaths) next.delete(filePath);
            return next;
          });
        },
        incrementDiscardCounter,
        setUndoInFlight,
      },
    },
    fileDecision: {
      editor: {
        getCurrentContent: (filePath) =>
          editorViewMapRef.current.get(filePath)?.state.doc.toString() ?? null,
        scheduleEditorSync,
        acceptAllEditorChunks: (filePath) => {
          const view = editorViewMapRef.current.get(filePath);
          if (view) editorActions.acceptAllChunks(view);
        },
        rejectAllEditorChunks: (filePath) => {
          const view = editorViewMapRef.current.get(filePath);
          if (view) editorActions.rejectAllChunks(view);
        },
        rollbackEditorContent,
      },
      status: trackedFileStatus,
      writeEvidence,
    },
    fileDraft: {
      status: trackedFileStatus,
      writeEvidence: { markExpectedWrite },
    },
    historyMutation: {
      addMissingFile: (file, index, content) =>
        addReviewFile(file, {
          index,
          content: {
            ...file,
            originalFullContent: '',
            modifiedFullContent: content,
            isNewFile: true,
            contentSource: 'disk-current',
          },
        }),
      fetchFileContent: (teamName, memberName, filePath) => {
        void fetchFileContent(teamName, memberName, filePath);
      },
      incrementDiscardCounters: (filePaths) => {
        setDiscardCounters((previous) => {
          const next = { ...previous };
          for (const filePath of filePaths) {
            next[filePath] = (next[filePath] ?? 0) + 1;
          }
          return next;
        });
      },
      navigateToAction: navigateToHistoryAction,
      markExpectedWrite,
      clearExpectedWrite,
      markCommittedPostimages,
      setMutationInFlight: setUndoInFlight,
    },
    hunkDecision: {
      editor: {
        guardIgnoredMutation: (filePath) => {
          const view = editorViewMapRef.current.get(filePath);
          const guardedContent = view?.state.doc.toString();
          if (view && guardedContent !== undefined) {
            queueMicrotask(() => {
              if (view.dom.isConnected && view.state.doc.toString() !== guardedContent) {
                rollbackEditorContent(filePath, guardedContent);
              }
            });
          }
        },
        rejectChunk: (filePath) => {
          const view = editorViewMapRef.current.get(filePath);
          if (!view?.dom.isConnected) return null;
          const beforeContent = view.state.doc.toString();
          if (!editorActions.rejectChunk(view)) return null;
          return {
            beforeContent,
            afterContent: view.state.doc.toString(),
          };
        },
        rollbackContent: rollbackEditorContent,
      },
      status: trackedFileStatus,
      writeEvidence,
    },
    lifecycle: {
      editor: {
        captureDraftSnapshots: (shouldCapture) => {
          for (const [filePath, view] of editorViewMapRef.current.entries()) {
            if (shouldCapture(filePath)) {
              handleSerializedStateChanged(filePath, serializeReviewDraftEditorState(view.state));
            }
          }
        },
      },
      session: {
        getPendingApplyCleanupKey: () => pendingApplyCleanupKeyRef.current,
        setPendingApplyCleanupKey: (key) => {
          pendingApplyCleanupKeyRef.current = key;
        },
        isExpectedHydrationKey: (hydrationKey) =>
          expectedDraftHistoryKeyRef.current === hydrationKey,
      },
      status: {
        getActionLockState: (applying) => ({
          applying,
          fileApplyCount: fileApplyInFlightRef.current.size,
          undoing: undoInFlightRef.current,
          closing: closingRef.current,
        }),
        beginClosing: () => {
          closingRef.current = true;
          setClosing(true);
        },
        finishClosing: () => {
          closingRef.current = false;
          setClosing(false);
        },
        setRecoveryInFlight: setUndoInFlight,
      },
      writeEvidence: { markCommittedPostimages },
    },
  };
}
