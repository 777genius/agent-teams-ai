import { useCallback } from 'react';

import {
  alignReviewDiskUndoSnapshotWithAppliedContent,
  isLedgerRenameReviewFile,
  reconcileReviewDecisionRecordsAfterApply,
} from '@features/review-mutations';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  BuildBulkRejectDiskSnapshot,
  ChangeReviewBulkDecisionCommandPort,
  ChangeReviewBulkDecisionEditorPort,
  ChangeReviewBulkDecisionStatePort,
  ChangeReviewBulkDecisionStatusPort,
  ChangeReviewBulkDecisionWriteEvidencePort,
} from '../ports/changeReviewBulkDecisionPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ChangeReviewActionHistoryController } from './useChangeReviewActionHistoryController';
import type {
  ApplyReviewResult,
  FileChangeSummary,
  ReviewDecisionSnapshot,
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
  editorPort: ChangeReviewBulkDecisionEditorPort;
  statusPort: ChangeReviewBulkDecisionStatusPort;
  writeEvidencePort: ChangeReviewBulkDecisionWriteEvidencePort;
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
  editorPort,
  statusPort,
  writeEvidencePort,
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
    editorPort.scheduleEditorSync(() => {
      if (isCurrentOperationScope(operationScope)) {
        editorPort.acceptAllEditorChunks(acceptedFiles);
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
    editorPort,
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
      statusPort.beginFileMutation(file.filePath);
      statePort.rejectAllFile(file.filePath);
    }
    const preparedAction = history.pushUndoAction({
      kind: 'bulk',
      descriptor: { intent: 'reject-all', fileCount: requestedFiles.length },
      decisionSnapshot,
      diskSnapshots,
    });
    statusPort.markFilesApplying(requestedPaths);
    editorPort.scheduleEditorSync(() => {
      if (isCurrentOperationScope(operationScope)) {
        editorPort.rejectAllEditorChunks(requestedPaths);
      }
    });

    if (!instantApply) {
      for (const file of requestedFiles) {
        statusPort.finishFileMutation(file.filePath);
      }
      statusPort.clearFilesApplying(requestedPaths);
      return;
    }

    void (async () => {
      try {
        if (!isCurrentOperationScope(operationScope)) return;
        if (!ensureDurableScope()) {
          statePort.restoreDecisionSnapshot(decisionSnapshot);
          for (const snapshot of diskSnapshots) {
            editorPort.rollbackEditorContent(snapshot.filePath, snapshot.beforeContent);
          }
          history.discardLatestAction(preparedAction);
          return;
        }
        for (const snapshot of diskSnapshots) {
          writeEvidencePort.markExpectedWrite(
            snapshot.filePath,
            isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
          );
        }
        let result: ApplyReviewResult | null = null;
        try {
          result = await commandPort.applyReview(teamName, taskId, memberName);
        } catch {
          // Treat transport/runtime failure like an unknown apply result. The
          // store command owns user-visible error reporting; this controller
          // must still roll back optimistic decisions and release busy state.
        }
        const currentState = statePort.getSnapshot();
        if (
          !isCurrentOperationScope(operationScope) ||
          currentState.changeSetEpoch !== changeSetEpoch
        ) {
          return;
        }
        writeEvidencePort.markCommittedPostimages(result?.diskPostimages);
        history.bindCommittedAction(preparedAction, result?.committedReviewAction);
        const reconciliation = reconcileReviewDecisionRecordsAfterApply(
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
            editorPort.rollbackEditorContent(file.filePath, beforeContent);
          }
          statePort.invalidateResolvedFileContent(file.filePath);
          statusPort.incrementDiscardCounter(file.filePath);
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

        statusPort.setUndoInFlight(true);
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
            alignReviewDiskUndoSnapshotWithAppliedContent(snapshot, appliedContent);
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
            writeEvidencePort.markExpectedWrite(
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
            statusPort.finishFileMutation(file.filePath);
          }
          statusPort.clearFilesApplying(requestedPaths);
          statusPort.setUndoInFlight(false);
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
    editorPort,
    ensureDurableScope,
    hasActionInFlight,
    history,
    instantApply,
    isCurrentOperationScope,
    memberName,
    rejectableFiles,
    statePort,
    statusPort,
    taskId,
    teamName,
    writeEvidencePort,
  ]);

  return { acceptAll, rejectAll };
}
