import { useCallback } from 'react';

import {
  alignReviewDiskUndoSnapshotWithAppliedContent,
  isLedgerRenameReviewFile,
} from '@features/review-mutations';

import type {
  CaptureChangeReviewHunkOperationScope,
  ChangeReviewHunkDecisionCommandPort,
  ChangeReviewHunkDecisionEditorPort,
  ChangeReviewHunkDecisionHistoryPort,
  ChangeReviewHunkDecisionPolicy,
  ChangeReviewHunkDecisionStatePort,
  ChangeReviewHunkDecisionStatusPort,
  ChangeReviewHunkDecisionWriteEvidencePort,
} from '../ports/changeReviewHunkDecisionPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDiskUndoSnapshot,
} from '@shared/types';

interface UseChangeReviewHunkDecisionControllerInput {
  files: readonly FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  changeSetEpoch: number;
  instantApply: boolean;
  teamName: string;
  taskId: string | undefined;
  memberName: string | undefined;
  statePort: ChangeReviewHunkDecisionStatePort;
  commandPort: ChangeReviewHunkDecisionCommandPort;
  editorPort: ChangeReviewHunkDecisionEditorPort;
  statusPort: ChangeReviewHunkDecisionStatusPort;
  historyPort: ChangeReviewHunkDecisionHistoryPort;
  writeEvidencePort: ChangeReviewHunkDecisionWriteEvidencePort;
  policy: ChangeReviewHunkDecisionPolicy;
  persistLatestAcceptedAction: () => Promise<boolean>;
  ensureDurableScope: () => boolean;
  hasDraft: (filePath: string) => boolean;
  hasActionInFlight: () => boolean;
  blockForExternalChange: (filePath: string) => boolean;
  captureOperationScope: CaptureChangeReviewHunkOperationScope;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
}

export interface ChangeReviewHunkDecisionController {
  acceptHunk: (filePath: string, hunkIndex: number) => boolean;
  rejectHunk: (
    filePath: string,
    hunkIndex: number,
    beforeContent?: string,
    afterContent?: string
  ) => boolean;
}

