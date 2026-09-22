import { useCallback, useEffect, useMemo } from 'react';

import {
  evaluateChangeReviewCloseReadiness,
  shouldRequestReviewCloseForEscape,
} from '../utils/changeReviewDialogLifecycle';

import { useChangeReviewDecisionAutoPersistence } from './useChangeReviewDecisionAutoPersistence';
import { useChangeReviewLifecycleRegistration } from './useChangeReviewLifecycleRegistration';

import type {
  ChangeReviewDialogLifecycleCommandPort,
  ChangeReviewDialogLifecycleDecisionPersistencePort,
  ChangeReviewDialogLifecycleDraftHistoryPort,
  ChangeReviewDialogLifecycleEditorPort,
  ChangeReviewDialogLifecyclePersistenceScope,
  ChangeReviewDialogLifecycleSessionPort,
  ChangeReviewDialogLifecycleStatePort,
  ChangeReviewDialogLifecycleStatusPort,
  ChangeReviewDialogLifecycleWriteEvidencePort,
} from '../ports/changeReviewDialogLifecyclePorts';
import type {
  RegisterChangeReviewAppCloseParticipant,
  RegisterChangeReviewLifecycleOwner,
} from '../ports/changeReviewLifecyclePorts';
import type { ReviewDraftHistoryHydrationState } from '../utils/changeReviewScope';
import type { ReviewOperationScopeToken } from '../utils/reviewOperationGeneration';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { ReviewFileScope } from '@shared/types';

interface UseChangeReviewDialogLifecycleControllerInput {
  open: boolean;
  authorized: boolean;
  setAuthorized: (authorized: boolean) => void;
  hostId: string;
  sessionId: string;
  tabId: string | undefined;
  focus: (() => void) | undefined;
  teamName: string;
  mode: 'agent' | 'task';
  memberName: string | undefined;
  taskId: string | undefined;
  taskChangeRequestOptions: TaskChangeRequestOptions | undefined;
  scopeKey: string;
  decisionScopeKey: string;
  decisionScopeToken: string | null;
  decisionHydrationKey: string | null;
  decisionHydrationReady: boolean;
  decisionHydrationFailed: boolean;
  draftHistoryHydration: ReviewDraftHistoryHydrationState;
  draftHistoryHydrationFailed: boolean;
  reviewScope: ReviewFileScope;
  reviewMutationBusy: boolean;
  reviewActionsBusy: boolean;
  onOpenChange: (open: boolean) => void;
  statePort: ChangeReviewDialogLifecycleStatePort;
  commandPort: ChangeReviewDialogLifecycleCommandPort;
  editorPort: ChangeReviewDialogLifecycleEditorPort;
  statusPort: ChangeReviewDialogLifecycleStatusPort;
  sessionPort: ChangeReviewDialogLifecycleSessionPort;
  writeEvidencePort: ChangeReviewDialogLifecycleWriteEvidencePort;
  decisionPersistence: ChangeReviewDialogLifecycleDecisionPersistencePort;
  draftHistory: ChangeReviewDialogLifecycleDraftHistoryPort;
  hasActionInFlight: () => boolean;
  blockForExternalChange: () => boolean;
  captureOperationScope: () => ReviewOperationScopeToken | null;
  isCurrentOperationScope: (scope: ReviewOperationScopeToken | null) => boolean;
  registerOwner: RegisterChangeReviewLifecycleOwner;
  registerAppCloseParticipant: RegisterChangeReviewAppCloseParticipant;
}

export interface ChangeReviewDialogLifecycleController {
  requestClose: () => Promise<void>;
  retrySavedReviewState: () => Promise<void>;
  discardSavedDecisionState: () => Promise<void>;
  apply: () => Promise<void>;
}

interface ReviewCloseFlushResult {
  ok: boolean;
  blocker?: string;
}

