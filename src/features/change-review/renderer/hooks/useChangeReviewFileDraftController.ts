import { useCallback } from 'react';

import { buildReviewExternalReloadState } from '@features/review-mutations';
import { normalizePathForComparison } from '@shared/utils/platformPath';

import type {
  ChangeReviewFileDraftCommandPort,
  ChangeReviewFileDraftPersistenceScope,
  ChangeReviewFileDraftStatePort,
  ChangeReviewFileDraftStatusPort,
  ChangeReviewFileDraftWriteEvidencePort,
} from '../ports/changeReviewFileDraftPorts';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ChangeReviewActionHistoryController } from './useChangeReviewActionHistoryController';
import type { ChangeReviewDraftHistoryController } from './useChangeReviewDraftHistoryController';
import type { FileChangeSummary, FileChangeWithContent, ReviewFileScope } from '@shared/types';

type ActionHistory = Pick<
  ChangeReviewActionHistoryController,
  'clearForFile' | 'getUndoHistory' | 'getRedoHistory' | 'replaceHistories'
>;

type DraftHistory = Pick<
  ChangeReviewDraftHistoryController,
  | 'getEntry'
  | 'hasBaseline'
  | 'getBaseline'
  | 'setBaseline'
  | 'deleteBaseline'
  | 'unsuppressFile'
  | 'publishCheckpoint'
  | 'flushWrites'
  | 'clearFile'
>;

interface UseChangeReviewFileDraftControllerInput {
  files: readonly FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  teamName: string;
  memberName: string | undefined;
  reviewScope: ReviewFileScope;
  persistenceScope: ChangeReviewFileDraftPersistenceScope | null;
  actionHistory: ActionHistory;
  draftHistory: DraftHistory;
  statePort: ChangeReviewFileDraftStatePort;
  commandPort: ChangeReviewFileDraftCommandPort;
  statusPort: ChangeReviewFileDraftStatusPort;
  writeEvidencePort: ChangeReviewFileDraftWriteEvidencePort;
  hasActionInFlight: () => boolean;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
  resolveModifiedContent: (
    file: FileChangeSummary,
    content: FileChangeWithContent | null
  ) => string | null;
  isFileMissingOnDisk: (content: FileChangeWithContent | null) => boolean;
  hasUnresolvedExternalChange: (filePath: string, changes: Record<string, unknown>) => boolean;
}

export interface ChangeReviewFileDraftController {
  contentChanged: (filePath: string, content: string, previousContent?: string) => void;
  saveFile: (filePath: string) => Promise<void>;
  restoreMissingFile: (filePath: string, content: string) => void;
  reloadFromDisk: (filePath: string) => void;
  keepDraft: (filePath: string) => void;
  discardFile: (filePath: string) => void;
}