export function useChangeReviewHunkDecisionController({
  files,
  fileContents,
  changeSetEpoch,
  instantApply,
  teamName,
  taskId,
  memberName,
  statePort,
  commandPort,
  editorPort,
  statusPort,
  historyPort,
  writeEvidencePort,
  policy,
  persistLatestAcceptedAction,
  ensureDurableScope,
  hasDraft,
  hasActionInFlight,
  blockForExternalChange,
  captureOperationScope,
  isCurrentOperationScope,
}: UseChangeReviewHunkDecisionControllerInput): ChangeReviewHunkDecisionController {
  const acceptHunk = useCallback(
    (filePath: string, hunkIndex: number): boolean => {
      if (hasDraft(filePath) || hasActionInFlight() || blockForExternalChange(filePath)) {
        editorPort.guardIgnoredMutation(filePath);
        return false;
      }
      const originalIndex = statePort.setDecision(filePath, hunkIndex, 'accepted');
      historyPort.pushUndoAction({
        kind: 'hunk',
        descriptor: { intent: 'accept-hunk', filePath, hunkIndex: originalIndex },
        action: { filePath, originalIndex },
      });
      void persistLatestAcceptedAction();
      return true;
    },
    [
      blockForExternalChange,
      editorPort,
      hasActionInFlight,
      hasDraft,
      historyPort,
      persistLatestAcceptedAction,
      statePort,
    ]
  );

  const rejectHunk = useCallback(
    (
      filePath: string,
      hunkIndex: number,
      suppliedBeforeContent?: string,
      suppliedAfterContent?: string
    ): boolean => {
      if (hasDraft(filePath) || hasActionInFlight() || blockForExternalChange(filePath)) {
        return false;
      }

      let beforeContent = suppliedBeforeContent;
      let afterContent = suppliedAfterContent;
      if (beforeContent === undefined || afterContent === undefined) {
        const rejected = editorPort.rejectChunk(filePath);
        if (!rejected) return false;
        beforeContent = rejected.beforeContent;
        afterContent = rejected.afterContent;
      }

      const operationEpoch = changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) {
        editorPort.rollbackContent(filePath, beforeContent);
        return false;
      }

      statusPort.beginFileMutation(filePath);
      const decisionState = statePort.getSnapshot();
      const file = files.find((candidate) => candidate.filePath === filePath);
      const hunkCount = file ? policy.getHunkCount(file, decisionState) : 0;
      const shouldDeleteOnUndo = policy.shouldDeleteWhenUndoingReject(
        file,
        hunkCount,
        decisionState
      );
      const originalIndex = statePort.setDecision(filePath, hunkIndex, 'rejected');
      const isNewFileFullyRejected = policy.shouldCreateWhenUndoingReject(
        file,
        Boolean(file && policy.resolveFileIsNew(file, fileContents[filePath])),
        hunkCount,
        statePort.getSnapshot()
      );

      if (instantApply) {
        const snapshot: ReviewDiskUndoSnapshot = {
          filePath,
          beforeContent,
          afterContent: isNewFileFullyRejected ? null : afterContent,
          file,
          restoreMode: isNewFileFullyRejected
            ? 'create-file'
            : shouldDeleteOnUndo
              ? 'delete-file'
              : undefined,
          renameExpectation: policy.getRenameRecoveryExpectation(file) ?? undefined,
        };
        const preparedAction = historyPort.pushUndoAction({
          kind: 'disk',
          descriptor: { intent: 'reject-hunk', filePath, hunkIndex: originalIndex },
          action: { snapshot, originalIndex },
        });
        void (async () => {
          try {
            if (!ensureDurableScope()) {
              editorPort.rollbackContent(filePath, beforeContent);
              statePort.clearDecision(filePath, originalIndex);
              historyPort.discardLatestAction(preparedAction);
              return;
            }
            writeEvidencePort.markExpectedWrite(
              filePath,
              isNewFileFullyRejected ? null : afterContent
            );
            let outcome: Awaited<
              ReturnType<ChangeReviewHunkDecisionCommandPort['applySingleFileDecision']>
            >;
            try {
              outcome = await commandPort.applySingleFileDecision(
                teamName,
                filePath,
                taskId,
                memberName
              );
            } catch {
              outcome = { status: 'failed', result: null };
            }
            if (
              !isCurrentOperationScope(operationScope) ||
              statePort.getSnapshot().changeSetEpoch !== operationEpoch
            ) {
              return;
            }
            writeEvidencePort.clearExpectedWrite(filePath);
            writeEvidencePort.markCommittedPostimages(outcome.result?.diskPostimages);
            if (outcome.status === 'applied') {
              historyPort.bindCommittedAction(preparedAction, outcome.result.committedReviewAction);
              let actualAfterContent: string | null = null;
              if (!isNewFileFullyRejected) {
                try {
                  actualAfterContent = await commandPort.readCurrentDiskContent(
                    filePath,
                    afterContent
                  );
                } catch {
                  actualAfterContent = afterContent;
                }
              }
              if (
                !isCurrentOperationScope(operationScope) ||
                statePort.getSnapshot().changeSetEpoch !== operationEpoch
              ) {
                return;
              }
              if (
                actualAfterContent !== null &&
                snapshot.restoreMode !== 'delete-file' &&
                !isLedgerRenameReviewFile(snapshot.file)
              ) {
                alignReviewDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
              }
              historyPort.publishUndoHistory();
              writeEvidencePort.markExpectedWrite(filePath, snapshot.afterContent);
              return;
            }

            editorPort.rollbackContent(filePath, beforeContent);
            statePort.clearDecision(filePath, originalIndex);
            historyPort.discardLatestAction(preparedAction);
            statePort.invalidateResolvedFileContent(filePath);
            statusPort.incrementDiscardCounter(filePath);
            commandPort.fetchFileContent(teamName, memberName, filePath);
          } finally {
            if (
              isCurrentOperationScope(operationScope) &&
              statePort.getSnapshot().changeSetEpoch === operationEpoch
            ) {
              statusPort.finishFileMutation(filePath);
            }
          }
        })();
      } else {
        statusPort.finishFileMutation(filePath);
        historyPort.pushUndoAction({
          kind: 'hunk',
          descriptor: { intent: 'reject-hunk', filePath, hunkIndex: originalIndex },
          action: { filePath, originalIndex },
        });
      }
      return true;
    },
    [
      blockForExternalChange,
      captureOperationScope,
      changeSetEpoch,
      commandPort,
      editorPort,
      ensureDurableScope,
      fileContents,
      files,
      hasActionInFlight,
      hasDraft,
      historyPort,
      instantApply,
      isCurrentOperationScope,
      memberName,
      policy,
      statePort,
      statusPort,
      taskId,
      teamName,
      writeEvidencePort,
    ]
  );

  return { acceptHunk, rejectHunk };
}
