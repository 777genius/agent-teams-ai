import { useCallback } from 'react';

import { restoreReviewDecisionRecordsForFile } from '@features/review-mutations';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';

import type {
  BuildBulkRejectDiskSnapshot,
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionViewPort,
} from '../ports/changeReviewBulkDecisionPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ChangeReviewActionHistoryController } from './useChangeReviewActionHistoryController';
import type {
  FileChangeSummary,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
  ReviewUndoAction,
} from '@shared/types';

type ActionHistory = Pick<
  ChangeReviewActionHistoryController,
  | 'pushUndoAction'
  | 'bindCommittedAction'
  | 'discardLatestAction'
  | 'getLatestUndoAction'
  | 'publishUndoHistory'
>;

interface UseChangeReviewBulkDecisionControllerInput {
  active: boolean;
  files: readonly FileChangeSummary[];
  rejectableFiles: readonly FileChangeSummary[];
  canAcceptAll: boolean;
  changeSetEpoch: number;
  instantApply: boolean;
  teamName: string;
  taskId: string | undefined;
  memberName: string | undefined;
  history: ActionHistory;
  statePort: ChangeReviewBulkDecisionStatePort;
  commandPort: ChangeReviewBulkDecisionCommandPort;
  viewPort: ChangeReviewBulkDecisionViewPort;
  buildRejectDiskSnapshot: BuildBulkRejectDiskSnapshot;
  persistLatestAcceptedAction: () => Promise<unknown>;
  ensureDurableScope: () => boolean;
  hasActionInFlight: () => boolean;
  blockForExternalChange: () => boolean;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
}

export interface ChangeReviewBulkDecisionController {
  acceptAll: () => void;
  rejectAll: () => void;
}

function isLedgerRenameReviewFile(file: FileChangeSummary | undefined): boolean {
  return Boolean(file?.snippets.some((snippet) => snippet.ledger?.relation?.kind === 'rename'));
}

function alignDiskUndoSnapshotWithAppliedContent(
  snapshot: ReviewDiskUndoSnapshot,
  appliedContent: string
): void {
  if (snapshot.afterContent === null) return;
  const merged = threeWayTextMerge(snapshot.afterContent, appliedContent, snapshot.beforeContent);
  snapshot.afterContent = appliedContent;
  if (merged.hasConflicts) {
    snapshot.restoreConflict =
      'Undo conflicts with edits that were preserved while applying the rejection.';
    return;
  }
  snapshot.beforeContent = merged.content;
}

function reconcileDecisionRecordsAfterApply(
  files: readonly FileChangeSummary[],
  errorPaths: readonly string[] | null,
  current: ReviewDecisionSnapshot,
  snapshot: ReviewDecisionSnapshot
): ReviewDecisionSnapshot & {
  successful: FileChangeSummary[];
  failed: FileChangeSummary[];
} {
  const normalizedErrors = new Set((errorPaths ?? []).map(normalizePathForComparison));
  const requestedPaths = new Set(files.map((file) => normalizePathForComparison(file.filePath)));
  const hasUnknownError =
    errorPaths === null || [...normalizedErrors].some((filePath) => !requestedPaths.has(filePath));
  const successful = hasUnknownError
    ? []
    : files.filter((file) => !normalizedErrors.has(normalizePathForComparison(file.filePath)));
  const failed = hasUnknownError
    ? [...files]
    : files.filter((file) => normalizedErrors.has(normalizePathForComparison(file.filePath)));
  const reconciled = failed.reduce(
    (decisions, file) => restoreReviewDecisionRecordsForFile(file, decisions, snapshot),
    current
  );
  return { ...reconciled, successful, failed };
}

function updateRetainedRejectAllDescriptor(
  preparedAction: ReviewUndoAction,
  retainedAction: ReviewUndoAction | undefined,
  retainedSnapshotCount: number
): void {
  if (
    retainedAction?.id !== preparedAction.id ||
    retainedAction.kind !== 'bulk' ||
    retainedAction.descriptor?.intent !== 'reject-all'
  ) {
    return;
  }
  retainedAction.descriptor = { intent: 'reject-all', fileCount: retainedSnapshotCount };
}