export function useChangeReviewFileDraftController({
  files,
  fileContents,
  teamName,
  memberName,
  reviewScope,
  persistenceScope,
  actionHistory,
  draftHistory,
  statePort,
  commandPort,
  statusPort,
  writeEvidencePort,
  hasActionInFlight,
  captureOperationScope,
  isCurrentOperationScope,
  resolveModifiedContent,
  isFileMissingOnDisk,
  hasUnresolvedExternalChange,
}: UseChangeReviewFileDraftControllerInput): ChangeReviewFileDraftController {
  const contentChanged = useCallback(
    (filePath: string, content: string, previousContent?: string): void => {
      const baselineKey = normalizePathForComparison(filePath);
      draftHistory.unsuppressFile(baselineKey);
      if (!draftHistory.hasBaseline(baselineKey)) {
        const fileContent = fileContents[filePath] ?? null;
        if (isFileMissingOnDisk(fileContent)) {
          draftHistory.setBaseline(baselineKey, null);
        } else {
          const baseline =
            previousContent ??
            resolveModifiedContent(
              files.find((file) => file.filePath === filePath) ?? {
                filePath,
                relativePath: filePath,
                snippets: [],
                linesAdded: 0,
                linesRemoved: 0,
                isNewFile: false,
              },
              fileContent
            );
          if (baseline != null) draftHistory.setBaseline(baselineKey, baseline);
        }
      }
      const diskBaseline = draftHistory.getBaseline(baselineKey);
      if (diskBaseline !== null && diskBaseline !== undefined && content === diskBaseline) {
        statePort.discardFileEdits(filePath);
      } else {
        statePort.updateEditedContent(filePath, content);
      }
    },
    [draftHistory, fileContents, files, isFileMissingOnDisk, resolveModifiedContent, statePort]
  );

  const saveFile = useCallback(
    async (filePath: string): Promise<void> => {
      if (hasActionInFlight()) return;
      const initialState = statePort.getSnapshot();
      const contentToSave = initialState.editedContents[filePath];
      if (contentToSave === undefined) return;
      if (hasUnresolvedExternalChange(filePath, initialState.reviewExternalChangesByFile)) {
        statePort.reportError('Choose Reload from disk or Keep my draft before saving this file.');
        return;
      }
      const baselineKey = normalizePathForComparison(filePath);
      if (!draftHistory.hasBaseline(baselineKey)) {
        statePort.reportError(
          'The draft disk baseline is unavailable. Reload the file before saving.'
        );
        return;
      }
      const expectedCurrentContent = draftHistory.getBaseline(baselineKey) ?? null;
      const operationEpoch = initialState.changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      writeEvidencePort.markExpectedWrite(filePath, contentToSave);
      await commandPort.saveEditedFile(filePath, reviewScope, expectedCurrentContent);
      if (!isCurrentOperationScope(operationScope)) return;
      const state = statePort.getSnapshot();
      if (state.changeSetEpoch === operationEpoch && !state.applyError) {
        draftHistory.setBaseline(baselineKey, contentToSave);
        const serializedState = draftHistory.getEntry(filePath)?.editorState;
        if (serializedState) {
          draftHistory.publishCheckpoint(filePath, serializedState, contentToSave);
          const flushed = await draftHistory.flushWrites();
          if (!isCurrentOperationScope(operationScope)) return;
          if (!flushed) {
            statePort.reportError(
              'The file was saved, but its durable Undo history could not be updated.'
            );
          }
        }
        actionHistory.clearForFile(filePath);
        writeEvidencePort.markExpectedWrite(filePath, contentToSave);
      }
    },
    [
      actionHistory,
      captureOperationScope,
      commandPort,
      draftHistory,
      hasActionInFlight,
      hasUnresolvedExternalChange,
      isCurrentOperationScope,
      reviewScope,
      statePort,
      writeEvidencePort,
    ]
  );

  const restoreMissingFile = useCallback(
    (filePath: string, content: string): void => {
      if (hasActionInFlight()) return;
      const operationEpoch = statePort.getSnapshot().changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      const baselineKey = normalizePathForComparison(filePath);
      draftHistory.setBaseline(baselineKey, null);
      writeEvidencePort.markExpectedWrite(filePath, content);
      statePort.updateEditedContent(filePath, content);
      void Promise.resolve().then(async () => {
        if (!isCurrentOperationScope(operationScope)) return;
        await commandPort.saveEditedFile(filePath, reviewScope, null);
        if (!isCurrentOperationScope(operationScope)) return;
        const state = statePort.getSnapshot();
        if (state.changeSetEpoch === operationEpoch && !state.applyError) {
          draftHistory.setBaseline(baselineKey, content);
          const serializedState = draftHistory.getEntry(filePath)?.editorState;
          if (serializedState) {
            draftHistory.publishCheckpoint(filePath, serializedState, content);
            const flushed = await draftHistory.flushWrites();
            if (!isCurrentOperationScope(operationScope)) return;
            if (!flushed) {
              statePort.reportError(
                'The file was restored, but its durable Undo history could not be updated.'
              );
            }
          }
          actionHistory.clearForFile(filePath);
          writeEvidencePort.markExpectedWrite(filePath, content);
        }
      });
    },
    [
      actionHistory,
      captureOperationScope,
      commandPort,
      draftHistory,
      hasActionInFlight,
      isCurrentOperationScope,
      reviewScope,
      statePort,
      writeEvidencePort,
    ]
  );

  const reloadFromDisk = useCallback(
    (filePath: string): void => {
      if (hasActionInFlight()) return;
      const operationEpoch = statePort.getSnapshot().changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      statusPort.beginFileMutation(filePath);
      void (async () => {
        try {
          if (!persistenceScope) {
            throw new Error('Durable review scope is unavailable; refusing an unsafe reload.');
          }
          const quiesced = await commandPort.quiescePersistence(persistenceScope);
          if (!isCurrentOperationScope(operationScope)) return;
          if (!quiesced) {
            throw new Error('Unable to finish saving the previous review state. Retry Reload.');
          }
          const state = statePort.getSnapshot();
          const file = state.activeFiles.find(
            (candidate) =>
              normalizePathForComparison(candidate.filePath) ===
              normalizePathForComparison(filePath)
          );
          if (!file) throw new Error('Reviewed file is unavailable for Reload.');
          const next = buildReviewExternalReloadState(file, {
            hunkDecisions: state.hunkDecisions,
            fileDecisions: state.fileDecisions,
            hunkContextHashesByFile: state.hunkContextHashesByFile,
            reviewActionHistory: actionHistory.getUndoHistory(),
            reviewRedoHistory: actionHistory.getRedoHistory(),
          });
          const committed = await commandPort.commitExternalReload({
            reviewScope,
            persistenceScope,
            filePath,
            persistedState: next,
            expectedDecisionRevision: state.decisionRevision,
          });
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          actionHistory.replaceHistories(next.reviewActionHistory, next.reviewRedoHistory);
          commandPort.recordDecisionRevision(persistenceScope, committed.decisionRevision);
          draftHistory.deleteBaseline(filePath);
          statePort.applyReloadedReviewState(next);
          await draftHistory.clearFile(filePath);
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          statePort.reloadFileFromDisk(filePath);
          statusPort.incrementDiscardCounter(filePath);
          commandPort.fetchFileContent(teamName, memberName, filePath);
        } catch (error) {
          if (
            isCurrentOperationScope(operationScope) &&
            statePort.getSnapshot().changeSetEpoch === operationEpoch
          ) {
            statePort.reportError(
              error instanceof Error ? error.message : 'Unable to reload the external file.'
            );
          }
        } finally {
          if (
            isCurrentOperationScope(operationScope) &&
            statePort.getSnapshot().changeSetEpoch === operationEpoch
          ) {
            statusPort.finishFileMutation(filePath);
          }
        }
      })();
    },
    [
      actionHistory,
      captureOperationScope,
      commandPort,
      draftHistory,
      hasActionInFlight,
      isCurrentOperationScope,
      memberName,
      persistenceScope,
      reviewScope,
      statePort,
      statusPort,
      teamName,
    ]
  );

  const keepDraft = useCallback(
    (filePath: string): void => {
      if (hasActionInFlight()) return;
      const baselineKey = normalizePathForComparison(filePath);
      if (!draftHistory.hasBaseline(baselineKey)) {
        statePort.reportError(
          'The draft disk baseline is unavailable. Reload the file before continuing.'
        );
        return;
      }
      const expected = draftHistory.getBaseline(baselineKey) ?? '';
      const operationEpoch = statePort.getSnapshot().changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      statusPort.beginFileMutation(filePath);
      void (async () => {
        try {
          const current = await commandPort.checkConflict(reviewScope, filePath, expected);
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          const nextBaseline =
            current.hasConflict && current.conflictContent === null ? null : current.currentContent;
          draftHistory.setBaseline(baselineKey, nextBaseline);
          const serializedState = draftHistory.getEntry(filePath)?.editorState;
          if (serializedState) {
            draftHistory.publishCheckpoint(filePath, serializedState, nextBaseline);
            const flushed = await draftHistory.flushWrites();
            if (!isCurrentOperationScope(operationScope)) return;
            if (!flushed) {
              throw new Error('Unable to persist the rebased manual edit history');
            }
          }
          statePort.clearExternalChange(filePath);
          statePort.reportError(null);
        } catch (error) {
          if (
            isCurrentOperationScope(operationScope) &&
            statePort.getSnapshot().changeSetEpoch === operationEpoch
          ) {
            statePort.reportError(String(error));
          }
        } finally {
          if (
            isCurrentOperationScope(operationScope) &&
            statePort.getSnapshot().changeSetEpoch === operationEpoch
          ) {
            statusPort.finishFileMutation(filePath);
          }
        }
      })();
    },
    [
      captureOperationScope,
      commandPort,
      draftHistory,
      hasActionInFlight,
      isCurrentOperationScope,
      reviewScope,
      statePort,
      statusPort,
    ]
  );

  const discardFile = useCallback(
    (filePath: string): void => {
      if (hasActionInFlight()) return;
      const state = statePort.getSnapshot();
      if (hasUnresolvedExternalChange(filePath, state.reviewExternalChangesByFile)) {
        reloadFromDisk(filePath);
        return;
      }
      const operationEpoch = state.changeSetEpoch;
      const operationScope = captureOperationScope();
      if (!operationScope) return;
      statusPort.beginFileMutation(filePath);
      void (async () => {
        try {
          await draftHistory.clearFile(filePath);
          if (
            !isCurrentOperationScope(operationScope) ||
            statePort.getSnapshot().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          draftHistory.deleteBaseline(filePath);
          statePort.discardFileEdits(filePath);
          statusPort.incrementDiscardCounter(filePath);
        } catch {
          // The draft-history controller already reports durable cleanup failures.
          // Keep the editor and native Undo history intact so Discard remains retryable.
        } finally {
          if (
            isCurrentOperationScope(operationScope) &&
            statePort.getSnapshot().changeSetEpoch === operationEpoch
          ) {
            statusPort.finishFileMutation(filePath);
          }
        }
      })();
    },
    [
      captureOperationScope,
      draftHistory,
      hasActionInFlight,
      hasUnresolvedExternalChange,
      isCurrentOperationScope,
      reloadFromDisk,
      statePort,
      statusPort,
    ]
  );

  return { contentChanged, saveFile, restoreMissingFile, reloadFromDisk, keepDraft, discardFile };
}
