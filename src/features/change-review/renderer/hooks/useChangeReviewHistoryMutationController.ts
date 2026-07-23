import { useCallback } from 'react';

import {
  buildRedoDiskMutationSteps,
  buildReviewHistoryRestoreDiskImpact,
  buildReviewHistoryRestoreDiskSteps,
  buildReviewHistoryRestorePlan,
  buildReviewUndoDecisionState,
  buildUndoDiskMutationSteps,
  getReviewActionDiskSnapshots,
} from '@features/review-mutations';

import {
  classifyReviewHistoryRecovery,
  createReviewRedoAction,
  getReviewActionAffectedPaths,
  getReviewDiskMutationExpectedContent,
  resolveReviewFile,
} from '../utils/changeReviewHistoryMutation';

import { CHANGE_REVIEW_PERSISTENCE_ERROR } from './useChangeReviewDecisionPersistenceController';

import type {
  ChangeReviewHistoryMutationCommandPort,
  ChangeReviewHistoryMutationScope,
  ChangeReviewHistoryMutationStatePort,
  ChangeReviewHistoryMutationViewPort,
  ChangeReviewHistoryPersistenceScope,
} from '../ports/changeReviewHistoryMutationPorts';
import type { ReviewActionPersistenceStatus } from '../utils/changeReviewActionHistory';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { ChangeReviewActionHistoryController } from './useChangeReviewActionHistoryController';
import type {
  FileChangeSummary,
  RetryReviewMutationRecoveryResult,
  ReviewDecisionPersistenceScope,
  ReviewDiskUndoSnapshot,
  ReviewHistoryRestoreTarget,
  ReviewPersistedStateSnapshot,
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

interface UseChangeReviewHistoryMutationControllerInput {
  teamName: string;
  memberName: string | undefined;
  files: readonly FileChangeSummary[];
  editedCount: number;
  decisionHydrationReady: boolean;
  scope: ChangeReviewHistoryMutationScope | null;
  history: ActionHistory;
  commandPort: ChangeReviewHistoryMutationCommandPort;
  statePort: ChangeReviewHistoryMutationStatePort;
  viewPort: ChangeReviewHistoryMutationViewPort;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
  hasActionInFlight: () => boolean;
  isFileMutationInFlight: (filePath: string) => boolean;
  blockForExternalChange: () => boolean;
  getPersistenceStatus: () => ReviewActionPersistenceStatus;
}

export interface ChangeReviewHistoryRestorePreview {
  direction: 'undo' | 'redo';
  actions: ReviewUndoAction[];
  diskTransitions: ReturnType<typeof buildReviewHistoryRestoreDiskImpact>;
}

export interface ChangeReviewHistoryMutationController {
  undoLatest: () => Promise<void>;
  redoLatest: () => Promise<void>;
  getRestorePreview: (target: ReviewHistoryRestoreTarget) => ChangeReviewHistoryRestorePreview;
  restoreHistory: (target: ReviewHistoryRestoreTarget) => Promise<void>;
  recoverFailedHistory: (target: ReviewHistoryRestoreTarget) => Promise<void>;
}

function getRestoreDirection(direction: 'undo' | 'redo' | 'none'): 'undo' | 'redo' {
  if (direction === 'none') throw new Error('Review history restore plan is inconsistent.');
  return direction;
}

function toDecisionPersistenceScope(
  scope: ChangeReviewHistoryPersistenceScope
): ReviewDecisionPersistenceScope {
  return { scopeKey: scope.scopeKey, scopeToken: scope.scopeToken };
}

export function useChangeReviewHistoryMutationController({
  teamName,
  memberName,
  files,
  editedCount,
  decisionHydrationReady,
  scope,
  history,
  commandPort,
  statePort,
  viewPort,
  captureOperationScope,
  isCurrentOperationScope,
  hasActionInFlight,
  isFileMutationInFlight,
  blockForExternalChange,
  getPersistenceStatus,
}: UseChangeReviewHistoryMutationControllerInput): ChangeReviewHistoryMutationController {
  const executeWithPreparedExpectations = useCallback(
    async <T>(
      snapshots: readonly ReviewDiskUndoSnapshot[],
      direction: 'undo' | 'redo',
      execute: () => Promise<T>
    ): Promise<T> => {
      for (const snapshot of snapshots) {
        viewPort.markExpectedWrite(
          snapshot.filePath,
          getReviewDiskMutationExpectedContent(snapshot, direction)
        );
      }
      return execute();
    },
    [viewPort]
  );

  const refreshAfterUndo = useCallback(
    (snapshots: readonly ReviewDiskUndoSnapshot[]): void => {
      for (const snapshot of snapshots) {
        const restoreMode =
          snapshot.restoreMode ??
          (snapshot.renameExpectation ? 'restore-rejected-rename' : 'content');
        if (snapshot.afterContent === null && snapshot.file && restoreMode !== 'create-file') {
          viewPort.addMissingFile(snapshot.file, snapshot.fileIndex, snapshot.beforeContent);
        }
        statePort.clearExternalChange(snapshot.filePath);
        statePort.invalidateResolvedFileContent(snapshot.filePath);
        viewPort.fetchFileContent(teamName, memberName, snapshot.filePath);
      }
      viewPort.incrementDiscardCounters(snapshots.map((snapshot) => snapshot.filePath));
    },
    [memberName, statePort, teamName, viewPort]
  );

  const refreshAfterRedo = useCallback(
    (action: ReviewUndoAction): void => {
      const snapshots = getReviewActionDiskSnapshots(action);
      for (const snapshot of snapshots) {
        statePort.clearExternalChange(snapshot.filePath);
        statePort.invalidateResolvedFileContent(snapshot.filePath);
        viewPort.fetchFileContent(teamName, memberName, snapshot.filePath);
      }
      viewPort.incrementDiscardCounters(getReviewActionAffectedPaths(action, files));
    },
    [files, memberName, statePort, teamName, viewPort]
  );

  const applyCommittedState = useCallback(
    (
      persistedState: ReviewPersistedStateSnapshot,
      decisionRevision: number,
      applyError: string | null
    ): void => {
      if (!scope) throw new Error('Durable review history scope is unavailable.');
      statePort.recordDecisionRevision(scope.persistence, decisionRevision);
      history.replaceHistories(
        persistedState.reviewActionHistory,
        persistedState.reviewRedoHistory
      );
      statePort.applyPersistedState(persistedState, applyError);
    },
    [history, scope, statePort]
  );

  const applyRestoredHistory = useCallback(
    (
      persistedState: ReviewPersistedStateSnapshot,
      decisionRevision: number,
      direction: 'undo' | 'redo',
      diskSnapshots: readonly ReviewDiskUndoSnapshot[],
      orderedActions: readonly ReviewUndoAction[],
      target: ReviewHistoryRestoreTarget
    ): void => {
      applyCommittedState(persistedState, decisionRevision, null);
      if (direction === 'undo') {
        if (diskSnapshots.length > 0) {
          refreshAfterUndo(diskSnapshots);
        } else {
          viewPort.incrementDiscardCounters(
            orderedActions.flatMap((action) => getReviewActionAffectedPaths(action, files))
          );
        }
      } else {
        for (const action of orderedActions) refreshAfterRedo(action);
      }
      if (target.kind !== 'after-action') return;
      const targetAction =
        persistedState.reviewActionHistory.find((action) => action.id === target.actionId) ??
        persistedState.reviewRedoHistory.find((entry) => entry.action.id === target.actionId)
          ?.action;
      if (targetAction) viewPort.navigateToAction(targetAction);
    },
    [applyCommittedState, files, refreshAfterRedo, refreshAfterUndo, viewPort]
  );

  const synchronizeRecoveredState = useCallback(
    (
      persistedState: ReviewPersistedStateSnapshot,
      decisionRevision: number,
      message: string
    ): void => {
      applyCommittedState(persistedState, decisionRevision, message);
      const affectedPaths = files.map((file) => file.filePath);
      for (const filePath of affectedPaths) {
        statePort.clearExternalChange(filePath);
        statePort.invalidateResolvedFileContent(filePath);
        viewPort.fetchFileContent(teamName, memberName, filePath);
      }
      viewPort.incrementDiscardCounters(affectedPaths);
    },
    [applyCommittedState, files, memberName, statePort, teamName, viewPort]
  );

  const buildCurrentRestorePlan = useCallback(
    (target: ReviewHistoryRestoreTarget) => {
      const state = statePort.getSnapshot();
      const plan = buildReviewHistoryRestorePlan(
        {
          hunkDecisions: state.hunkDecisions,
          fileDecisions: state.fileDecisions,
          hunkContextHashesByFile: state.hunkContextHashesByFile,
          reviewActionHistory: history.getUndoHistory(),
          reviewRedoHistory: history.getRedoHistory(),
        },
        target,
        (filePath) => resolveReviewFile(files, filePath)
      );
      return { state, plan };
    },
    [files, history, statePort]
  );

  const getRestorePreview = useCallback(
    (target: ReviewHistoryRestoreTarget): ChangeReviewHistoryRestorePreview => {
      const { plan } = buildCurrentRestorePlan(target);
      if (plan.direction === 'none') throw new Error('This review checkpoint is already current.');
      const direction = getRestoreDirection(plan.direction);
      return {
        direction,
        actions: plan.orderedActions,
        diskTransitions: buildReviewHistoryRestoreDiskImpact(
          plan.orderedActions.map((action) => ({ direction, action }))
        ),
      };
    },
    [buildCurrentRestorePlan]
  );

  const undoLatest = useCallback(async (): Promise<void> => {
    if (hasActionInFlight() || editedCount > 0 || blockForExternalChange()) return;
    const action = history.getLatestUndoAction();
    if (!action) return;
    if (!scope) {
      statePort.reportError('Durable review scope is unavailable; refusing an unsafe Undo.');
      return;
    }
    if (action.kind === 'disk' && isFileMutationInFlight(action.action.snapshot.filePath)) return;
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    const state = statePort.getSnapshot();
    const decisionState = buildReviewUndoDecisionState(action, state, (filePath) =>
      resolveReviewFile(files, filePath)
    );
    if (!decisionState) {
      statePort.reportError('Reviewed file is unavailable for Undo.');
      return;
    }

    viewPort.setMutationInFlight(true);
    try {
      const quiesced = await statePort.quiesceDecisionPersistence(scope.persistence);
      if (!isCurrentOperationScope(operationScope)) return;
      if (!quiesced)
        throw new Error('Unable to finish saving the previous review state. Retry Undo.');
      const current = statePort.getSnapshot();
      const redoAction = createReviewRedoAction(action, current);
      const redoHistory = [...history.getRedoHistory(), redoAction];
      const diskSnapshots = getReviewActionDiskSnapshots(action);
      const committed = await executeWithPreparedExpectations(diskSnapshots, 'undo', () =>
        commandPort.executeMutation({
          scope: scope.review,
          decisionPersistenceScope: toDecisionPersistenceScope(scope.persistence),
          kind: 'undo',
          diskSteps: buildUndoDiskMutationSteps(action.id, diskSnapshots),
          persistedState: {
            hunkDecisions: decisionState.hunkDecisions,
            fileDecisions: decisionState.fileDecisions,
            hunkContextHashesByFile: current.hunkContextHashesByFile,
            reviewActionHistory: history.getUndoHistory().slice(0, -1),
            reviewRedoHistory: redoHistory,
          },
          expectedTopActionId: action.id,
          expectedDecisionRevision: current.decisionRevision,
        })
      );
      if (!isCurrentOperationScope(operationScope)) return;
      viewPort.markCommittedPostimages(committed.diskPostimages);
      statePort.recordDecisionRevision(scope.persistence, committed.decisionRevision);
      statePort.applyDecisionState(decisionState);
      if (diskSnapshots.length > 0) refreshAfterUndo(diskSnapshots);
      if (!history.completeUndoAction(action, redoAction)) return;
      if (diskSnapshots.length === 0) {
        viewPort.incrementDiscardCounters(getReviewActionAffectedPaths(action, files));
      }
    } catch (error) {
      if (!isCurrentOperationScope(operationScope)) return;
      statePort.reportError(
        error instanceof Error ? error.message : 'Unable to undo because the file changed on disk.'
      );
    } finally {
      if (isCurrentOperationScope(operationScope)) viewPort.setMutationInFlight(false);
    }
  }, [
    blockForExternalChange,
    captureOperationScope,
    commandPort,
    editedCount,
    executeWithPreparedExpectations,
    files,
    hasActionInFlight,
    history,
    isCurrentOperationScope,
    isFileMutationInFlight,
    refreshAfterUndo,
    scope,
    statePort,
    viewPort,
  ]);

  const redoLatest = useCallback(async (): Promise<void> => {
    if (hasActionInFlight() || editedCount > 0 || blockForExternalChange()) return;
    const redoAction = history.getLatestRedoAction();
    if (!redoAction || !scope) return;
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    viewPort.setMutationInFlight(true);
    try {
      const quiesced = await statePort.quiesceDecisionPersistence(scope.persistence);
      if (!isCurrentOperationScope(operationScope)) return;
      if (!quiesced)
        throw new Error('Unable to finish saving the previous review state. Retry Redo.');
      const state = statePort.getSnapshot();
      const action = redoAction.action;
      const diskSnapshots = getReviewActionDiskSnapshots(action);
      const committed = await executeWithPreparedExpectations(diskSnapshots, 'redo', () =>
        commandPort.executeMutation({
          scope: scope.review,
          decisionPersistenceScope: toDecisionPersistenceScope(scope.persistence),
          kind: 'redo',
          diskSteps: buildRedoDiskMutationSteps(action.id, diskSnapshots),
          persistedState: {
            hunkDecisions: redoAction.decisionSnapshot.hunkDecisions,
            fileDecisions: redoAction.decisionSnapshot.fileDecisions,
            hunkContextHashesByFile:
              redoAction.hunkContextHashesByFile ?? state.hunkContextHashesByFile,
            reviewActionHistory: [...history.getUndoHistory(), action],
            reviewRedoHistory: history.getRedoHistory().slice(0, -1),
          },
          expectedTopRedoActionId: action.id,
          expectedDecisionRevision: state.decisionRevision,
        })
      );
      if (!isCurrentOperationScope(operationScope)) return;
      viewPort.markCommittedPostimages(committed.diskPostimages);
      statePort.recordDecisionRevision(scope.persistence, committed.decisionRevision);
      statePort.applyDecisionState({
        hunkDecisions: { ...redoAction.decisionSnapshot.hunkDecisions },
        fileDecisions: { ...redoAction.decisionSnapshot.fileDecisions },
        hunkContextHashesByFile:
          redoAction.hunkContextHashesByFile ?? state.hunkContextHashesByFile,
      });
      refreshAfterRedo(action);
      history.completeRedoAction(redoAction);
    } catch (error) {
      if (!isCurrentOperationScope(operationScope)) return;
      statePort.reportError(
        error instanceof Error ? error.message : 'Unable to redo because the file changed on disk.'
      );
    } finally {
      if (isCurrentOperationScope(operationScope)) viewPort.setMutationInFlight(false);
    }
  }, [
    blockForExternalChange,
    captureOperationScope,
    commandPort,
    editedCount,
    executeWithPreparedExpectations,
    hasActionInFlight,
    history,
    isCurrentOperationScope,
    refreshAfterRedo,
    scope,
    statePort,
    viewPort,
  ]);

  const restoreHistory = useCallback(
    async (target: ReviewHistoryRestoreTarget): Promise<void> => {
      if (hasActionInFlight()) throw new Error('Another review action is still running.');
      if (editedCount > 0)
        throw new Error('Save or discard manual edits before restoring review history.');
      if (blockForExternalChange()) {
        throw new Error('Reload files changed outside Changes before restoring review history.');
      }
      if (!scope || !decisionHydrationReady)
        throw new Error('Durable review history is not ready yet.');
      if (getPersistenceStatus() !== 'saved') throw new Error(CHANGE_REVIEW_PERSISTENCE_ERROR);
      const operationScope = captureOperationScope();
      if (!operationScope) throw new Error('Durable review history scope is no longer active.');
      const { state, plan } = buildCurrentRestorePlan(target);
      if (plan.actionCount === 0) return;
      const direction = getRestoreDirection(plan.direction);
      const diskSnapshots = plan.orderedActions.flatMap(getReviewActionDiskSnapshots);
      viewPort.setMutationInFlight(true);
      try {
        const quiesced = await statePort.quiesceDecisionPersistence(scope.persistence);
        if (!isCurrentOperationScope(operationScope)) return;
        if (!quiesced)
          throw new Error('Unable to finish saving the previous review state. Retry Restore.');
        const committed = await executeWithPreparedExpectations(diskSnapshots, direction, () =>
          commandPort.restoreHistory({
            scope: scope.review,
            decisionPersistenceScope: toDecisionPersistenceScope(scope.persistence),
            target,
            expectedDecisionRevision: state.decisionRevision,
          })
        );
        if (!isCurrentOperationScope(operationScope)) return;
        viewPort.markCommittedPostimages(committed.diskPostimages);
        applyRestoredHistory(
          committed.persistedState,
          committed.decisionRevision,
          direction,
          diskSnapshots,
          plan.orderedActions,
          target
        );
      } catch (error) {
        if (!isCurrentOperationScope(operationScope)) return;
        const message =
          error instanceof Error ? error.message : 'Unable to restore the selected review history.';
        statePort.reportError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        if (isCurrentOperationScope(operationScope)) viewPort.setMutationInFlight(false);
      }
    },
    [
      applyRestoredHistory,
      blockForExternalChange,
      buildCurrentRestorePlan,
      captureOperationScope,
      commandPort,
      decisionHydrationReady,
      editedCount,
      executeWithPreparedExpectations,
      getPersistenceStatus,
      hasActionInFlight,
      isCurrentOperationScope,
      scope,
      statePort,
      viewPort,
    ]
  );

  const recoverFailedHistory = useCallback(
    async (target: ReviewHistoryRestoreTarget): Promise<void> => {
      if (!scope || !decisionHydrationReady) {
        throw new Error('Durable review history is not ready for recovery.');
      }
      const operationScope = captureOperationScope();
      if (!operationScope) throw new Error('Durable review history scope is no longer active.');
      const currentRevision = statePort.getSnapshot().decisionRevision;
      const { plan } = buildCurrentRestorePlan(target);
      const direction = plan.direction;
      const diskSteps =
        direction === 'undo' || direction === 'redo'
          ? buildReviewHistoryRestoreDiskSteps(
              plan.orderedActions.map((action) => ({ direction, action }))
            )
          : [];
      const diskSnapshots = plan.orderedActions.flatMap(getReviewActionDiskSnapshots);
      const retryRecovery = (): Promise<RetryReviewMutationRecoveryResult> =>
        commandPort.retryRecovery({
          scope: scope.review,
          decisionPersistenceScope: toDecisionPersistenceScope(scope.persistence),
          expectedRestore: {
            expectedDecisionRevision: currentRevision,
            persistedState: plan.persistedState,
            diskSteps,
          },
        });
      let retryOriginalRestore = false;
      viewPort.setMutationInFlight(true);
      try {
        const recovered =
          direction === 'undo' || direction === 'redo'
            ? await executeWithPreparedExpectations(diskSnapshots, direction, retryRecovery)
            : await retryRecovery();
        if (!isCurrentOperationScope(operationScope)) return;
        const disposition = classifyReviewHistoryRecovery(
          recovered,
          currentRevision,
          plan.persistedState
        );
        if (disposition === 'retry-restore') {
          for (const snapshot of diskSnapshots) viewPort.clearExpectedWrite(snapshot.filePath);
          retryOriginalRestore = true;
        } else if (disposition === 'different-mutation-pending') {
          for (const snapshot of diskSnapshots) viewPort.clearExpectedWrite(snapshot.filePath);
          throw new Error(
            'A different interrupted review update must be recovered first. Close Restore and retry the saved review state.'
          );
        } else if (disposition === 'apply-selected-restore') {
          if (!recovered.persistedState) {
            throw new Error('Recovered checkpoint state is unavailable. Reload Changes.');
          }
          if (direction !== 'undo' && direction !== 'redo') {
            throw new Error('Recovered review history no longer matches this checkpoint.');
          }
          viewPort.markCommittedPostimages(recovered.diskPostimages);
          applyRestoredHistory(
            recovered.persistedState,
            recovered.decisionRevision,
            direction,
            diskSnapshots,
            plan.orderedActions,
            target
          );
        } else {
          if (!recovered.persistedState) {
            throw new Error(
              'Recovered review state is unavailable. Reload Changes before retrying.'
            );
          }
          for (const snapshot of diskSnapshots) viewPort.clearExpectedWrite(snapshot.filePath);
          synchronizeRecoveredState(
            recovered.persistedState,
            recovered.decisionRevision,
            recovered.recoveredMutation
              ? 'A different interrupted review action was recovered. Latest durable state was loaded; select the checkpoint again.'
              : 'Review history changed while Restore was finishing. Latest durable state was loaded; verify it before continuing.'
          );
        }
      } catch (error) {
        if (!isCurrentOperationScope(operationScope)) return;
        const message =
          error instanceof Error ? error.message : 'Unable to recover the interrupted Restore.';
        statePort.reportError(message);
        throw error instanceof Error ? error : new Error(message);
      } finally {
        if (isCurrentOperationScope(operationScope)) viewPort.setMutationInFlight(false);
      }
      if (retryOriginalRestore && isCurrentOperationScope(operationScope)) {
        await restoreHistory(target);
      }
    },
    [
      applyRestoredHistory,
      buildCurrentRestorePlan,
      captureOperationScope,
      commandPort,
      decisionHydrationReady,
      executeWithPreparedExpectations,
      isCurrentOperationScope,
      restoreHistory,
      scope,
      statePort,
      synchronizeRecoveredState,
      viewPort,
    ]
  );

  return { undoLatest, redoLatest, getRestorePreview, restoreHistory, recoverFailedHistory };
}