export function useChangeReviewBulkDecisionController({
  active,
  files,
  rejectableFiles,
  canAcceptAll,
  changeSetEpoch,
  instantApply,
  teamName,
  taskId,
  memberName,
  history,
  statePort,
  commandPort,
  viewPort,
  buildRejectDiskSnapshot,
  persistLatestAcceptedAction,
  ensureDurableScope,
  hasActionInFlight,
  blockForExternalChange,
  captureOperationScope,
  isCurrentOperationScope,
}: UseChangeReviewBulkDecisionControllerInput): ChangeReviewBulkDecisionController {
  const acceptAll = useCallback((): void => {
    if (!active || !canAcceptAll || hasActionInFlight() || blockForExternalChange()) {
      return;
    }
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    const state = statePort.getSnapshot();
    const decisionSnapshot: ReviewDecisionSnapshot = {
      hunkDecisions: { ...state.hunkDecisions },
      fileDecisions: { ...state.fileDecisions },
    };
    const acceptedFiles = new Set<string>();
    for (const file of files) {
      if (file.filePath in state.editedContents) continue;
      if (statePort.acceptAllFile(file.filePath)) acceptedFiles.add(file.filePath);
    }
    if (acceptedFiles.size === 0) return;
    history.pushUndoAction({
      kind: 'bulk',
      descriptor: { intent: 'accept-all', fileCount: acceptedFiles.size },
      decisionSnapshot,
      diskSnapshots: [],
    });
    void persistLatestAcceptedAction();
    viewPort.scheduleEditorSync(() => {
      if (isCurrentOperationScope(operationScope)) {
        viewPort.acceptAllEditorChunks(acceptedFiles);
      }
    });
  }, [
    active,
    blockForExternalChange,
    canAcceptAll,
    captureOperationScope,
    files,
    hasActionInFlight,
    history,
    isCurrentOperationScope,
    persistLatestAcceptedAction,
    statePort,
    viewPort,
  ]);

  const rejectAll = useCallback((): void => {
    if (!active || hasActionInFlight() || blockForExternalChange()) return;
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    const initialState = statePort.getSnapshot();
    const requestedFiles = rejectableFiles.filter(
      (file) => !(file.filePath in initialState.editedContents)
    );
    const requestedPaths = new Set(requestedFiles.map((file) => file.filePath));
    if (requestedPaths.size === 0) return;
    const decisionSnapshot: ReviewDecisionSnapshot = {
      hunkDecisions: { ...initialState.hunkDecisions },
      fileDecisions: { ...initialState.fileDecisions },
    };
    const diskSnapshots = requestedFiles.flatMap((file) => {
      const snapshot = buildRejectDiskSnapshot(file, decisionSnapshot);
      return snapshot ? [snapshot] : [];
    });
    for (const file of requestedFiles) {
      viewPort.beginFileMutation(file.filePath);
      statePort.rejectAllFile(file.filePath);
    }
    const preparedAction = history.pushUndoAction({
      kind: 'bulk',
      descriptor: { intent: 'reject-all', fileCount: requestedFiles.length },
      decisionSnapshot,
      diskSnapshots,
    });
    viewPort.markFilesApplying(requestedPaths);
    viewPort.scheduleEditorSync(() => {
      if (isCurrentOperationScope(operationScope)) {
        viewPort.rejectAllEditorChunks(requestedPaths);
      }
    });

    if (!instantApply) {
      for (const file of requestedFiles) {
        viewPort.finishFileMutation(file.filePath);
      }
      viewPort.clearFilesApplying(requestedPaths);
      return;
    }

    void (async () => {
      try {
        if (!isCurrentOperationScope(operationScope)) return;
        if (!ensureDurableScope()) {
          statePort.restoreDecisionSnapshot(decisionSnapshot);
          for (const snapshot of diskSnapshots) {
            viewPort.rollbackEditorContent(snapshot.filePath, snapshot.beforeContent);
          }
          history.discardLatestAction(preparedAction);
          return;
        }
        for (const snapshot of diskSnapshots) {
          viewPort.markExpectedWrite(
            snapshot.filePath,
            isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
          );
        }
        const result = await commandPort.applyReview(teamName, taskId, memberName);
        const currentState = statePort.getSnapshot();
        if (
          !isCurrentOperationScope(operationScope) ||
          currentState.changeSetEpoch !== changeSetEpoch
        ) {
          return;
        }
        viewPort.markCommittedPostimages(result?.diskPostimages);
        history.bindCommittedAction(preparedAction, result?.committedReviewAction);
        const reconciliation = reconcileDecisionRecordsAfterApply(
          requestedFiles,
          result ? result.errors.map((entry) => entry.filePath) : null,
          {
            hunkDecisions: currentState.hunkDecisions,
            fileDecisions: currentState.fileDecisions,
          },
          decisionSnapshot
        );
        statePort.restoreDecisionSnapshot(reconciliation);
        const failedPaths = new Set(
          reconciliation.failed.map((file) => normalizePathForComparison(file.filePath))
        );

        for (const file of reconciliation.failed) {
          const beforeContent = diskSnapshots.find(
            (snapshot) => snapshot.filePath === file.filePath
          )?.beforeContent;
          if (beforeContent !== undefined) {
            viewPort.rollbackEditorContent(file.filePath, beforeContent);
          }
          statePort.invalidateResolvedFileContent(file.filePath);
          viewPort.incrementDiscardCounter(file.filePath);
          commandPort.fetchFileContent(teamName, memberName, file.filePath);
        }

        for (let index = diskSnapshots.length - 1; index >= 0; index--) {
          if (failedPaths.has(normalizePathForComparison(diskSnapshots[index].filePath))) {
            diskSnapshots.splice(index, 1);
          }
        }

        if (reconciliation.successful.length === 0) {
          history.discardLatestAction(preparedAction);
          return;
        }
        updateRetainedRejectAllDescriptor(
          preparedAction,
          history.getLatestUndoAction(),
          diskSnapshots.length
        );

        viewPort.setUndoInFlight(true);
        await Promise.all(
          diskSnapshots.map(async (snapshot) => {
            if (
              snapshot.afterContent === null ||
              snapshot.restoreMode === 'delete-file' ||
              isLedgerRenameReviewFile(snapshot.file)
            ) {
              return;
            }
            const appliedContent = await commandPort.readCurrentDiskContent(
              snapshot.filePath,
              snapshot.afterContent
            );
            alignDiskUndoSnapshotWithAppliedContent(snapshot, appliedContent);
          })
        );

        const refreshedState = statePort.getSnapshot();
        if (
          !isCurrentOperationScope(operationScope) ||
          refreshedState.changeSetEpoch !== changeSetEpoch
        ) {
          return;
        }
        for (const file of reconciliation.successful) {
          const snapshot = diskSnapshots.find(
            (candidate) =>
              normalizePathForComparison(candidate.filePath) ===
              normalizePathForComparison(file.filePath)
          );
          if (snapshot) {
            viewPort.markExpectedWrite(
              file.filePath,
              isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
            );
          }
        }
        history.publishUndoHistory();
      } finally {
        const currentState = statePort.getSnapshot();
        if (
          isCurrentOperationScope(operationScope) &&
          currentState.changeSetEpoch === changeSetEpoch
        ) {
          for (const file of requestedFiles) {
            viewPort.finishFileMutation(file.filePath);
          }
          viewPort.clearFilesApplying(requestedPaths);
          viewPort.setUndoInFlight(false);
        }
      }
    })();
  }, [
    active,
    blockForExternalChange,
    buildRejectDiskSnapshot,
    captureOperationScope,
    changeSetEpoch,
    commandPort,
    ensureDurableScope,
    hasActionInFlight,
    history,
    instantApply,
    isCurrentOperationScope,
    memberName,
    rejectableFiles,
    statePort,
    taskId,
    teamName,
    viewPort,
  ]);

  return { acceptAll, rejectAll };
}
