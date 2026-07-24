import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { registerAppCloseParticipant } from '@features/app-close-coordination/renderer';
import {
  browserChangeReviewCollapsedFilesStorage,
  createChangeReviewDialogLifecycleCommandPort,
  createChangeReviewDialogViewPorts,
  useChangeReviewActionHistoryController,
  useChangeReviewConflictDiscoveryController,
  useChangeReviewConflictInteractionController,
  useChangeReviewDecisionPersistenceController,
  useChangeReviewDialogKeyboardInteractions,
  useChangeReviewDialogLifecycleController,
  useChangeReviewDialogViewState,
  useChangeReviewDraftHistoryController,
  useChangeReviewExternalChangeController,
  useChangeReviewFileDraftController,
  useChangeReviewHistoryMutationController,
  useChangeReviewMutationGuards,
  useChangeReviewOperationState,
  useChangeReviewScopeIdentity,
} from '@features/change-review/renderer';
import { api, isElectronMode } from '@renderer/api';
import { useStore } from '@renderer/store';
import { getFileHunkCount, REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';
import {
  buildChangeReviewLifecycleSessionId,
  registerChangeReviewLifecycleOwner,
} from '@renderer/utils/changeReviewLifecycleCoordinator';

import {
  changeReviewActionHistoryStorePort,
  changeReviewConflictCommandPort,
  changeReviewConflictQueryPort,
  changeReviewConflictStateBridge,
  changeReviewDecisionPersistencePort,
  changeReviewDialogLifecycleStatePort,
  changeReviewDialogViewStatePolicy,
  changeReviewDraftHistoryPort,
  changeReviewExternalChangePolicy,
  changeReviewExternalChangeStatePort,
  changeReviewExternalFileWatcherPort,
  changeReviewFileDraftCommandPort,
  changeReviewFileDraftStatePort,
  changeReviewHistoryMutationCommandPort,
  changeReviewHistoryMutationStatePort,
  changeReviewOperationStatePort,
} from './changeReviewDialogComposition';
import { ChangeReviewDialogView } from './ChangeReviewDialogView';
import {
  acceptAllChunks,
  computeChunkIndexAtPos,
  ignoreNextReviewDocChange,
  rejectAllChunks,
  rejectChunk,
} from './CodeMirrorDiffUtils';
import { hasUnresolvedReviewExternalChange, replaceReviewScopedRecord } from './reviewActionState';
import {
  getResolvedReviewModifiedContent,
  isReviewFileMissingOnDisk,
} from './reviewContentPreview';
import { useChangeReviewActionAvailability } from './useChangeReviewActionAvailability';
import { useChangeReviewDecisionActions } from './useChangeReviewDecisionActions';

import type { ReviewDraftHistoryHydrationState } from '@features/change-review/renderer';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type { ReviewRedoAction, ReviewUndoAction } from '@shared/types';
import type { EditorSelectionAction } from '@shared/types/editor';

interface ChangeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  initialFilePath?: string;
  taskChangeRequestOptions?: TaskChangeRequestOptions;
  projectPath?: string;
  onEditorAction?: (action: EditorSelectionAction) => void;
  lifecycleHostId?: string;
  lifecycleTabId?: string;
  onLifecycleFocus?: () => void;
}

