import { useCallback } from 'react';

import {
  alignReviewDiskUndoSnapshotWithAppliedContent,
  buildForwardDiskMutationSteps,
  isLedgerRenameReviewFile,
} from '@features/review-mutations';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';

import type {
  ChangeReviewFileDecisionCommandPort,
  ChangeReviewFileDecisionEditorPort,
  ChangeReviewFileDecisionHistoryPort,
  ChangeReviewFileDecisionPersistenceScope,
  ChangeReviewFileDecisionPolicy,
  ChangeReviewFileDecisionStatePort,
  ChangeReviewFileDecisionStatusPort,
  ChangeReviewFileDecisionWriteEvidencePort,
} from '../ports/changeReviewFileDecisionPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  ReviewDecisionSnapshot,
  ReviewDiskUndoAction,
  ReviewDiskUndoSnapshot,
  ReviewFileScope,
  ReviewUndoAction,
} from '@shared/types';

interface UseChangeReviewFileDecisionControllerInput {
  files: readonly FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  changeSetEpoch: number;
  instantApply: boolean;
  teamName: string;
  taskId: string | undefined;
  memberName: string | undefined;
  reviewScope: ReviewFileScope;
  persistenceScope: ChangeReviewFileDecisionPersistenceScope | null;
  history: ChangeReviewFileDecisionHistoryPort;
  statePort: ChangeReviewFileDecisionStatePort;
  commandPort: ChangeReviewFileDecisionCommandPort;
  editorPort: ChangeReviewFileDecisionEditorPort;
  statusPort: ChangeReviewFileDecisionStatusPort;
  writeEvidencePort: ChangeReviewFileDecisionWriteEvidencePort;
  policy: ChangeReviewFileDecisionPolicy;
  persistLatestAcceptedAction: () => Promise<unknown>;
  ensureDurableScope: () => boolean;
  hasDraft: (filePath: string) => boolean;
  hasActionInFlight: () => boolean;
  blockForExternalChange: (filePath: string) => boolean;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
}

export interface ChangeReviewFileDecisionController {
  acceptFile: (filePath: string) => void;
  rejectFile: (filePath: string) => Promise<void>;
}

function findLatestDiskSnapshots(
  history: readonly ReviewUndoAction[],
  filePath: string
): {
  latest: ReviewDiskUndoSnapshot | undefined;
  session: ReviewDiskUndoSnapshot | undefined;
} {
  const normalizedFilePath = normalizePathForComparison(filePath);
  const diskHistory = history.flatMap((action): ReviewDiskUndoAction[] =>
    action.kind === 'disk'
      ? [action.action]
      : action.kind === 'bulk'
        ? action.diskSnapshots.map((snapshot) => ({ snapshot }))
        : []
  );
  const matchesFile = (action: ReviewDiskUndoAction): boolean =>
    normalizePathForComparison(action.snapshot.filePath) === normalizedFilePath;
  return {
    latest: [...diskHistory].reverse().find(matchesFile)?.snapshot,
    session: [...diskHistory]
      .reverse()
      .find((action) => action.originalIndex === undefined && matchesFile(action))?.snapshot,
  };
}

function hasApplyErrorForFile(
  filePath: string,
  result: Awaited<ReturnType<ChangeReviewFileDecisionCommandPort['applySingleFileDecision']>>
): boolean {
  const normalizedFilePath = normalizePathForComparison(filePath);
  return (
    !result ||
    result.errors.some((error) => normalizePathForComparison(error.filePath) === normalizedFilePath)
  );
}

