import { useCallback, useMemo } from 'react';

import { resolveChangeReviewFileHunkCount } from '@features/change-review';
import {
  createChangeReviewBulkDecisionCommandPort,
  createChangeReviewFileDecisionCommandPort,
  createChangeReviewHunkDecisionCommandPort,
  useChangeReviewBulkDecisionController,
  useChangeReviewFileDecisionController,
  useChangeReviewHunkDecisionController,
} from '@features/change-review/renderer';
import { api } from '@renderer/api';
import { useStore } from '@renderer/store';
import { REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';

import {
  changeReviewBulkDecisionStatePort,
  changeReviewFileDecisionPolicy,
  changeReviewFileDecisionStatePort,
  changeReviewHunkDecisionPolicy,
  changeReviewHunkDecisionStatePort,
} from './changeReviewDialogComposition';
import {
  getReviewRenameRecoveryExpectation,
  resolveReviewFileIsNew,
  shouldDeleteFileWhenUndoingReject,
} from './reviewActionState';
import { getResolvedReviewModifiedContent } from './reviewContentPreview';

import type { EditorView } from '@codemirror/view';
import type {
  ChangeReviewActionHistoryController,
  ChangeReviewBulkDecisionController,
  ChangeReviewDecisionPersistenceController,
  ChangeReviewDialogViewPorts,
  ChangeReviewExternalChangeController,
  ChangeReviewFileDecisionController,
  ChangeReviewHunkDecisionController,
  ChangeReviewMutationGuards,
  ChangeReviewOperationState,
} from '@features/change-review/renderer';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
  ReviewFileScope,
} from '@shared/types';
import type { RefObject } from 'react';

interface ChangeReviewDecisionChangeSet {
  files: FileChangeSummary[];
}

type ChangeReviewDecisionHistory = Pick<
  ChangeReviewActionHistoryController,
  | 'pushUndoAction'
  | 'bindCommittedAction'
  | 'discardLatestAction'
  | 'getLatestUndoAction'
  | 'getUndoHistory'
  | 'getRedoHistory'
  | 'publishUndoHistory'
>;

type ChangeReviewDecisionPersistence = Pick<
  ChangeReviewDecisionPersistenceController,
  'persistLatest'
>;

type ChangeReviewDecisionMutationGuards = Pick<
  ChangeReviewMutationGuards,
  'ensureDurableReviewScope' | 'hasReviewActionInFlight'
>;

type ChangeReviewDecisionOperation = Pick<
  ChangeReviewOperationState,
  'captureReviewOperationScope' | 'isCurrentReviewOperationScope'
>;

type ChangeReviewDecisionExternalChange = Pick<
  ChangeReviewExternalChangeController,
  'blockReviewMutationForExternalChange'
>;

type ChangeReviewDecisionViewPorts = Pick<
  ChangeReviewDialogViewPorts,
  'bulkDecision' | 'fileDecision' | 'hunkDecision'
>;

interface UseChangeReviewDecisionActionsInput {
  activeChangeSet: ChangeReviewDecisionChangeSet | null;
  fileContents: Record<string, FileChangeWithContent>;
  fileChunkCounts: Record<string, number>;
  rejectableFiles: readonly FileChangeSummary[];
  canAcceptAll: boolean;
  changeSetEpoch: number;
  teamName: string;
  taskId: string | undefined;
  memberName: string | undefined;
  reviewScope: ReviewFileScope;
  decisionScopeKey: string;
  decisionScopeToken: string | null;
  editorViewMapRef: RefObject<Map<string, EditorView>>;
  readCurrentDiskContent: (filePath: string, fallback: string) => Promise<string>;
  hasDraft: (filePath: string) => boolean;
  history: ChangeReviewDecisionHistory;
  persistence: ChangeReviewDecisionPersistence;
  mutationGuards: ChangeReviewDecisionMutationGuards;
  operation: ChangeReviewDecisionOperation;
  externalChange: ChangeReviewDecisionExternalChange;
  viewPorts: ChangeReviewDecisionViewPorts;
}

export interface ChangeReviewDecisionActions {
  acceptAll: ChangeReviewBulkDecisionController['acceptAll'];
  rejectAll: ChangeReviewBulkDecisionController['rejectAll'];
  acceptFile: ChangeReviewFileDecisionController['acceptFile'];
  rejectFile: ChangeReviewFileDecisionController['rejectFile'];
  acceptHunk: ChangeReviewHunkDecisionController['acceptHunk'];
  rejectHunk: ChangeReviewHunkDecisionController['rejectHunk'];
}