export function useChangeReviewDialogLifecycleController({
  open,
  authorized,
  setAuthorized,
  hostId,
  sessionId,
  tabId,
  focus,
  teamName,
  mode,
  memberName,
  taskId,
  taskChangeRequestOptions,
  scopeKey,
  decisionScopeKey,
  decisionScopeToken,
  decisionHydrationKey,
  decisionHydrationReady,
  decisionHydrationFailed,
  draftHistoryHydration,
  draftHistoryHydrationFailed,
  reviewScope,
  reviewMutationBusy,
  reviewActionsBusy,
  onOpenChange,
  statePort,
  commandPort,
  editorPort,
  statusPort,
  sessionPort,
  writeEvidencePort,
  decisionPersistence,
  draftHistory,
  hasActionInFlight,
  blockForExternalChange,
  captureOperationScope,
  isCurrentOperationScope,
  registerOwner,
  registerAppCloseParticipant,
}: UseChangeReviewDialogLifecycleControllerInput): ChangeReviewDialogLifecycleController {
  const {
    flushForClose: flushReviewDecisionsForClose,
    getDiagnostics: getDecisionPersistenceDiagnostics,
    scheduleAutoPersistence,
    clearAfterDurableStateEmptied,
  } = decisionPersistence;
  const {
    getEntry: getDraftHistoryEntry,
    flushWrites: flushDraftHistoryWrites,
    retryHydration: retryDraftHistoryHydration,
    discardUnreadableScope: discardUnreadableDraftHistoryScope,
    getDiagnostics: getDraftHistoryDiagnostics,
  } = draftHistory;
  const persistenceScope = useMemo<ChangeReviewDialogLifecyclePersistenceScope | null>(
    () =>
      decisionScopeToken
        ? {
            teamName,
            scopeKey: decisionScopeKey,
            scopeToken: decisionScopeToken,
          }
        : null,
    [decisionScopeKey, decisionScopeToken, teamName]
  );

  useEffect(() => {
    if (!open || !authorized) return;
    commandPort.resetAllReviewState();
    if (mode === 'agent' && memberName) {
      commandPort.fetchAgentChanges(teamName, memberName);
    } else if (mode === 'task' && taskId) {
      commandPort.fetchTaskChanges(teamName, taskId, taskChangeRequestOptions ?? {});
    }
    return () => commandPort.clearChangeReviewCache();
  }, [
    authorized,
    commandPort,
    decisionScopeKey,
    memberName,
    mode,
    open,
    taskChangeRequestOptions,
    taskId,
    teamName,
  ]);

  useEffect(() => {
    if (!open || !authorized || !persistenceScope || !decisionHydrationKey) return;
    void commandPort.hydrateDecisions(persistenceScope, decisionHydrationKey);
  }, [authorized, commandPort, decisionHydrationKey, open, persistenceScope]);

  const renderedState = statePort.getSnapshot();
  const hasDurableReviewState =
    Object.keys(renderedState.hunkDecisions).length > 0 ||
    Object.keys(renderedState.fileDecisions).length > 0 ||
    renderedState.reviewActionHistory.length > 0 ||
    renderedState.reviewRedoHistory.length > 0;
  useChangeReviewDecisionAutoPersistence({
    active: open && authorized,
    hydrationKey: decisionHydrationKey,
    scope: persistenceScope,
    hydrationReady: decisionHydrationReady,
    blocked: reviewActionsBusy,
    hasDurableReviewState,
    hunkDecisions: renderedState.hunkDecisions,
    fileDecisions: renderedState.fileDecisions,
    undoHistory: renderedState.reviewActionHistory,
    redoHistory: renderedState.reviewRedoHistory,
    fileContents: renderedState.fileContents,
    fileChunkCounts: renderedState.fileChunkCounts,
    scheduleAutoPersistence,
    clearAfterDurableStateEmptied,
  });

  const flushReviewStateForClose = useCallback(async (): Promise<ReviewCloseFlushResult> => {
    const operationScope = captureOperationScope();
    if (!operationScope) {
      return {
        ok: false,
        blocker: 'Review scope changed before Changes could close.',
      };
    }
    const scopeChangedResult: ReviewCloseFlushResult = {
      ok: false,
      blocker: 'Review scope changed while Changes was closing.',
    };
    const state = statePort.getSnapshot();
    const draftDiagnostics = getDraftHistoryDiagnostics();
    const decisionDiagnostics = getDecisionPersistenceDiagnostics();
    const hydrationHasError =
      decisionHydrationKey !== null &&
      ((state.decisionHydrationScopeKey === decisionHydrationKey &&
        state.decisionHydrationStatus === 'error') ||
        (draftHistoryHydration.key === decisionHydrationKey &&
          draftHistoryHydration.status === 'error'));
    const scopedDraftDiagnostics = hydrationHasError
      ? getDraftHistoryDiagnostics(decisionHydrationKey)
      : draftDiagnostics;
    const readiness = evaluateChangeReviewCloseReadiness({
      hydrationKey: decisionHydrationKey,
      decisionHydrationScopeKey: state.decisionHydrationScopeKey,
      decisionHydrationStatus: state.decisionHydrationStatus,
      draftHydrationKey: draftHistoryHydration.key,
      draftHydrationStatus: draftHistoryHydration.status,
      editedContentCount: Object.keys(state.editedContents).length,
      hunkDecisionCount: Object.keys(state.hunkDecisions).length,
      fileDecisionCount: Object.keys(state.fileDecisions).length,
      undoHistoryCount: state.reviewActionHistory.length,
      redoHistoryCount: state.reviewRedoHistory.length,
      draftDiagnostics,
      scopedDraftDiagnostics,
      decisionDiagnostics,
      pendingApplyCleanupKey: sessionPort.getPendingApplyCleanupKey(),
      actionLockState: statusPort.getActionLockState(state.applying),
    });
    if (readiness.disposition === 'block') {
      statePort.reportError(readiness.blocker);
      return { ok: false, blocker: readiness.blocker };
    }
    if (readiness.disposition === 'close-without-flush') {
      return { ok: true };
    }

    statusPort.beginClosing();
    try {
      editorPort.captureDraftSnapshots(
        (filePath) => filePath in state.editedContents || Boolean(getDraftHistoryEntry(filePath))
      );
      const currentState = statePort.getSnapshot();
      for (const filePath of Object.keys(currentState.editedContents)) {
        if (!getDraftHistoryEntry(filePath)) {
          const blocker = `Manual edits for ${filePath} are not durable yet. Keep Changes open and retry.`;
          statePort.reportError(blocker);
          return { ok: false, blocker };
        }
      }
      const draftsFlushed = await flushDraftHistoryWrites();
      if (!isCurrentOperationScope(operationScope)) return scopeChangedResult;
      if (!draftsFlushed) {
        const blocker = 'Unable to save manual edit history. Changes remains open.';
        statePort.reportError(blocker);
        return { ok: false, blocker };
      }
      if (persistenceScope && sessionPort.getPendingApplyCleanupKey() === decisionHydrationKey) {
        const cleared = await commandPort.clearDecisions(persistenceScope);
        if (!isCurrentOperationScope(operationScope)) return scopeChangedResult;
        if (!cleared) {
          const blocker =
            'Review was applied, but its saved state could not be cleared. Changes remains open.';
          statePort.reportError(blocker);
          return { ok: false, blocker };
        }
        sessionPort.setPendingApplyCleanupKey(null);
        return { ok: true };
      }
      if (persistenceScope) {
        const flushed = await flushReviewDecisionsForClose();
        if (!isCurrentOperationScope(operationScope)) return scopeChangedResult;
        if (!flushed) {
          const blocker = 'Unable to save review decisions. Changes remains open.';
          statePort.reportError(blocker);
          return { ok: false, blocker };
        }
      }
      return { ok: true };
    } finally {
      if (isCurrentOperationScope(operationScope)) statusPort.finishClosing();
    }
  }, [
    captureOperationScope,
    commandPort,
    decisionHydrationKey,
    draftHistoryHydration.key,
    draftHistoryHydration.status,
    editorPort,
    flushDraftHistoryWrites,
    flushReviewDecisionsForClose,
    getDecisionPersistenceDiagnostics,
    getDraftHistoryDiagnostics,
    getDraftHistoryEntry,
    isCurrentOperationScope,
    persistenceScope,
    sessionPort,
    statePort,
    statusPort,
  ]);

  const requestLifecycleClose = useCallback(async (): Promise<boolean> => {
    const operationScope = captureOperationScope();
    if (!operationScope) return false;
    const result = await flushReviewStateForClose();
    if (!isCurrentOperationScope(operationScope)) return false;
    if (result.ok) onOpenChange(false);
    return result.ok;
  }, [captureOperationScope, flushReviewStateForClose, isCurrentOperationScope, onOpenChange]);

  const requestClose = useCallback(async (): Promise<void> => {
    await requestLifecycleClose();
  }, [requestLifecycleClose]);

  const closeRejectedDialog = useCallback((): void => onOpenChange(false), [onOpenChange]);
  useChangeReviewLifecycleRegistration({
    open,
    authorized,
    hostId,
    sessionId,
    tabId,
    focus,
    requestClose: requestLifecycleClose,
    closeRejectedDialog,
    setAuthorized,
    appCloseParticipantId: `changes:${teamName}:${decisionHydrationKey ?? scopeKey}`,
    flushForAppClose: flushReviewStateForClose,
    registerOwner,
    registerAppCloseParticipant,
  });

  const retrySavedReviewState = useCallback(async (): Promise<void> => {
    if (!persistenceScope || !decisionHydrationKey || reviewMutationBusy) {
      return;
    }
    const operationScope = captureOperationScope();
    if (!operationScope) return;
    statusPort.setRecoveryInFlight(true);
    try {
      if (decisionHydrationFailed) {
        const recovered = await commandPort.retryMutationRecovery({
          scope: reviewScope,
          decisionPersistenceScope: {
            scopeKey: persistenceScope.scopeKey,
            scopeToken: persistenceScope.scopeToken,
          },
        });
        if (!isCurrentOperationScope(operationScope)) return;
        writeEvidencePort.markCommittedPostimages(recovered.diskPostimages);
        await commandPort.hydrateDecisions(persistenceScope, decisionHydrationKey);
        if (!isCurrentOperationScope(operationScope)) return;
      }
      if (draftHistoryHydrationFailed) retryDraftHistoryHydration();
    } catch (error) {
      if (!isCurrentOperationScope(operationScope)) return;
      statePort.reportError(`Unable to resume the saved review update: ${String(error)}`);
    } finally {
      if (isCurrentOperationScope(operationScope)) {
        statusPort.setRecoveryInFlight(false);
      }
    }
  }, [
    captureOperationScope,
    commandPort,
    decisionHydrationFailed,
    decisionHydrationKey,
    draftHistoryHydrationFailed,
    isCurrentOperationScope,
    persistenceScope,
    reviewMutationBusy,
    reviewScope,
    retryDraftHistoryHydration,
    statePort,
    statusPort,
    writeEvidencePort,
  ]);

  const discardSavedDecisionState = useCallback(async (): Promise<void> => {
    if (!persistenceScope || !decisionHydrationKey || reviewMutationBusy) {
      throw new Error('Saved review state is not ready to be discarded.');
    }
    const operationScope = captureOperationScope();
    if (!operationScope) {
      throw new Error('Saved review scope is no longer active.');
    }
    statusPort.beginClosing();
    try {
      if (decisionHydrationFailed) {
        const cleared = await commandPort.clearDecisions(persistenceScope, true);
        if (!isCurrentOperationScope(operationScope)) return;
        if (!cleared) {
          const message = 'Unable to discard the unreadable saved review decisions.';
          statePort.reportError(message);
          throw new Error(message);
        }
      }
      if (draftHistoryHydrationFailed) {
        try {
          const discarded = await discardUnreadableDraftHistoryScope(operationScope);
          if (!discarded) return;
        } catch (error) {
          if (!isCurrentOperationScope(operationScope)) return;
          const message = `Unable to discard the unreadable manual edit history: ${String(error)}`;
          statePort.reportError(message);
          throw new Error(message, { cause: error });
        }
      }
      const state = statePort.getSnapshot();
      if (decisionHydrationFailed && state.decisionHydrationScopeKey !== decisionHydrationKey) {
        throw new Error('Saved review scope changed before it could be discarded.');
      }
      statePort.completeSavedStateDiscard(decisionHydrationFailed);
    } finally {
      if (isCurrentOperationScope(operationScope)) statusPort.finishClosing();
    }
  }, [
    captureOperationScope,
    commandPort,
    decisionHydrationFailed,
    decisionHydrationKey,
    discardUnreadableDraftHistoryScope,
    draftHistoryHydrationFailed,
    isCurrentOperationScope,
    persistenceScope,
    reviewMutationBusy,
    statePort,
    statusPort,
  ]);

  const apply = useCallback(async (): Promise<void> => {
    if (hasActionInFlight() || blockForExternalChange()) return;
    if (!persistenceScope || !decisionHydrationKey) {
      statePort.reportError('Durable review scope is unavailable. Reload Changes before applying.');
      return;
    }
    const operationScope = captureOperationScope();
    if (!operationScope) return;

    if (sessionPort.getPendingApplyCleanupKey() !== decisionHydrationKey) {
      const outcome = await commandPort.applyReview(teamName, taskId, memberName);
      if (!isCurrentOperationScope(operationScope)) return;
      writeEvidencePort.markCommittedPostimages(outcome.result?.diskPostimages);
      if (outcome.status === 'failed') {
        statePort.reportError(outcome.errorMessage);
        return;
      }
      if (!sessionPort.isExpectedHydrationKey(decisionHydrationKey)) return;
      sessionPort.setPendingApplyCleanupKey(decisionHydrationKey);
    }

    statusPort.beginClosing();
    try {
      const cleared = await commandPort.clearDecisions(persistenceScope);
      if (!isCurrentOperationScope(operationScope)) return;
      if (!cleared) {
        statePort.reportError(
          'Review was applied, but its saved state could not be cleared. Changes remains open; retry Apply to finish cleanup.'
        );
        return;
      }
      sessionPort.setPendingApplyCleanupKey(null);
      if (sessionPort.isExpectedHydrationKey(decisionHydrationKey)) {
        commandPort.resetAllReviewState();
      }
    } finally {
      if (isCurrentOperationScope(operationScope)) statusPort.finishClosing();
    }
  }, [
    blockForExternalChange,
    captureOperationScope,
    commandPort,
    decisionHydrationKey,
    hasActionInFlight,
    isCurrentOperationScope,
    memberName,
    persistenceScope,
    sessionPort,
    statePort,
    statusPort,
    taskId,
    teamName,
    writeEvidencePort,
  ]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent): void => {
      if (
        shouldRequestReviewCloseForEscape({
          key: event.key,
          defaultPrevented: event.defaultPrevented,
          hasOpenModalLayer: Boolean(
            document.querySelector('[role="alertdialog"][data-state="open"]')
          ),
        })
      ) {
        event.preventDefault();
        void requestClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, requestClose]);

  return {
    requestClose,
    retrySavedReviewState,
    discardSavedDecisionState,
    apply,
  };
}