export function useChangeReviewFileDecisionController({
  files,
  fileContents,
  changeSetEpoch,
  instantApply,
  teamName,
  taskId,
  memberName,
  reviewScope,
  persistenceScope,
  history,
  statePort,
  commandPort,
  editorPort,
  statusPort,
  writeEvidencePort,
  policy,
  persistLatestAcceptedAction,
  ensureDurableScope,
  hasDraft,
  hasActionInFlight,
  blockForExternalChange,
  captureOperationScope,
  isCurrentOperationScope,
}: UseChangeReviewFileDecisionControllerInput): ChangeReviewFileDecisionController {
  const restoreRejectedFileAsAccepted = useCallback(
    async (filePath: string): Promise<void> => {
      if (hasDraft(filePath) || hasActionInFlight() || blockForExternalChange(filePath)) {
        return;
      }
      const operationEpoch = changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      const file = files.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      const content = fileContents[filePath] ?? null;
      const isExpectedDeletion = policy.isExpectedDeletion(file);
      const { latest: latestDiskSnapshot, session: sessionSnapshot } = findLatestDiskSnapshots(
        history.getUndoHistory(),
        filePath
      );
      const hasAuthoritativeAgentContent =
        content?.contentSource === 'ledger-exact' || content?.contentSource === 'ledger-snapshot';
      const canReconstructCreatedFile = policy.resolveFileIsNew(file, content);
      const desiredContent =
        sessionSnapshot?.beforeContent ??
        (hasAuthoritativeAgentContent || canReconstructCreatedFile
          ? policy.resolveModifiedContent(file, content)
          : null);
      if (desiredContent === null) {
        statePort.reportError(
          'Agent content is unavailable after reopen; restore it from Git or rerun the change.'
        );
        return;
      }

      const initialState = statePort.getSnapshot();
      const decisionSnapshot: ReviewDecisionSnapshot = {
        hunkDecisions: { ...initialState.hunkDecisions },
        fileDecisions: { ...initialState.fileDecisions },
      };
      const rejectedHunkCount = policy.getHunkCount(file, initialState);
      const rejectedNewFileWasRemoved =
        canReconstructCreatedFile &&
        policy.isFileFullyRejected(file, rejectedHunkCount, decisionSnapshot);
      statePort.reportError(null);
      statusPort.beginFileMutation(filePath);
      writeEvidencePort.markExpectedWrite(filePath, isExpectedDeletion ? null : desiredContent);
      try {
        if (!persistenceScope) {
          throw new Error('Durable review scope is unavailable; refusing an unsafe restore.');
        }
        let rejectedDiskContent =
          sessionSnapshot?.afterContent ?? content?.originalFullContent ?? '';
        let restoredDiskContent: string | null = desiredContent;
        let restoreMode: ReviewDiskUndoSnapshot['restoreMode'] = 'content';
        let renameExpectation = null;

        if (isLedgerRenameReviewFile(file)) {
          renameExpectation =
            sessionSnapshot?.renameExpectation ?? policy.getRenameRecoveryExpectation(file);
          if (!renameExpectation) {
            throw new Error('Rename recovery metadata is unavailable; refusing an unsafe restore.');
          }
          restoreMode = 'reapply-rejected-rename';
        } else if (isExpectedDeletion) {
          const expectedRejectedContent =
            latestDiskSnapshot?.afterContent ??
            sessionSnapshot?.afterContent ??
            content?.originalFullContent;
          if (expectedRejectedContent === null) {
            throw new Error('Deleted file baseline is unavailable; refusing an unsafe restore.');
          }
          rejectedDiskContent = expectedRejectedContent;
          restoredDiskContent = null;
          restoreMode = 'create-file';
        } else if (policy.resolveFileIsNew(file, content)) {
          const current = await commandPort.checkConflict(reviewScope, filePath, '');
          const isMissing = current.hasConflict && current.conflictContent === null;
          if (isMissing) {
            rejectedDiskContent = '';
            restoreMode = 'delete-file';
          } else {
            if (rejectedNewFileWasRemoved) {
              throw new Error('A file now exists at this path; refusing to overwrite it.');
            }
            if (
              policy.hasUnresolvedExternalChange(filePath, initialState.reviewExternalChangesByFile)
            ) {
              throw new Error(
                'Choose Reload from disk or Keep my draft before restoring this file.'
              );
            }
            rejectedDiskContent = current.currentContent;
            restoredDiskContent = desiredContent;
          }
        } else {
          const baseline = sessionSnapshot?.afterContent ?? content?.originalFullContent;
          if (baseline === null) {
            throw new Error('Original file content is unavailable; unable to restore safely.');
          }
          const current = await commandPort.checkConflict(reviewScope, filePath, baseline);
          if (current.hasConflict && current.conflictContent === null) {
            throw new Error('File is missing on disk; unable to restore safely.');
          }
          rejectedDiskContent = current.currentContent;
          const merged = threeWayTextMerge(baseline, current.currentContent, desiredContent);
          if (merged.hasConflicts) {
            throw new Error('Agent changes conflict with edits made after rejection.');
          }
          restoredDiskContent = merged.content;
        }

        if (
          !isCurrentOperationScope(operationScope) ||
          statePort.getSnapshot().changeSetEpoch !== operationEpoch
        ) {
          return;
        }
        const quiesced = await commandPort.quiescePersistence(persistenceScope);
        if (
          !isCurrentOperationScope(operationScope) ||
          statePort.getSnapshot().changeSetEpoch !== operationEpoch
        ) {
          return;
        }
        if (!quiesced) {
          throw new Error('Unable to finish saving the previous review state. Retry Restore.');
        }
        statePort.applyRestoredDecisionState(file);

        const snapshot: ReviewDiskUndoSnapshot = {
          filePath,
          beforeContent: rejectedDiskContent,
          afterContent: restoredDiskContent,
          file,
          restoreMode,
          renameExpectation: renameExpectation ?? undefined,
        };
        const preparedAction = history.pushUndoAction({
          kind: 'disk',
          descriptor: {
            intent: isLedgerRenameReviewFile(file) ? 'restore-rename' : 'restore-file',
            filePath,
          },
          action: { snapshot, file, decisionSnapshot },
        });
        try {
          const state = statePort.getSnapshot();
          writeEvidencePort.markExpectedWrite(filePath, restoredDiskContent);
          const committed = await commandPort.executeMutation({
            scope: reviewScope,
            decisionPersistenceScope: {
              scopeKey: persistenceScope.scopeKey,
              scopeToken: persistenceScope.scopeToken,
            },
            kind: isLedgerRenameReviewFile(file) ? 'rename' : 'restore',
            diskSteps: buildForwardDiskMutationSteps(preparedAction.id, [snapshot]),
            persistedState: {
              hunkDecisions: state.hunkDecisions,
              fileDecisions: state.fileDecisions,
              hunkContextHashesByFile: state.hunkContextHashesByFile,
              reviewActionHistory: history.getUndoHistory(),
              reviewRedoHistory: history.getRedoHistory(),
            },
            expectedDecisionRevision: state.decisionRevision,
          });
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          writeEvidencePort.markCommittedPostimages(committed.diskPostimages);
          history.bindCommittedAction(preparedAction, committed.committedReviewAction);
          commandPort.recordDecisionRevision(persistenceScope, committed.decisionRevision);
        } catch (error) {
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          statePort.restoreFileDecisions(file, decisionSnapshot);
          history.discardLatestAction(preparedAction);
          throw error;
        }
        writeEvidencePort.markExpectedWrite(filePath, restoredDiskContent);
        statePort.clearExternalChange(filePath);
        statePort.invalidateResolvedFileContent(filePath);
        statusPort.incrementDiscardCounter(filePath);
        commandPort.fetchFileContent(teamName, memberName, filePath);
      } catch (error) {
        if (
          isCurrentOperationScope(operationScope) &&
          statePort.getSnapshot().changeSetEpoch === operationEpoch
        ) {
          statePort.reportError(
            error instanceof Error ? error.message : 'Unable to restore the file.'
          );
          statePort.invalidateResolvedFileContent(filePath);
          statusPort.incrementDiscardCounter(filePath);
          commandPort.fetchFileContent(teamName, memberName, filePath);
        }
      } finally {
        if (
          isCurrentOperationScope(operationScope) &&
          statePort.getSnapshot().changeSetEpoch === operationEpoch
        ) {
          statusPort.finishFileMutation(filePath);
        }
      }
    },
    [
      blockForExternalChange,
      captureOperationScope,
      changeSetEpoch,
      commandPort,
      fileContents,
      files,
      hasActionInFlight,
      hasDraft,
      history,
      isCurrentOperationScope,
      memberName,
      persistenceScope,
      policy,
      reviewScope,
      statePort,
      statusPort,
      teamName,
      writeEvidencePort,
    ]
  );

  const acceptFile = useCallback(
    (filePath: string): void => {
      if (hasDraft(filePath) || hasActionInFlight() || blockForExternalChange(filePath)) {
        return;
      }
      const file = files.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      const state = statePort.getSnapshot();
      const content = state.fileContents[file.filePath];
      const currentFileDecision = policy.getFileDecision(file, state);
      if (!content || policy.isAcceptDisabled(file, content, currentFileDecision)) return;
      const count = policy.getHunkCount(file, state);
      const decisions = {
        hunkDecisions: state.hunkDecisions,
        fileDecisions: state.fileDecisions,
      };
      if (policy.hasFileRejections(file, count, decisions)) {
        void restoreRejectedFileAsAccepted(filePath);
        return;
      }
      const decisionSnapshot: ReviewDecisionSnapshot = {
        hunkDecisions: { ...state.hunkDecisions },
        fileDecisions: { ...state.fileDecisions },
      };
      if (!statePort.acceptAllFile(filePath)) return;
      history.pushUndoAction({
        kind: 'bulk',
        descriptor: { intent: 'accept-file', filePath },
        decisionSnapshot,
        diskSnapshots: [],
      });
      void persistLatestAcceptedAction();
      const operationScope = captureOperationScope();
      editorPort.scheduleEditorSync(() => {
        if (!operationScope || isCurrentOperationScope(operationScope)) {
          editorPort.acceptAllEditorChunks(filePath);
        }
      });
    },
    [
      blockForExternalChange,
      captureOperationScope,
      editorPort,
      files,
      hasActionInFlight,
      hasDraft,
      history,
      isCurrentOperationScope,
      persistLatestAcceptedAction,
      policy,
      restoreRejectedFileAsAccepted,
      statePort,
    ]
  );

  const rejectFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (hasDraft(filePath) || hasActionInFlight() || blockForExternalChange(filePath)) {
        return;
      }
      statusPort.beginFileMutation(filePath);
      const operationEpoch = changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) {
        statusPort.finishFileMutation(filePath);
        return;
      }
      try {
        const file = files.find((candidate) => candidate.filePath === filePath);
        if (!file) return;
        const state = statePort.getSnapshot();
        if (!policy.isRejectable(file, state.fileContents[file.filePath] ?? null)) return;
        const count = policy.getHunkCount(file, state);
        const decisions = {
          hunkDecisions: state.hunkDecisions,
          fileDecisions: state.fileDecisions,
        };
        if (policy.isFileFullyRejected(file, count, decisions)) return;
        const decisionSnapshot: ReviewDecisionSnapshot = {
          hunkDecisions: { ...state.hunkDecisions },
          fileDecisions: { ...state.fileDecisions },
        };
        const content = fileContents[filePath] ?? null;
        const isNew = policy.resolveFileIsNew(file, content);
        const shouldDeleteOnUndo = policy.shouldDeleteWhenUndoingReject(
          file,
          count,
          decisionSnapshot
        );
        const beforeContent =
          editorPort.getCurrentContent(filePath) ?? policy.resolveModifiedContent(file, content);
        const afterContent = isNew ? null : (content?.originalFullContent ?? null);
        const restoreContent = beforeContent ?? policy.resolveModifiedContent(file, content);
        if (restoreContent === null || (!isNew && afterContent === null)) {
          statePort.reportError(
            'Exact disk contents are unavailable; refusing a reject without Undo.'
          );
          return;
        }
        const snapshot: ReviewDiskUndoSnapshot = {
          filePath,
          beforeContent: restoreContent,
          afterContent,
          file,
          fileIndex: isNew
            ? Math.max(
                0,
                files.findIndex((candidate) => candidate.filePath === filePath)
              )
            : undefined,
          restoreMode: isNew ? 'create-file' : shouldDeleteOnUndo ? 'delete-file' : undefined,
          renameExpectation: policy.getRenameRecoveryExpectation(file) ?? undefined,
        };

        statePort.rejectAllFile(filePath);
        editorPort.rejectAllEditorChunks(filePath);
        const preparedAction = history.pushUndoAction({
          kind: 'disk',
          descriptor: { intent: 'reject-file', filePath },
          action: { snapshot, file, decisionSnapshot },
        });
        if (!instantApply) return;

        writeEvidencePort.markExpectedWrite(
          filePath,
          isNew || isLedgerRenameReviewFile(file) ? null : afterContent
        );
        if (!ensureDurableScope()) {
          statePort.restoreFileDecisions(file, decisionSnapshot);
          editorPort.rollbackEditorContent(filePath, restoreContent);
          history.discardLatestAction(preparedAction);
          return;
        }
        const result = await commandPort.applySingleFileDecision(
          teamName,
          filePath,
          taskId,
          memberName
        );
        if (
          !isCurrentOperationScope(operationScope) ||
          statePort.getSnapshot().changeSetEpoch !== operationEpoch
        ) {
          return;
        }
        writeEvidencePort.markCommittedPostimages(result?.diskPostimages);
        history.bindCommittedAction(preparedAction, result?.committedReviewAction);

        if (hasApplyErrorForFile(filePath, result)) {
          history.discardLatestAction(preparedAction);
          statePort.restoreFileDecisions(file, decisionSnapshot);
          editorPort.rollbackEditorContent(filePath, restoreContent);
          statePort.invalidateResolvedFileContent(filePath);
          statusPort.incrementDiscardCounter(filePath);
          commandPort.fetchFileContent(teamName, memberName, filePath);
          return;
        }
        if (isNew) {
          writeEvidencePort.markExpectedWrite(filePath, null);
          statePort.invalidateResolvedFileContent(filePath);
          commandPort.fetchFileContent(teamName, memberName, filePath);
          return;
        }
        if (beforeContent !== null && afterContent !== null) {
          const actualAfterContent = await commandPort.readCurrentDiskContent(
            filePath,
            afterContent
          );
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          if (snapshot.restoreMode !== 'delete-file' && !isLedgerRenameReviewFile(file)) {
            alignReviewDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
          }
          history.publishUndoHistory();
        }
        writeEvidencePort.markExpectedWrite(
          filePath,
          isLedgerRenameReviewFile(file) ? null : afterContent
        );
      } finally {
        if (
          isCurrentOperationScope(operationScope) &&
          statePort.getSnapshot().changeSetEpoch === operationEpoch
        ) {
          statusPort.finishFileMutation(filePath);
        }
      }
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
      history,
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

  return { acceptFile, rejectFile };
}