export function useChangeReviewDecisionActions({
  activeChangeSet,
  fileContents,
  fileChunkCounts,
  rejectableFiles,
  canAcceptAll,
  changeSetEpoch,
  teamName,
  taskId,
  memberName,
  reviewScope,
  decisionScopeKey,
  decisionScopeToken,
  editorViewMapRef,
  readCurrentDiskContent,
  hasDraft,
  history,
  persistence,
  mutationGuards,
  operation,
  externalChange,
  viewPorts,
}: UseChangeReviewDecisionActionsInput): ChangeReviewDecisionActions {
  const buildBulkRejectDiskSnapshot = useCallback(
    (
      file: FileChangeSummary,
      decisionSnapshot: ReviewDecisionSnapshot
    ): ReviewDiskUndoSnapshot | null => {
      const content = fileContents[file.filePath] ?? null;
      const isNewFile = resolveReviewFileIsNew(file, content);
      const hunkCount = resolveChangeReviewFileHunkCount(
        file.filePath,
        file.snippets.length,
        fileChunkCounts
      );
      const shouldDeleteOnUndo = shouldDeleteFileWhenUndoingReject(
        file,
        hunkCount,
        decisionSnapshot
      );
      const beforeContent =
        editorViewMapRef.current.get(file.filePath)?.state.doc.toString() ??
        getResolvedReviewModifiedContent(file, content);
      const afterContent = isNewFile ? null : (content?.originalFullContent ?? null);
      if (beforeContent == null || (afterContent == null && !isNewFile)) return null;
      return {
        filePath: file.filePath,
        beforeContent,
        afterContent,
        file,
        restoreMode: isNewFile ? 'create-file' : shouldDeleteOnUndo ? 'delete-file' : undefined,
        renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
        fileIndex: isNewFile
          ? activeChangeSet?.files.findIndex((candidate) => candidate.filePath === file.filePath)
          : undefined,
      };
    },
    [activeChangeSet, editorViewMapRef, fileChunkCounts, fileContents]
  );
  const bulkCommandPort = useMemo(
    () =>
      createChangeReviewBulkDecisionCommandPort({
        getStore: useStore.getState,
        readCurrentDiskContent,
      }),
    [readCurrentDiskContent]
  );
  const bulk = useChangeReviewBulkDecisionController({
    active: activeChangeSet !== null,
    files: activeChangeSet?.files ?? [],
    rejectableFiles,
    canAcceptAll,
    changeSetEpoch,
    instantApply: REVIEW_INSTANT_APPLY,
    teamName,
    taskId,
    memberName,
    history,
    statePort: changeReviewBulkDecisionStatePort,
    commandPort: bulkCommandPort,
    editorPort: viewPorts.bulkDecision.editor,
    statusPort: viewPorts.bulkDecision.status,
    writeEvidencePort: viewPorts.bulkDecision.writeEvidence,
    buildRejectDiskSnapshot: buildBulkRejectDiskSnapshot,
    persistLatestAcceptedAction: persistence.persistLatest,
    ensureDurableScope: mutationGuards.ensureDurableReviewScope,
    hasActionInFlight: mutationGuards.hasReviewActionInFlight,
    blockForExternalChange: externalChange.blockReviewMutationForExternalChange,
    captureOperationScope: operation.captureReviewOperationScope,
    isCurrentOperationScope: operation.isCurrentReviewOperationScope,
  });

  const fileCommandPort = useMemo(
    () =>
      createChangeReviewFileDecisionCommandPort({
        getStore: useStore.getState,
        getReviewApi: () => api.review,
        readCurrentDiskContent,
      }),
    [readCurrentDiskContent]
  );
  const file = useChangeReviewFileDecisionController({
    files: activeChangeSet?.files ?? [],
    fileContents,
    changeSetEpoch,
    instantApply: REVIEW_INSTANT_APPLY,
    teamName,
    taskId,
    memberName,
    reviewScope,
    persistenceScope: decisionScopeToken
      ? { teamName, scopeKey: decisionScopeKey, scopeToken: decisionScopeToken }
      : null,
    history,
    statePort: changeReviewFileDecisionStatePort,
    commandPort: fileCommandPort,
    editorPort: viewPorts.fileDecision.editor,
    statusPort: viewPorts.fileDecision.status,
    writeEvidencePort: viewPorts.fileDecision.writeEvidence,
    policy: changeReviewFileDecisionPolicy,
    persistLatestAcceptedAction: persistence.persistLatest,
    ensureDurableScope: mutationGuards.ensureDurableReviewScope,
    hasDraft,
    hasActionInFlight: mutationGuards.hasReviewActionInFlight,
    blockForExternalChange: externalChange.blockReviewMutationForExternalChange,
    captureOperationScope: operation.captureReviewOperationScope,
    isCurrentOperationScope: operation.isCurrentReviewOperationScope,
  });

  const hunkCommandPort = useMemo(
    () =>
      createChangeReviewHunkDecisionCommandPort({
        getStore: useStore.getState,
        readCurrentDiskContent,
      }),
    [readCurrentDiskContent]
  );
  const hunkHistoryPort = useMemo(
    () => ({
      pushUndoAction: history.pushUndoAction,
      bindCommittedAction: history.bindCommittedAction,
      discardLatestAction: history.discardLatestAction,
      publishUndoHistory: history.publishUndoHistory,
    }),
    [
      history.bindCommittedAction,
      history.discardLatestAction,
      history.publishUndoHistory,
      history.pushUndoAction,
    ]
  );
  const hunk = useChangeReviewHunkDecisionController({
    files: activeChangeSet?.files ?? [],
    fileContents,
    changeSetEpoch,
    instantApply: REVIEW_INSTANT_APPLY,
    teamName,
    taskId,
    memberName,
    statePort: changeReviewHunkDecisionStatePort,
    commandPort: hunkCommandPort,
    editorPort: viewPorts.hunkDecision.editor,
    statusPort: viewPorts.hunkDecision.status,
    historyPort: hunkHistoryPort,
    writeEvidencePort: viewPorts.hunkDecision.writeEvidence,
    policy: changeReviewHunkDecisionPolicy,
    persistLatestAcceptedAction: persistence.persistLatest,
    ensureDurableScope: mutationGuards.ensureDurableReviewScope,
    hasDraft,
    hasActionInFlight: mutationGuards.hasReviewActionInFlight,
    blockForExternalChange: externalChange.blockReviewMutationForExternalChange,
    captureOperationScope: operation.captureReviewOperationScope,
    isCurrentOperationScope: operation.isCurrentReviewOperationScope,
  });

  return {
    acceptAll: bulk.acceptAll,
    rejectAll: bulk.rejectAll,
    acceptFile: file.acceptFile,
    rejectFile: file.rejectFile,
    acceptHunk: hunk.acceptHunk,
    rejectHunk: hunk.rejectHunk,
  };
}
