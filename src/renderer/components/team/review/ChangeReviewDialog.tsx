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
  buildChangeReviewTitle,
  buildReviewChangeStats,
  buildReviewStats,
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
  ChangeReviewSidebar,
  createChangeReviewBulkDecisionCommandPort,
  createChangeReviewDialogLifecycleCommandPort,
  createChangeReviewDialogViewPorts,
  createChangeReviewFileDecisionCommandPort,
  createChangeReviewHunkDecisionCommandPort,
  shouldShowTaskScopeBanner,
  TaskChangesEmptyState,
  toTaskChangeSetV2,
  useChangeReviewActionHistoryController,
  useChangeReviewBulkDecisionController,
  useChangeReviewConflictDiscoveryController,
  useChangeReviewConflictInteractionController,
  useChangeReviewDecisionPersistenceController,
  useChangeReviewDialogKeyboardInteractions,
  useChangeReviewDialogLifecycleController,
  useChangeReviewDialogViewState,
  useChangeReviewDraftHistoryController,
  useChangeReviewExternalChangeController,
  useChangeReviewFileDecisionController,
  useChangeReviewFileDraftController,
  useChangeReviewHistoryMutationController,
  useChangeReviewHunkDecisionController,
  useChangeReviewMutationGuards,
  useChangeReviewOperationState,
  useChangeReviewScopeIdentity,
} from '@features/change-review/renderer';
import { api, isElectronMode } from '@renderer/api';
import { EditorSelectionMenu } from '@renderer/components/team/editor/EditorSelectionMenu';
import { useStore } from '@renderer/store';
import { getFileHunkCount, REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';
import { buildSelectionAction } from '@renderer/utils/buildSelectionAction';
import {
  buildChangeReviewLifecycleSessionId,
  registerChangeReviewLifecycleOwner,
} from '@renderer/utils/changeReviewLifecycleCoordinator';
import { getFileReviewKey } from '@renderer/utils/reviewKey';
import { X } from 'lucide-react';

import {
  changeReviewActionHistoryStorePort,
  changeReviewBulkDecisionStatePort,
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
  changeReviewFileDecisionPolicy,
  changeReviewFileDecisionStatePort,
  changeReviewFileDraftCommandPort,
  changeReviewFileDraftStatePort,
  changeReviewHistoryMutationCommandPort,
  changeReviewHistoryMutationStatePort,
  changeReviewHunkDecisionPolicy,
  changeReviewHunkDecisionStatePort,
  changeReviewOperationStatePort,
} from './changeReviewDialogComposition';
import { ChangesLoadingAnimation } from './ChangesLoadingAnimation';
import {
  acceptAllChunks,
  computeChunkIndexAtPos,
  ignoreNextReviewDocChange,
  rejectAllChunks,
  rejectChunk,
} from './CodeMirrorDiffUtils';
import { ContinuousScrollView } from './ContinuousScrollView';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { buildPathChangeLabels } from './pathChangeLabels';
import {
  getReviewRenameRecoveryExpectation,
  hasUnresolvedReviewExternalChange,
  isReviewFileFullyRejected,
  replaceReviewScopedRecord,
  resolveReviewFileIsNew,
  shouldDeleteFileWhenUndoingReject,
} from './reviewActionState';
import {
  getResolvedReviewModifiedContent,
  isReviewAcceptDisabled,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
  isReviewTextContentUnavailable,
} from './reviewContentPreview';
import { ReviewToolbar } from './ReviewToolbar';
import { SavedReviewStateRecoveryGate } from './SavedReviewStateRecoveryGate';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { ReviewDraftHistoryHydrationState } from '@features/change-review/renderer';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  FileChangeSummary,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';
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
  const {
    undoDepth: reviewUndoDepth,
    redoDepth: reviewRedoDepth,
    getUndoHistory: getReviewUndoHistory,
    getRedoHistory: getReviewRedoHistory,
    getLatestUndoAction,
    getLatestRedoAction,
    pushUndoAction: pushReviewUndoAction,
    completeUndoAction: completeReviewUndoAction,
    bindCommittedAction: bindCommittedReviewAction,
    completeRedoAction: completeReviewRedoAction,
    discardLatestAction: discardLatestReviewAction,
    publishUndoHistory: publishReviewUndoHistory,
    replaceHistories: replaceReviewActionHistories,
    clearForFile: clearReviewActionHistoryForFile,
  } = useChangeReviewActionHistoryController({
    resetKey: `${teamName}\0${scopeKey}\0${changeSetEpoch}`,
    hydrationKey: decisionHydrationKey,
    hydrationScopeKey: decisionHydrationScopeKey,
    hydrationStatus: decisionHydrationStatus,
    hydratedUndoHistory: reviewActionHistory,
    hydratedRedoHistory: reviewRedoHistory,
    store: changeReviewActionHistoryStorePort,
  });

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
  const { filesApplying, captureReviewOperationScope, isCurrentReviewOperationScope } =
    operationState;

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
    persistLatest: persistLatestAcceptedReviewAction,
  } = decisionPersistence;
  const hydrateConflictDecisions = useCallback(
    async (scope: NonNullable<typeof conflictScope>, hydrationKey: string): Promise<void> => {
      await hydrateReviewDecisions(scope, hydrationKey);
    },
    [hydrateReviewDecisions]
  );
  const {
    decisionCandidates: decisionConflictCandidates,
    draftHistoryCandidates: draftHistoryConflictCandidates,
    candidateCount: reviewConflictCandidateCount,
    refreshPending: reviewConflictRefreshPending,
    loadError: reviewConflictLoadError,
    refresh: refreshReviewConflictCandidates,
    reset: resetReviewConflictCandidates,
  } = useChangeReviewConflictDiscoveryController({
    active: open && lifecycleAuthorized,
    hydrationKey: decisionHydrationKey,
    scope: conflictScope,
    isExpectedHydrationKey: isExpectedDraftHistoryKey,
    hydrateDecisions: hydrateConflictDecisions,
    clearReportedLoadError: changeReviewConflictStateBridge.clearReportedLoadError,
    reportLoadError: changeReviewConflictStateBridge.reportError,
    port: changeReviewConflictQueryPort,
  });
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
    entries: draftHistoryEntries,
    getEntry: getDraftHistoryEntry,
    hasBaseline: hasDraftHistoryBaseline,
    getBaseline: getDraftHistoryBaseline,
    setBaseline: setDraftHistoryBaseline,
    deleteBaseline: deleteDraftHistoryBaseline,
    unsuppressFile: unsuppressDraftHistoryFile,
    publishCheckpoint: publishDraftHistoryCheckpoint,
    handleSerializedStateChanged,
    handleSerializedStateRestoreError,
    flushWrites: flushDraftHistoryWrites,
    clearFile: clearDraftHistoryForFile,
    resolveConflictCandidate: resolveDraftHistoryConflictCandidate,
  } = draftHistory;

  const {
    activeCandidate: activeReviewConflictCandidate,
    activeCandidateRecoverable: activeReviewConflictRecoverable,
    resolvingCandidateId: resolvingConflictCandidateId,
    pendingDiscard: pendingRecoveryDiscard,
    requestDiscard: requestRecoveryDiscard,
    onDiscardOpenChange: handleRecoveryDiscardOpenChange,
    confirmPendingDiscard: confirmRecoveryDiscard,
    resolveActiveCandidate: handleResolveReviewConflictCandidate,
  } = useChangeReviewConflictInteractionController({
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

  const {
    reviewMutationBusy,
    reviewActionsBusy,
    reviewCloseBusy,
    hasReviewActionInFlight,
    ensureDurableReviewScope,
  } = useChangeReviewMutationGuards({
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
  const {
    activeFile,
    activeFilePath,
    activeFilePathRef,
    activeEditorViewRef,
    autoViewed,
    clearSelection,
    collapsedFiles,
    containerRect,
    diffContentRef,
    editorViewMapRef,
    getEditorFilePathForTarget,
    globalDiffLoadingState,
    handleFullyViewed,
    handleHistoryActionNavigation,
    handleSelectionChange,
    handleTreeFileClick,
    handleVisibleFileChange,
    isProgrammaticScroll,
    resolveReviewFileLabel,
    scrollContainerRef,
    scrollToFile,
    selectionInfo,
    setAutoViewed,
    setTimelineOpen,
    sortedFiles,
    timelineOpen,
    toggleCollapsedFile,
    viewedCount,
    viewedProgress,
    viewedSet,
    viewedTotalCount,
    watchedReviewFilePathsKey,
  } = useChangeReviewDialogViewState({
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
  const pathChangeLabels = useMemo(() => {
    return buildPathChangeLabels(activeChangeSet?.files ?? [], fileContents);
  }, [activeChangeSet, fileContents]);
  const rejectablePendingFiles = useMemo(
    () =>
      sortedFiles.filter((file) => {
        const reviewKey = getFileReviewKey(file);
        const fileDecision = fileDecisions[reviewKey] ?? fileDecisions[file.filePath] ?? 'pending';
        if (fileDecision !== 'pending') return false;
        if (file.filePath in editedContents) return false;
        const count = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
        if (
          isReviewFileFullyRejected(file, count, {
            hunkDecisions,
            fileDecisions,
          })
        ) {
          return false;
        }
        return isReviewRejectable(file, fileContents[file.filePath] ?? null);
      }),
    [editedContents, fileChunkCounts, fileContents, fileDecisions, hunkDecisions, sortedFiles]
  );
  const canRejectAll = rejectablePendingFiles.length > 0;
  const canAcceptAll = useMemo(
    () =>
      sortedFiles.length > 0 &&
      sortedFiles.every((file) => {
        if (!(file.filePath in fileContents) || file.filePath in editedContents) return false;
        const content = fileContents[file.filePath] ?? null;
        const reviewKey = getFileReviewKey(file);
        const fileDecision = fileDecisions[reviewKey] ?? fileDecisions[file.filePath];
        return !isReviewAcceptDisabled({
          hasEdits: false,
          isMissingOnDisk: isReviewFileMissingOnDisk(content),
          isContentUnavailable: isReviewTextContentUnavailable(file, content),
          fileDecision,
        });
      }),
    [editedContents, fileContents, fileDecisions, sortedFiles]
  );
  const editedCount = Object.keys(editedContents).length;
  const { reviewMutationBlockedByExternalChange, blockReviewMutationForExternalChange } =
    useChangeReviewExternalChangeController({
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
  const buildBulkRejectDiskSnapshot = useCallback(
    (
      file: FileChangeSummary,
      decisionSnapshot: ReviewDecisionSnapshot
    ): ReviewDiskUndoSnapshot | null => {
      const content = fileContents[file.filePath] ?? null;
      const isNewFile = resolveReviewFileIsNew(file, content);
      const hunkCount = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
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
  const bulkDecisionCommandPort = useMemo(
    () =>
      createChangeReviewBulkDecisionCommandPort({
        getStore: useStore.getState,
        readCurrentDiskContent: readCurrentReviewDiskContent,
      }),
    [readCurrentReviewDiskContent]
  );
  const { acceptAll: handleAcceptAll, rejectAll: handleRejectAll } =
    useChangeReviewBulkDecisionController({
      active: activeChangeSet !== null,
      files: activeChangeSet?.files ?? [],
      rejectableFiles: rejectablePendingFiles,
      canAcceptAll,
      changeSetEpoch,
      instantApply: REVIEW_INSTANT_APPLY,
      teamName,
      taskId,
      memberName,
      history: {
        pushUndoAction: pushReviewUndoAction,
        bindCommittedAction: bindCommittedReviewAction,
        discardLatestAction: discardLatestReviewAction,
        getLatestUndoAction,
        publishUndoHistory: publishReviewUndoHistory,
      },
      statePort: changeReviewBulkDecisionStatePort,
      commandPort: bulkDecisionCommandPort,
      editorPort: dialogViewPorts.bulkDecision.editor,
      statusPort: dialogViewPorts.bulkDecision.status,
      writeEvidencePort: dialogViewPorts.bulkDecision.writeEvidence,
      buildRejectDiskSnapshot: buildBulkRejectDiskSnapshot,
      persistLatestAcceptedAction: persistLatestAcceptedReviewAction,
      ensureDurableScope: ensureDurableReviewScope,
      hasActionInFlight: hasReviewActionInFlight,
      blockForExternalChange: blockReviewMutationForExternalChange,
      captureOperationScope: captureReviewOperationScope,
      isCurrentOperationScope: isCurrentReviewOperationScope,
    });
  const fileDecisionCommandPort = useMemo(
    () =>
      createChangeReviewFileDecisionCommandPort({
        getStore: useStore.getState,
        getReviewApi: () => api.review,
        readCurrentDiskContent: readCurrentReviewDiskContent,
      }),
    [readCurrentReviewDiskContent]
  );
  const { acceptFile: handleAcceptFile, rejectFile: handleRejectFile } =
    useChangeReviewFileDecisionController({
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
      history: {
        pushUndoAction: pushReviewUndoAction,
        bindCommittedAction: bindCommittedReviewAction,
        discardLatestAction: discardLatestReviewAction,
        getUndoHistory: getReviewUndoHistory,
        getRedoHistory: getReviewRedoHistory,
        publishUndoHistory: publishReviewUndoHistory,
      },
      statePort: changeReviewFileDecisionStatePort,
      commandPort: fileDecisionCommandPort,
      editorPort: dialogViewPorts.fileDecision.editor,
      statusPort: dialogViewPorts.fileDecision.status,
      writeEvidencePort: dialogViewPorts.fileDecision.writeEvidence,
      policy: changeReviewFileDecisionPolicy,
      persistLatestAcceptedAction: persistLatestAcceptedReviewAction,
      ensureDurableScope: ensureDurableReviewScope,
      hasDraft: hasReviewDraft,
      hasActionInFlight: hasReviewActionInFlight,
      blockForExternalChange: blockReviewMutationForExternalChange,
      captureOperationScope: captureReviewOperationScope,
      isCurrentOperationScope: isCurrentReviewOperationScope,
    });

  // Per-file callbacks for ContinuousScrollView
  const hunkDecisionCommandPort = useMemo(
    () =>
      createChangeReviewHunkDecisionCommandPort({
        getStore: useStore.getState,
        readCurrentDiskContent: readCurrentReviewDiskContent,
      }),
    [readCurrentReviewDiskContent]
  );
  const hunkDecisionHistoryPort = useMemo(
    () => ({
      pushUndoAction: pushReviewUndoAction,
      bindCommittedAction: bindCommittedReviewAction,
      discardLatestAction: discardLatestReviewAction,
      publishUndoHistory: publishReviewUndoHistory,
    }),
    [
      bindCommittedReviewAction,
      discardLatestReviewAction,
      publishReviewUndoHistory,
      pushReviewUndoAction,
    ]
  );
  const { acceptHunk: handleHunkAccepted, rejectHunk: handleHunkRejected } =
    useChangeReviewHunkDecisionController({
      files: activeChangeSet?.files ?? [],
      fileContents,
      changeSetEpoch,
      instantApply: REVIEW_INSTANT_APPLY,
      teamName,
      taskId,
      memberName,
      statePort: changeReviewHunkDecisionStatePort,
      commandPort: hunkDecisionCommandPort,
      editorPort: dialogViewPorts.hunkDecision.editor,
      statusPort: dialogViewPorts.hunkDecision.status,
      historyPort: hunkDecisionHistoryPort,
      writeEvidencePort: dialogViewPorts.hunkDecision.writeEvidence,
      policy: changeReviewHunkDecisionPolicy,
      persistLatestAcceptedAction: persistLatestAcceptedReviewAction,
      ensureDurableScope: ensureDurableReviewScope,
      hasDraft: hasReviewDraft,
      hasActionInFlight: hasReviewActionInFlight,
      blockForExternalChange: blockReviewMutationForExternalChange,
      captureOperationScope: captureReviewOperationScope,
      isCurrentOperationScope: isCurrentReviewOperationScope,
    });

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
  const {
    contentChanged: handleContentChanged,
    saveFile: handleSaveFile,
    restoreMissingFile: handleRestoreMissingFile,
    reloadFromDisk: handleReloadFromDisk,
    keepDraft: handleKeepDraft,
    discardFile: handleDiscardFile,
  } = useChangeReviewFileDraftController({
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
  const {
    undoLatest: handleUndoLatestReviewAction,
    redoLatest: handleRedoLatestReviewAction,
    getRestorePreview: getRestoreReviewHistoryPreview,
    restoreHistory: handleRestoreReviewHistory,
    recoverFailedHistory: handleRecoverFailedReviewHistory,
  } = useChangeReviewHistoryMutationController({
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

  const dialogLifecycleCommandPort = useMemo(
    () =>
      createChangeReviewDialogLifecycleCommandPort({
        getStore: useStore.getState,
        getReviewApi: () => api.review,
        hydrateDecisions: hydrateReviewDecisions,
      }),
    [hydrateReviewDecisions]
  );
  const {
    requestClose,
    retrySavedReviewState: handleRetrySavedReviewState,
    discardSavedDecisionState: handleDiscardSavedDecisionState,
    apply: handleApply,
  } = useChangeReviewDialogLifecycleController({
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

  const { diffNav, reviewHunkOrder } = useChangeReviewDialogKeyboardInteractions({
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
  // Compute toolbar stats using actual CM chunk count (not snippet count)
  const reviewStats = useMemo(
    () =>
      buildReviewStats({
        changeSet: activeChangeSet,
        hunkDecisions,
        fileDecisions,
        fileChunkCounts,
      }),
    [activeChangeSet, hunkDecisions, fileDecisions, fileChunkCounts]
  );
  const changeStats = useMemo(() => buildReviewChangeStats(activeChangeSet), [activeChangeSet]);
  const taskChangeSet = toTaskChangeSetV2(activeChangeSet);
  const hasReviewFiles = (activeChangeSet?.files.length ?? 0) > 0;
  const shouldShowScopeBanner = shouldShowTaskScopeBanner({ mode, changeSet: taskChangeSet });

  const title = useMemo(
    () => buildChangeReviewTitle({ mode, memberName, taskId, globalTasks }),
    [mode, memberName, taskId, globalTasks]
  );

  const isMacElectron =
    isElectronMode() && window.navigator.userAgent.toLowerCase().includes('mac');

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      {/* Header */}
      <div
        className="flex items-center justify-between border-b border-border bg-surface-sidebar px-4 py-3"
        style={
          {
            paddingLeft: isMacElectron
              ? 'var(--macos-traffic-light-padding-left, 72px)'
              : undefined,
            WebkitAppRegion: isMacElectron ? 'drag' : undefined,
          } as React.CSSProperties
        }
      >
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-text">{title}</h2>
          {activeChangeSet && (
            <ViewedProgressBar
              viewed={viewedCount}
              total={viewedTotalCount}
              progress={viewedProgress}
            />
          )}
        </div>
        <button
          type="button"
          aria-label="Close Changes"
          onClick={() => void requestClose()}
          disabled={reviewCloseBusy || decisionHydrationPending || draftHistoryHydrationPending}
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text disabled:cursor-not-allowed disabled:opacity-50"
          style={{ WebkitAppRegion: 'no-drag' } as React.CSSProperties}
        >
          <X className="size-4" />
        </button>
      </div>

      {/* Keyboard shortcuts help */}
      <KeyboardShortcutsHelp
        open={diffNav.showShortcutsHelp}
        onOpenChange={diffNav.setShowShortcutsHelp}
      />

      <ChangeReviewConflictDiscardDialog
        pendingDiscard={pendingRecoveryDiscard}
        resolvingCandidateId={resolvingConflictCandidateId}
        onOpenChange={handleRecoveryDiscardOpenChange}
        onConfirm={confirmRecoveryDiscard}
      />

      {/* Review toolbar */}
      {!changeSetLoading &&
        !changeSetError &&
        decisionHydrationReady &&
        draftHistoryHydrationReady &&
        activeChangeSet &&
        hasReviewFiles && (
          <ReviewToolbar
            stats={reviewStats}
            changeStats={changeStats}
            collapseUnchanged={collapseUnchanged}
            applying={reviewActionsBusy}
            autoViewed={autoViewed}
            onAutoViewedChange={setAutoViewed}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
            onApply={handleApply}
            onCollapseUnchangedChange={setCollapseUnchanged}
            canAcceptAll={canAcceptAll}
            canRejectAll={canRejectAll}
            instantApply={REVIEW_INSTANT_APPLY}
            editedCount={editedCount}
            canUndo={reviewUndoDepth > 0}
            onUndo={() => void handleUndoLatestReviewAction()}
            canRedo={reviewRedoDepth > 0}
            onRedo={() => void handleRedoLatestReviewAction()}
            mutationBlocked={reviewMutationBlockedByExternalChange}
            undoHistory={reviewActionHistory}
            redoHistory={reviewRedoHistory}
            resolveFileLabel={resolveReviewFileLabel}
            historyPersistenceStatus={reviewMutationBusy ? 'saving' : reviewActionPersistenceStatus}
            onRetryHistoryPersistence={() => void persistLatestAcceptedReviewAction()}
            onNavigateToHistoryAction={handleHistoryActionNavigation}
            onRestoreHistory={handleRestoreReviewHistory}
            onRecoverFailedRestore={handleRecoverFailedReviewHistory}
            getRestoreHistoryPreview={getRestoreReviewHistoryPreview}
            restoreHistoryDisabled={
              reviewActionsBusy ||
              editedCount > 0 ||
              reviewMutationBlockedByExternalChange ||
              reviewActionPersistenceStatus !== 'saved'
            }
            undoDisabledReason={
              editedCount > 0
                ? 'Save or discard manual edits before undoing a review action.'
                : undefined
            }
            redoDisabledReason={
              editedCount > 0
                ? 'Save or discard manual edits before redoing a review action.'
                : undefined
            }
          />
        )}

      {/* Scope info / warnings + confidence badge */}
      {shouldShowScopeBanner && taskChangeSet && (
        <ScopeWarningBanner
          warnings={taskChangeSet.warnings}
          confidence={taskChangeSet.scope.confidence}
          sourceKind={taskChangeSet.provenance?.sourceKind}
        />
      )}

      <ChangeReviewConflictNotices
        loadError={reviewConflictLoadError}
        refreshPending={reviewConflictRefreshPending}
        activeCandidate={activeReviewConflictCandidate}
        activeCandidateRecoverable={activeReviewConflictRecoverable}
        candidateCount={reviewConflictCandidateCount}
        resolvingCandidateId={resolvingConflictCandidateId}
        onRetry={refreshReviewConflictCandidates}
        onRequestDiscard={requestRecoveryDiscard}
        onRecover={() => handleResolveReviewConflictCandidate('recover-candidate')}
      />

      {/* Apply error */}
      {applyError && (
        <div
          role="alert"
          className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-400"
        >
          {applyError}
        </div>
      )}

      {/* Content */}
      <div className="flex flex-1 overflow-hidden">
        {(changeSetLoading || decisionHydrationPending || draftHistoryHydrationPending) && (
          <ChangesLoadingAnimation />
        )}

        {changeSetError && (
          <div className="flex w-full items-center justify-center text-sm text-red-400">
            {changeSetError}
          </div>
        )}

        {!changeSetLoading &&
          !changeSetError &&
          decisionHydrationReady &&
          draftHistoryHydrationReady &&
          activeChangeSet &&
          hasReviewFiles && (
            <>
              {/* File tree */}
              <ChangeReviewSidebar
                files={activeChangeSet.files}
                pathChangeLabels={pathChangeLabels}
                decisionState={{ hunkDecisions, fileDecisions, fileChunkCounts }}
                activeFilePath={activeFilePath}
                viewedSet={viewedSet}
                onSelectFile={handleTreeFileClick}
                timeline={activeFile?.timeline ?? null}
                timelineOpen={timelineOpen}
                onToggleTimeline={() => setTimelineOpen(!timelineOpen)}
                onTimelineEventClick={(idx) => diffNav.goToHunk(idx)}
                activeSnippetIndex={diffNav.currentHunkIndex}
              />

              {/* Continuous scroll diff content with selection menu */}
              <div
                ref={diffContentRef}
                className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
              >
                <ContinuousScrollView
                  files={sortedFiles}
                  fileContents={fileContents}
                  fileContentsLoading={fileContentsLoading}
                  globalDiffLoadingState={globalDiffLoadingState}
                  reviewExternalChangesByFile={reviewExternalChangesByFile}
                  viewedSet={viewedSet}
                  editedContents={editedContents}
                  draftHistoryEntries={draftHistoryEntries}
                  hunkDecisions={hunkDecisions}
                  fileDecisions={fileDecisions}
                  hunkContextHashesByFile={hunkContextHashesByFile}
                  collapseUnchanged={collapseUnchanged}
                  applying={reviewActionsBusy}
                  filesApplying={filesApplying}
                  autoViewed={autoViewed}
                  discardCounters={discardCounters}
                  onHunkAccepted={handleHunkAccepted}
                  onHunkRejected={handleHunkRejected}
                  onFullyViewed={handleFullyViewed}
                  onContentChanged={handleContentChanged}
                  onSerializedStateChanged={handleSerializedStateChanged}
                  onSerializedStateRestoreError={handleSerializedStateRestoreError}
                  onDiscard={handleDiscardFile}
                  onSave={handleSaveFile}
                  onReloadFromDisk={handleReloadFromDisk}
                  onKeepDraft={handleKeepDraft}
                  onAcceptFile={handleAcceptFile}
                  onRejectFile={handleRejectFile}
                  onRestoreMissingFile={handleRestoreMissingFile}
                  pathChangeLabels={pathChangeLabels}
                  collapsedFiles={collapsedFiles}
                  onToggleCollapse={toggleCollapsedFile}
                  onVisibleFileChange={handleVisibleFileChange}
                  scrollContainerRef={scrollContainerRef}
                  editorViewMapRef={editorViewMapRef}
                  isProgrammaticScroll={isProgrammaticScroll}
                  teamName={teamName}
                  memberName={memberName}
                  fetchFileContent={fetchFileContent}
                  onSelectionChange={onEditorAction ? handleSelectionChange : undefined}
                  globalHunkOffsets={reviewHunkOrder.offsets}
                  totalReviewHunks={reviewHunkOrder.total}
                />
                {selectionInfo && onEditorAction && (
                  <EditorSelectionMenu
                    info={selectionInfo}
                    containerRect={containerRect}
                    onSendMessage={() => {
                      onEditorAction(buildSelectionAction('sendMessage', selectionInfo));
                      clearSelection();
                    }}
                    onCreateTask={() => {
                      onEditorAction(buildSelectionAction('createTask', selectionInfo));
                      clearSelection();
                    }}
                  />
                )}
              </div>
            </>
          )}

        {!changeSetLoading &&
          !changeSetError &&
          decisionHydrationReady &&
          draftHistoryHydrationReady &&
          activeChangeSet &&
          !hasReviewFiles && <TaskChangesEmptyState changeSet={taskChangeSet} />}

        {(decisionHydrationFailed || draftHistoryHydrationFailed) && (
          <SavedReviewStateRecoveryGate
            key={decisionHydrationKey ?? 'unscoped'}
            decisionStateUnreadable={decisionHydrationFailed}
            draftHistoryUnreadable={draftHistoryHydrationFailed}
            busy={reviewMutationBusy}
            onRetry={() => void handleRetrySavedReviewState()}
            onDiscard={handleDiscardSavedDecisionState}
          />
        )}
      </div>
    </div>
  );
};