export const ChangeReviewDialog = ({
  open,
  onOpenChange,
  teamName,
  mode,
  memberName,
  taskId,
  initialFilePath,
  taskChangeRequestOptions,
  projectPath,
  onEditorAction,
  lifecycleHostId,
  lifecycleTabId,
  onLifecycleFocus,
}: ChangeReviewDialogProps): React.ReactElement | null => {
  const generatedLifecycleHostId = useId();
  const resolvedLifecycleHostId = lifecycleHostId ?? generatedLifecycleHostId;
  const reviewLifecycleSessionId = useMemo(
    () =>
      buildChangeReviewLifecycleSessionId({
        teamName,
        mode,
        memberName,
        taskId,
        taskChangeRequestOptions,
      }),
    [memberName, mode, taskChangeRequestOptions, taskId, teamName]
  );
  const [lifecycleAuthorized, setLifecycleAuthorized] = useState(false);
  const {
    activeChangeSet,
    changeSetLoading,
    changeSetError,
    hunkDecisions,
    fileDecisions,
    reviewActionHistory,
    reviewRedoHistory,
    fileContents,
    fileContentsLoading,
    collapseUnchanged,
    applying,
    applyError,
    setCollapseUnchanged,
    fetchFileContent,
    addReviewFile,
    editedContents,
    reviewExternalChangesByFile,
    fileChunkCounts,
    hunkContextHashesByFile,
    changeSetEpoch,
    decisionHydrationScopeKey,
    decisionHydrationStatus,
    globalTasks,
  } = useStore();

  const [draftHistoryHydration, setDraftHistoryHydration] =
    useState<ReviewDraftHistoryHydrationState>({ key: null, status: 'idle' });
  const {
    scopeKey,
    decisionScopeKey,
    decisionScopeToken,
    decisionHydrationKey,
    decisionHydrationReady,
    decisionHydrationFailed,
    decisionHydrationPending,
    draftHistoryHydrationReady,
    draftHistoryHydrationPending,
    draftHistoryHydrationFailed,
    reviewScope,
    collapseStorageKey,
  } = useChangeReviewScopeIdentity({
    teamName,
    mode,
    memberName,
    taskId,
    taskChangeRequestOptions,
    activeChangeSet,
    decisionHydrationScopeKey,
    decisionHydrationStatus,
    draftHistoryHydration,
  });
  const actionHistory = useChangeReviewActionHistoryController({
    resetKey: `${teamName}\0${scopeKey}\0${changeSetEpoch}`,
    hydrationKey: decisionHydrationKey,
    hydrationScopeKey: decisionHydrationScopeKey,
    hydrationStatus: decisionHydrationStatus,
    hydratedUndoHistory: reviewActionHistory,
    hydratedRedoHistory: reviewRedoHistory,
    store: changeReviewActionHistoryStorePort,
  });
  const {
    getUndoHistory: getReviewUndoHistory,
    getRedoHistory: getReviewRedoHistory,
    getLatestUndoAction,
    getLatestRedoAction,
    completeUndoAction: completeReviewUndoAction,
    completeRedoAction: completeReviewRedoAction,
    replaceHistories: replaceReviewActionHistories,
    clearForFile: clearReviewActionHistoryForFile,
  } = actionHistory;

  const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
  // Exact disk state on which each manual draft started. Map.has() distinguishes
  // a genuinely missing file (null baseline) from an uncaptured baseline.
  const expectedDraftHistoryKeyRef = useRef<string | null>(null);
  const operationState = useChangeReviewOperationState({
    active: open && lifecycleAuthorized,
    decisionHydrationKey,
    fallbackScopeKey: `unscoped:${teamName}:${scopeKey}`,
    changeSetEpoch,
    resetKey: `${teamName}\0${scopeKey}\0${changeSetEpoch}`,
    port: changeReviewOperationStatePort,
  });
  const { captureReviewOperationScope, isCurrentReviewOperationScope } = operationState;

  useLayoutEffect(() => {
    const activeHydrationKey = open && lifecycleAuthorized ? decisionHydrationKey : null;
    expectedDraftHistoryKeyRef.current = activeHydrationKey;
    return () => {
      if (expectedDraftHistoryKeyRef.current === activeHydrationKey) {
        expectedDraftHistoryKeyRef.current = null;
      }
    };
  }, [decisionHydrationKey, lifecycleAuthorized, open]);

  const isExpectedDraftHistoryKey = useCallback(
    (hydrationKey: string): boolean => expectedDraftHistoryKeyRef.current === hydrationKey,
    []
  );
  const conflictScope = useMemo(
    () =>
      decisionScopeToken
        ? { teamName, scopeKey: decisionScopeKey, scopeToken: decisionScopeToken }
        : null,
    [decisionScopeKey, decisionScopeToken, teamName]
  );
  const refreshReviewConflictCandidatesRef = useRef<() => Promise<void>>(async () => {});
  const requestReviewConflictRefresh = useCallback(
    (): Promise<void> => refreshReviewConflictCandidatesRef.current(),
    []
  );
  const decisionPersistence = useChangeReviewDecisionPersistenceController({
    hydrationKey: decisionHydrationKey,
    scope: conflictScope,
    hydrationReady: decisionHydrationReady,
    isExpectedHydrationKey: isExpectedDraftHistoryKey,
    refreshConflictCandidates: requestReviewConflictRefresh,
    port: changeReviewDecisionPersistencePort,
  });
  const {
    status: reviewActionPersistenceStatus,
    getStatus: getReviewActionPersistenceStatus,
    publishSaved: publishReviewActionPersistenceSaved,
    hydrate: hydrateReviewDecisions,
  } = decisionPersistence;
  const hydrateConflictDecisions = useCallback(
    async (scope: NonNullable<typeof conflictScope>, hydrationKey: string): Promise<void> => {
      await hydrateReviewDecisions(scope, hydrationKey);
    },
    [hydrateReviewDecisions]
  );
  const conflictDiscovery = useChangeReviewConflictDiscoveryController({
    active: open && lifecycleAuthorized,
    hydrationKey: decisionHydrationKey,
    scope: conflictScope,
    isExpectedHydrationKey: isExpectedDraftHistoryKey,
    hydrateDecisions: hydrateConflictDecisions,
    clearReportedLoadError: changeReviewConflictStateBridge.clearReportedLoadError,
    reportLoadError: changeReviewConflictStateBridge.reportError,
    port: changeReviewConflictQueryPort,
  });
  const {
    decisionCandidates: decisionConflictCandidates,
    draftHistoryCandidates: draftHistoryConflictCandidates,
    candidateCount: reviewConflictCandidateCount,
    refreshPending: reviewConflictRefreshPending,
    loadError: reviewConflictLoadError,
    refresh: refreshReviewConflictCandidates,
    reset: resetReviewConflictCandidates,
  } = conflictDiscovery;
  useLayoutEffect(() => {
    refreshReviewConflictCandidatesRef.current = refreshReviewConflictCandidates;
  }, [refreshReviewConflictCandidates]);
  const commitHydratedDrafts = useCallback(
    ({
      scopeFilePaths,
      recoveredDrafts,
      externalChanges,
      errorMessage,
    }: {
      scopeFilePaths: string[];
      recoveredDrafts: Record<string, string>;
      externalChanges: Record<string, { type: 'change' }>;
      errorMessage?: string;
    }): void => {
      useStore.setState((state) => ({
        editedContents: replaceReviewScopedRecord(
          state.editedContents,
          scopeFilePaths,
          recoveredDrafts
        ),
        reviewExternalChangesByFile: replaceReviewScopedRecord(
          state.reviewExternalChangesByFile,
          scopeFilePaths,
          externalChanges
        ),
        applyError: errorMessage ?? state.applyError,
      }));
    },
    []
  );
  const reportDraftHistoryError = useCallback((message: string | null): void => {
    useStore.setState({ applyError: message });
  }, []);
  const draftHistory = useChangeReviewDraftHistoryController({
    open,
    changeSetEpoch,
    scopeKey,
    teamName,
    activeChangeSet,
    decisionScopeKey,
    decisionScopeToken,
    decisionHydrationKey,
    draftHistoryHydrationReady,
    reviewScope,
    draftHistoryConflictCandidates,
    setHydration: setDraftHistoryHydration,
    isExpectedHydrationKey: isExpectedDraftHistoryKey,
    refreshConflictCandidates: refreshReviewConflictCandidates,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    commitHydratedDrafts,
    reportError: reportDraftHistoryError,
    port: changeReviewDraftHistoryPort,
  });
  const {
    getEntry: getDraftHistoryEntry,
    hasBaseline: hasDraftHistoryBaseline,
    getBaseline: getDraftHistoryBaseline,
    setBaseline: setDraftHistoryBaseline,
    deleteBaseline: deleteDraftHistoryBaseline,
    unsuppressFile: unsuppressDraftHistoryFile,
    publishCheckpoint: publishDraftHistoryCheckpoint,
    handleSerializedStateChanged,
    flushWrites: flushDraftHistoryWrites,
    clearFile: clearDraftHistoryForFile,
    resolveConflictCandidate: resolveDraftHistoryConflictCandidate,
  } = draftHistory;
  const conflictInteraction = useChangeReviewConflictInteractionController({
    active: open && lifecycleAuthorized,
    hydrationKey: decisionHydrationKey,
    scope: conflictScope,
    decisionCandidates: decisionConflictCandidates,
    draftHistoryCandidates: draftHistoryConflictCandidates,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    isExpectedHydrationKey: isExpectedDraftHistoryKey,
    hydrateDecisions: hydrateConflictDecisions,
    isDecisionHydrationLoaded: changeReviewConflictStateBridge.isDecisionHydrationLoaded,
    publishDecisionPersistenceSaved: publishReviewActionPersistenceSaved,
    resolveDraftHistoryCandidate: resolveDraftHistoryConflictCandidate,
    clearResolutionError: changeReviewConflictStateBridge.clearResolutionError,
    reportResolutionError: changeReviewConflictStateBridge.reportError,
    refreshCandidates: refreshReviewConflictCandidates,
    port: changeReviewConflictCommandPort,
  });

  const { resolvingCandidateId: resolvingConflictCandidateId } = conflictInteraction;

  useEffect(() => {
    if (!open || !lifecycleAuthorized || !decisionHydrationKey) {
      resetReviewConflictCandidates();
      return;
    }
    void refreshReviewConflictCandidates();
  }, [
    decisionHydrationKey,
    lifecycleAuthorized,
    open,
    refreshReviewConflictCandidates,
    resetReviewConflictCandidates,
  ]);

  const readCurrentReviewDiskContent = useCallback(
    async (filePath: string, fallback: string): Promise<string> => {
      try {
        const result = await api.review.checkConflict(
          { teamName, taskId, memberName },
          filePath,
          fallback
        );
        return result.currentContent;
      } catch {
        // The guarded Undo write still fails closed if this best-effort refresh is unavailable.
        return fallback;
      }
    },
    [memberName, taskId, teamName]
  );

  const mutationGuards = useChangeReviewMutationGuards({
    applying,
    operation: operationState,
    decisionScopeToken,
    decisionHydrationKey,
    decisionHydrationReady,
    draftHistoryHydration,
    draftHistoryHydrationReady,
    conflict: {
      refreshPending: reviewConflictRefreshPending,
      loadError: reviewConflictLoadError,
      candidateCount: reviewConflictCandidateCount,
      resolvingCandidateId: resolvingConflictCandidateId,
    },
    persistenceStatus: reviewActionPersistenceStatus,
    getPersistenceStatus: getReviewActionPersistenceStatus,
    port: changeReviewOperationStatePort,
  });
  const { reviewMutationBusy, reviewActionsBusy, hasReviewActionInFlight } = mutationGuards;

  const hasReviewDraft = useCallback(
    (filePath: string): boolean => filePath in useStore.getState().editedContents,
    []
  );
  const hasData =
    lifecycleAuthorized &&
    !changeSetLoading &&
    !changeSetError &&
    !!activeChangeSet &&
    (decisionHydrationKey === null || (decisionHydrationReady && draftHistoryHydrationReady));
  const reportReviewInteractionError = useCallback((message: string): void => {
    useStore.setState({ applyError: message });
  }, []);
  const dialogViewState = useChangeReviewDialogViewState({
    open,
    hasData,
    teamName,
    scopeKey,
    collapseStorageKey,
    initialFilePath,
    activeChangeSet,
    fileContents,
    fileContentsLoading,
    storage: browserChangeReviewCollapsedFilesStorage,
    policy: changeReviewDialogViewStatePolicy,
    reportError: reportReviewInteractionError,
  });
  const {
    activeFilePath,
    activeFilePathRef,
    activeEditorViewRef,
    editorViewMapRef,
    getEditorFilePathForTarget,
    handleHistoryActionNavigation,
    scrollToFile,
    sortedFiles,
    watchedReviewFilePathsKey,
  } = dialogViewState;
  const {
    rejectableFiles: rejectablePendingFiles,
    canAcceptAll,
    canRejectAll,
  } = useChangeReviewActionAvailability({
    files: sortedFiles,
    fileContents,
    editedContents,
    hunkDecisions,
    fileDecisions,
    fileChunkCounts,
  });
  const editedCount = Object.keys(editedContents).length;
  const externalChangeController = useChangeReviewExternalChangeController({
    open,
    enabled: isElectronMode(),
    projectPath,
    watchedFilePathsKey: watchedReviewFilePathsKey,
    reviewScope,
    externalChangesByFile: reviewExternalChangesByFile,
    recentWritesRef: operationState.viewPortBindings.recentReviewWritesRef,
    isMutationInFlight: operationState.isPathMutationInFlight,
    getDraftHistoryEntry,
    statePort: changeReviewExternalChangeStatePort,
    policy: changeReviewExternalChangePolicy,
    watcherPort: changeReviewExternalFileWatcherPort,
  });
  const { blockReviewMutationForExternalChange } = externalChangeController;
  const dialogViewPorts = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- Factory only captures refs for later callbacks.
      createChangeReviewDialogViewPorts({
        editorViewMapRef,
        editorActions: {
          acceptAllChunks,
          computeChunkIndexAtPosition: computeChunkIndexAtPos,
          ignoreNextDocChange: ignoreNextReviewDocChange,
          rejectAllChunks,
          rejectChunk,
        },
        subscribeToRejectCurrentHunk: (callback) => window.electronAPI?.review.onCmdN?.(callback),
        ...operationState.viewPortBindings,
        expectedDraftHistoryKeyRef,
        setDiscardCounters,
        handleSerializedStateChanged,
        addReviewFile,
        fetchFileContent,
        navigateToHistoryAction: handleHistoryActionNavigation,
      }),
    [
      addReviewFile,
      editorViewMapRef,
      fetchFileContent,
      handleHistoryActionNavigation,
      handleSerializedStateChanged,
      operationState.viewPortBindings,
    ]
  );
  const decisionActions = useChangeReviewDecisionActions({
    activeChangeSet,
    fileContents,
    fileChunkCounts,
    rejectableFiles: rejectablePendingFiles,
    canAcceptAll,
    changeSetEpoch,
    teamName,
    taskId,
    memberName,
    reviewScope,
    decisionScopeKey,
    decisionScopeToken,
    editorViewMapRef,
    readCurrentDiskContent: readCurrentReviewDiskContent,
    hasDraft: hasReviewDraft,
    history: actionHistory,
    persistence: decisionPersistence,
    mutationGuards,
    operation: operationState,
    externalChange: externalChangeController,
    viewPorts: dialogViewPorts,
  });
  const { acceptHunk: handleHunkAccepted, rejectHunk: handleHunkRejected } = decisionActions;

  const fileDraftPersistenceScope = useMemo(
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
  const fileDraftActionHistory = useMemo(
    () => ({
      clearForFile: clearReviewActionHistoryForFile,
      getUndoHistory: getReviewUndoHistory,
      getRedoHistory: getReviewRedoHistory,
      replaceHistories: replaceReviewActionHistories,
    }),
    [
      clearReviewActionHistoryForFile,
      getReviewRedoHistory,
      getReviewUndoHistory,
      replaceReviewActionHistories,
    ]
  );
  const fileDraftHistory = useMemo(
    () => ({
      getEntry: getDraftHistoryEntry,
      hasBaseline: hasDraftHistoryBaseline,
      getBaseline: getDraftHistoryBaseline,
      setBaseline: setDraftHistoryBaseline,
      deleteBaseline: deleteDraftHistoryBaseline,
      unsuppressFile: unsuppressDraftHistoryFile,
      publishCheckpoint: publishDraftHistoryCheckpoint,
      flushWrites: flushDraftHistoryWrites,
      clearFile: clearDraftHistoryForFile,
    }),
    [
      clearDraftHistoryForFile,
      deleteDraftHistoryBaseline,
      flushDraftHistoryWrites,
      getDraftHistoryBaseline,
      getDraftHistoryEntry,
      hasDraftHistoryBaseline,
      publishDraftHistoryCheckpoint,
      setDraftHistoryBaseline,
      unsuppressDraftHistoryFile,
    ]
  );
  const fileDraftActions = useChangeReviewFileDraftController({
    files: activeChangeSet?.files ?? [],
    fileContents,
    teamName,
    memberName,
    reviewScope,
    persistenceScope: fileDraftPersistenceScope,
    actionHistory: fileDraftActionHistory,
    draftHistory: fileDraftHistory,
    statePort: changeReviewFileDraftStatePort,
    commandPort: changeReviewFileDraftCommandPort,
    statusPort: dialogViewPorts.fileDraft.status,
    writeEvidencePort: dialogViewPorts.fileDraft.writeEvidence,
    hasActionInFlight: hasReviewActionInFlight,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    resolveModifiedContent: getResolvedReviewModifiedContent,
    isFileMissingOnDisk: isReviewFileMissingOnDisk,
    hasUnresolvedExternalChange: hasUnresolvedReviewExternalChange,
  });
  const { saveFile: handleSaveFile } = fileDraftActions;

  const reviewHistoryMutationScope = useMemo(
    () =>
      decisionScopeToken
        ? {
            review: reviewScope,
            persistence: {
              teamName,
              scopeKey: decisionScopeKey,
              scopeToken: decisionScopeToken,
            },
          }
        : null,
    [decisionScopeKey, decisionScopeToken, reviewScope, teamName]
  );
  const reviewHistoryActions = useMemo(
    () => ({
      getUndoHistory: () => getReviewUndoHistory(),
      getRedoHistory: () => getReviewRedoHistory(),
      getLatestUndoAction: () => getLatestUndoAction(),
      getLatestRedoAction: () => getLatestRedoAction(),
      completeUndoAction: (action: ReviewUndoAction, redoAction: ReviewRedoAction) =>
        completeReviewUndoAction(action, redoAction),
      completeRedoAction: (redoAction: ReviewRedoAction) => completeReviewRedoAction(redoAction),
      replaceHistories: (undoHistory: ReviewUndoAction[], redoHistory: ReviewRedoAction[]) =>
        replaceReviewActionHistories(undoHistory, redoHistory),
    }),
    [
      completeReviewRedoAction,
      completeReviewUndoAction,
      getLatestRedoAction,
      getLatestUndoAction,
      getReviewRedoHistory,
      getReviewUndoHistory,
      replaceReviewActionHistories,
    ]
  );
  const historyMutation = useChangeReviewHistoryMutationController({
    teamName,
    memberName,
    files: activeChangeSet?.files ?? [],
    editedCount,
    decisionHydrationReady,
    scope: reviewHistoryMutationScope,
    history: reviewHistoryActions,
    commandPort: changeReviewHistoryMutationCommandPort,
    statePort: changeReviewHistoryMutationStatePort,
    viewPort: dialogViewPorts.historyMutation,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    hasActionInFlight: hasReviewActionInFlight,
    isFileMutationInFlight: operationState.isFileMutationInFlight,
    blockForExternalChange: blockReviewMutationForExternalChange,
    getPersistenceStatus: getReviewActionPersistenceStatus,
  });
  const { undoLatest: handleUndoLatestReviewAction, redoLatest: handleRedoLatestReviewAction } =
    historyMutation;

  const dialogLifecycleCommandPort = useMemo(
    () =>
      createChangeReviewDialogLifecycleCommandPort({
        getStore: useStore.getState,
        getReviewApi: () => api.review,
        hydrateDecisions: hydrateReviewDecisions,
      }),
    [hydrateReviewDecisions]
  );
  const dialogLifecycle = useChangeReviewDialogLifecycleController({
    open,
    authorized: lifecycleAuthorized,
    setAuthorized: setLifecycleAuthorized,
    hostId: resolvedLifecycleHostId,
    sessionId: reviewLifecycleSessionId,
    tabId: lifecycleTabId,
    focus: onLifecycleFocus,
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
    statePort: changeReviewDialogLifecycleStatePort,
    commandPort: dialogLifecycleCommandPort,
    editorPort: dialogViewPorts.lifecycle.editor,
    statusPort: dialogViewPorts.lifecycle.status,
    sessionPort: dialogViewPorts.lifecycle.session,
    writeEvidencePort: dialogViewPorts.lifecycle.writeEvidence,
    decisionPersistence,
    draftHistory,
    hasActionInFlight: hasReviewActionInFlight,
    blockForExternalChange: blockReviewMutationForExternalChange,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    registerOwner: registerChangeReviewLifecycleOwner,
    registerAppCloseParticipant,
  });
  const { requestClose } = dialogLifecycle;

  const keyboardInteractions = useChangeReviewDialogKeyboardInteractions({
    open,
    activeFilePath,
    activeFilePathRef,
    activeEditorViewRef,
    editorViewMapRef,
    sortedFiles,
    fileChunkCounts,
    editedCount,
    scrollToFile,
    saveFile: handleSaveFile,
    requestClose,
    acceptHunk: handleHunkAccepted,
    rejectHunk: handleHunkRejected,
    hasDraft: hasReviewDraft,
    hasActionInFlight: hasReviewActionInFlight,
    getEditorFilePathForTarget,
    getHunkCountForFile: getFileHunkCount,
    getUndoHistory: getReviewUndoHistory,
    getRedoHistory: getReviewRedoHistory,
    undoLatest: handleUndoLatestReviewAction,
    redoLatest: handleRedoLatestReviewAction,
    reportError: reportReviewInteractionError,
    keyboardPort: dialogViewPorts.keyboardInteraction,
  });
  return (
    <ChangeReviewDialogView
      open={open}
      teamName={teamName}
      mode={mode}
      memberName={memberName}
      taskId={taskId}
      globalTasks={globalTasks}
      activeChangeSet={activeChangeSet}
      changeSetLoading={changeSetLoading}
      changeSetError={changeSetError}
      fileContents={fileContents}
      fileContentsLoading={fileContentsLoading}
      hunkDecisions={hunkDecisions}
      fileDecisions={fileDecisions}
      fileChunkCounts={fileChunkCounts}
      hunkContextHashesByFile={hunkContextHashesByFile}
      editedContents={editedContents}
      reviewExternalChangesByFile={reviewExternalChangesByFile}
      collapseUnchanged={collapseUnchanged}
      setCollapseUnchanged={setCollapseUnchanged}
      applyError={applyError}
      reviewActionHistory={reviewActionHistory}
      reviewRedoHistory={reviewRedoHistory}
      reviewActionPersistenceStatus={reviewActionPersistenceStatus}
      hydration={{
        decisionKey: decisionHydrationKey,
        decisionReady: decisionHydrationReady,
        decisionPending: decisionHydrationPending,
        decisionFailed: decisionHydrationFailed,
        draftReady: draftHistoryHydrationReady,
        draftPending: draftHistoryHydrationPending,
        draftFailed: draftHistoryHydrationFailed,
      }}
      canAcceptAll={canAcceptAll}
      canRejectAll={canRejectAll}
      instantApply={REVIEW_INSTANT_APPLY}
      editedCount={editedCount}
      discardCounters={discardCounters}
      fetchFileContent={fetchFileContent}
      onEditorAction={onEditorAction}
      actionHistory={actionHistory}
      conflictDiscovery={conflictDiscovery}
      conflictInteraction={conflictInteraction}
      decisionPersistence={decisionPersistence}
      decisionActions={decisionActions}
      dialogLifecycle={dialogLifecycle}
      dialogViewState={dialogViewState}
      draftHistory={draftHistory}
      externalChange={externalChangeController}
      fileDraftActions={fileDraftActions}
      historyMutation={historyMutation}
      keyboard={keyboardInteractions}
      mutationGuards={mutationGuards}
      operation={operationState}
    />
  );
};
