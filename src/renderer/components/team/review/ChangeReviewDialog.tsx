import React, {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { Transaction } from '@codemirror/state';
import { registerAppCloseParticipant } from '@features/app-close-coordination/renderer';
import {
  buildChangeReviewTitle,
  buildGlobalDiffLoadingState,
  buildReviewChangeStats,
  buildReviewFileLabels,
  buildReviewStats,
  buildWatchedReviewFilePathsKey,
  ChangeReviewConflictDiscardDialog,
  ChangeReviewConflictNotices,
  createChangeReviewActionHistoryStorePort,
  createChangeReviewBulkDecisionCommandPort,
  createChangeReviewBulkDecisionStatePort,
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
  createChangeReviewConflictStateBridge,
  createChangeReviewDecisionPersistencePort,
  createChangeReviewDialogLifecycleCommandPort,
  createChangeReviewDialogLifecycleStatePort,
  createChangeReviewDialogViewPorts,
  createChangeReviewDraftHistoryPort,
  createChangeReviewFileDecisionCommandPort,
  createChangeReviewFileDecisionStatePort,
  createChangeReviewFileDraftCommandPort,
  createChangeReviewFileDraftStatePort,
  createChangeReviewHistoryMutationCommandPort,
  createChangeReviewHistoryMutationStatePort,
  createChangeReviewHunkDecisionCommandPort,
  createChangeReviewHunkDecisionStatePort,
  findActiveReviewFile,
  isReviewActionPersistenceBlocking,
  resolveReviewFileLabel as resolveReviewFileLabelFromMap,
  shouldShowTaskScopeBanner,
  sortChangeReviewFiles,
  TaskChangesEmptyState,
  toTaskChangeSetV2,
  useChangeReviewActionHistoryController,
  useChangeReviewBulkDecisionController,
  useChangeReviewConflictDiscoveryController,
  useChangeReviewConflictInteractionController,
  useChangeReviewDecisionPersistenceController,
  useChangeReviewDialogLifecycleController,
  useChangeReviewDraftHistoryController,
  useChangeReviewFileDecisionController,
  useChangeReviewFileDraftController,
  useChangeReviewHistoryKeyboardShortcuts,
  useChangeReviewHistoryMutationController,
  useChangeReviewHunkDecisionController,
  useChangeReviewOperationGeneration,
  useChangeReviewScopeIdentity,
} from '@features/change-review/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { buildReviewRestoreDecisionState } from '@features/review-mutations';
import { api, isElectronMode } from '@renderer/api';
import { EditorSelectionMenu } from '@renderer/components/team/editor/EditorSelectionMenu';
import { useContinuousScrollNav } from '@renderer/hooks/useContinuousScrollNav';
import { useDiffNavigation } from '@renderer/hooks/useDiffNavigation';
import { useViewedFiles } from '@renderer/hooks/useViewedFiles';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFileHunkCount, REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';
import { buildSelectionAction } from '@renderer/utils/buildSelectionAction';
import {
  buildChangeReviewLifecycleSessionId,
  registerChangeReviewLifecycleOwner,
} from '@renderer/utils/changeReviewLifecycleCoordinator';
import { buildSelectionInfo, SELECTION_DEBOUNCE_MS } from '@renderer/utils/codemirrorSelectionInfo';
import { getFileReviewKey } from '@renderer/utils/reviewKey';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { ChevronDown, Clock, X } from 'lucide-react';

import { ChangesLoadingAnimation } from './ChangesLoadingAnimation';
import {
  acceptAllChunks,
  computeChunkIndexAtPos,
  ignoreNextReviewDocChange,
  rejectAllChunks,
  rejectChunk,
} from './CodeMirrorDiffUtils';
import { ContinuousScrollView } from './ContinuousScrollView';
import { FileEditTimeline } from './FileEditTimeline';
import { buildInitialReviewFileScrollKey } from './initialReviewFileScroll';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { buildPathChangeLabels } from './pathChangeLabels';
import { getReviewActionFilePath } from './reviewActionPresentation';
import {
  getReviewRenameRecoveryExpectation,
  hasReviewFileRejections,
  hasUnresolvedReviewExternalChange,
  isReviewActionLocked,
  isReviewFileFullyRejected,
  replaceReviewScopedRecord,
  resolveReviewFileIsNew,
  restoreReviewDecisionRecordsForFile,
  shouldCreateFileWhenUndoingReject,
  shouldDeleteFileWhenUndoingReject,
} from './reviewActionState';
import {
  getResolvedReviewModifiedContent,
  isReviewAcceptDisabled,
  isReviewFileExpectedDeleted,
  isReviewFileMissingOnDisk,
  isReviewRejectable,
  isReviewTextContentUnavailable,
} from './reviewContentPreview';
import { resolveReviewFilePath } from './reviewFilePathResolution';
import { ReviewFileTree } from './ReviewFileTree';
import { ReviewToolbar } from './ReviewToolbar';
import { SavedReviewStateRecoveryGate } from './SavedReviewStateRecoveryGate';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { EditorView } from '@codemirror/view';
import type {
  ChangeReviewFileDecisionPolicy,
  ChangeReviewHunkDecisionPolicy,
  ChangeReviewRecentWrite,
  ReviewDraftHistoryHydrationState,
} from '@features/change-review/renderer';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  FileChangeSummary,
  ReviewDecisionSnapshot,
  ReviewDiskUndoSnapshot,
  ReviewRedoAction,
  ReviewUndoAction,
} from '@shared/types';
import type { EditorSelectionAction, EditorSelectionInfo } from '@shared/types/editor';

const changeReviewConflictQueryPort = createChangeReviewConflictQueryPort(() => api.review);
const changeReviewConflictCommandPort = createChangeReviewConflictCommandPort(() => api.review);
const changeReviewConflictStateBridge = createChangeReviewConflictStateBridge({
  getSnapshot: useStore.getState,
  setApplyError: (applyError) => useStore.setState({ applyError }),
});
const changeReviewDraftHistoryPort = createChangeReviewDraftHistoryPort(() => api.review);
const changeReviewActionHistoryStorePort = createChangeReviewActionHistoryStorePort({
  getStore: useStore.getState,
  clearLegacyUndoStack: () => useStore.setState({ reviewUndoStack: [] }),
});
const changeReviewDecisionPersistencePort = createChangeReviewDecisionPersistencePort({
  getStore: useStore.getState,
  setApplyError: (applyError) => useStore.setState({ applyError }),
});
const changeReviewBulkDecisionStatePort = createChangeReviewBulkDecisionStatePort({
  getStore: useStore.getState,
  restoreDecisionSnapshot: ({ hunkDecisions, fileDecisions }) =>
    useStore.setState({ hunkDecisions, fileDecisions }),
});
const changeReviewFileDraftStatePort = createChangeReviewFileDraftStatePort({
  getStore: useStore.getState,
  applyReloadedReviewState: (state) =>
    useStore.setState({
      hunkDecisions: state.hunkDecisions,
      fileDecisions: state.fileDecisions,
      hunkContextHashesByFile: state.hunkContextHashesByFile ?? {},
      applyError: null,
    }),
  reportError: (applyError) => useStore.setState({ applyError }),
});
const changeReviewFileDraftCommandPort = createChangeReviewFileDraftCommandPort({
  getStore: useStore.getState,
  getReviewApi: () => api.review,
});
const changeReviewFileDecisionStatePort = createChangeReviewFileDecisionStatePort({
  getStore: useStore.getState,
  applyRestoredDecisionState: (file) =>
    useStore.setState((state) => buildReviewRestoreDecisionState(file, state)),
  restoreFileDecisions: (file, snapshot) =>
    useStore.setState((state) => restoreReviewDecisionRecordsForFile(file, state, snapshot)),
  reportError: (applyError) => useStore.setState({ applyError }),
});
const changeReviewFileDecisionPolicy: ChangeReviewFileDecisionPolicy = {
  getHunkCount: (file, state) =>
    getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts),
  getFileDecision: (file, state) =>
    state.fileDecisions[getFileReviewKey(file)] ?? state.fileDecisions[file.filePath],
  resolveModifiedContent: getResolvedReviewModifiedContent,
  resolveFileIsNew: resolveReviewFileIsNew,
  isExpectedDeletion: isReviewFileExpectedDeleted,
  isAcceptDisabled: (_file, content, fileDecision) =>
    isReviewAcceptDisabled({
      hasEdits: false,
      isMissingOnDisk: isReviewFileMissingOnDisk(content),
      isContentUnavailable: isReviewTextContentUnavailable(_file, content),
      fileDecision,
    }),
  isRejectable: isReviewRejectable,
  hasFileRejections: hasReviewFileRejections,
  isFileFullyRejected: isReviewFileFullyRejected,
  shouldDeleteWhenUndoingReject: shouldDeleteFileWhenUndoingReject,
  hasUnresolvedExternalChange: hasUnresolvedReviewExternalChange,
  getRenameRecoveryExpectation: getReviewRenameRecoveryExpectation,
};
const changeReviewHunkDecisionStatePort = createChangeReviewHunkDecisionStatePort(
  useStore.getState
);
const changeReviewHunkDecisionPolicy: ChangeReviewHunkDecisionPolicy = {
  getHunkCount: (file, state) =>
    getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts),
  resolveFileIsNew: resolveReviewFileIsNew,
  shouldDeleteWhenUndoingReject: shouldDeleteFileWhenUndoingReject,
  shouldCreateWhenUndoingReject: shouldCreateFileWhenUndoingReject,
  getRenameRecoveryExpectation: getReviewRenameRecoveryExpectation,
};
const changeReviewDialogLifecycleStatePort = createChangeReviewDialogLifecycleStatePort({
  getStore: useStore.getState,
  reportError: (applyError) => useStore.setState({ applyError }),
  completeSavedStateDiscard: (markDecisionHydrationLoaded) =>
    useStore.setState({
      ...(markDecisionHydrationLoaded ? { decisionHydrationStatus: 'loaded' as const } : {}),
      applyError: null,
    }),
});
const changeReviewHistoryMutationCommandPort = createChangeReviewHistoryMutationCommandPort(
  () => api.review
);
const changeReviewHistoryMutationStatePort = createChangeReviewHistoryMutationStatePort({
  getSnapshot: () => useStore.getState(),
  quiesceDecisionPersistence: ({ teamName, scopeKey, scopeToken }) =>
    useStore.getState().quiesceDecisionPersistence(teamName, scopeKey, scopeToken),
  recordDecisionRevision: ({ teamName, scopeKey, scopeToken }, revision) =>
    useStore.getState().recordDecisionRevision(teamName, scopeKey, scopeToken, revision),
  applyDecisionState: ({ hunkDecisions, fileDecisions, hunkContextHashesByFile }) =>
    useStore.setState({
      hunkDecisions,
      fileDecisions,
      ...(hunkContextHashesByFile ? { hunkContextHashesByFile } : {}),
    }),
  applyPersistedState: (state, applyError) =>
    useStore.setState({
      hunkDecisions: state.hunkDecisions,
      fileDecisions: state.fileDecisions,
      hunkContextHashesByFile: state.hunkContextHashesByFile ?? {},
      applyError,
    }),
  reportError: (applyError) => useStore.setState({ applyError }),
  clearExternalChange: (filePath) => useStore.getState().clearReviewFileExternalChange(filePath),
  invalidateResolvedFileContent: (filePath) =>
    useStore.getState().invalidateResolvedFileContent(filePath),
});

const REVIEW_LOCAL_WRITE_COOLDOWN_MS = 2000;

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
  const { t } = useAppTranslation('team');
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

  // Active file from scroll-spy (replaces selectedReviewFilePath for continuous scroll)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
  const [filesApplying, setFilesApplying] = useState<Set<string>>(() => new Set());
  const [undoing, setUndoing] = useState(false);
  const [closing, setClosing] = useState(false);
  const [collapsedFiles, setCollapsedFiles] = useState<Set<string>>(() => {
    if (typeof window === 'undefined') return new Set<string>();
    try {
      const raw = window.localStorage.getItem(collapseStorageKey);
      const parsed = raw ? (JSON.parse(raw) as unknown) : null;
      if (Array.isArray(parsed)) {
        return new Set(parsed.filter((v): v is string => typeof v === 'string'));
      }
    } catch {
      // ignore
    }
    return new Set<string>();
  });

  // Selection menu state
  const [selectionInfo, setSelectionInfo] = useState<EditorSelectionInfo | null>(null);
  const [containerRect, setContainerRect] = useState<DOMRect>(new DOMRect());
  const diffContentRef = useRef<HTMLDivElement>(null);
  const selectionTimerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const activeSelectionFileRef = useRef<string | null>(null);

  // EditorView map for all visible file editors
  const editorViewMapRef = useRef(new Map<string, EditorView>());
  const scrollContainerRef = useRef<HTMLDivElement>(null);
  const fileApplyInFlightRef = useRef(new Set<string>());
  const undoInFlightRef = useRef(false);
  const closingRef = useRef(false);
  const pendingApplyCleanupKeyRef = useRef<string | null>(null);
  const recentReviewWritesRef = useRef(new Map<string, ChangeReviewRecentWrite>());
  // Exact disk state on which each manual draft started. Map.has() distinguishes
  // a genuinely missing file (null baseline) from an uncaptured baseline.
  const expectedDraftHistoryKeyRef = useRef<string | null>(null);

  // Proxy ref for useDiffNavigation (points to active file's editor)
  const activeEditorViewRef = useRef<EditorView | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

  useLayoutEffect(() => {
    const activeHydrationKey = open && lifecycleAuthorized ? decisionHydrationKey : null;
    expectedDraftHistoryKeyRef.current = activeHydrationKey;
    return () => {
      if (expectedDraftHistoryKeyRef.current === activeHydrationKey) {
        expectedDraftHistoryKeyRef.current = null;
      }
    };
  }, [decisionHydrationKey, lifecycleAuthorized, open]);

  const resetReviewOperationGenerationState = useCallback((): void => {
    // Busy state belongs to one operation generation. Never carry it into a
    // reopened or re-hydrated scope, but preserve recent-write evidence so late
    // filesystem events from our own committed mutation remain suppressible.
    fileApplyInFlightRef.current.clear();
    undoInFlightRef.current = false;
    closingRef.current = false;
    setFilesApplying(new Set());
    setUndoing(false);
    setClosing(false);
  }, []);

  const { captureReviewOperationScope, isCurrentReviewOperationScope } =
    useChangeReviewOperationGeneration({
      active: open && lifecycleAuthorized,
      decisionHydrationKey,
      fallbackScopeKey: `unscoped:${teamName}:${scopeKey}`,
      changeSetEpoch,
      resetGenerationState: resetReviewOperationGenerationState,
    });

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

  useEffect(() => {
    if (pendingApplyCleanupKeyRef.current !== decisionHydrationKey) {
      pendingApplyCleanupKeyRef.current = null;
    }
  }, [decisionHydrationKey]);

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

  const getEditorFilePathForTarget = useCallback((target: Element | null): string | null => {
    if (!target) return null;
    for (const [filePath, view] of editorViewMapRef.current.entries()) {
      if (view.dom.contains(target)) {
        return filePath;
      }
    }
    return null;
  }, []);

  // Keep refs in sync with activeFilePath
  useEffect(() => {
    activeFilePathRef.current = activeFilePath;
    activeEditorViewRef.current = activeFilePath
      ? (editorViewMapRef.current.get(activeFilePath) ?? null)
      : null;
  }, [activeFilePath]);

  useEffect(() => {
    fileApplyInFlightRef.current.clear();
    recentReviewWritesRef.current.clear();
    undoInFlightRef.current = false;
    closingRef.current = false;
    setUndoing(false);
    setClosing(false);
    setFilesApplying(new Set());
  }, [changeSetEpoch, scopeKey, teamName]);

  const ensureDurableReviewScope = useCallback((): boolean => {
    if (!decisionScopeToken) {
      useStore.setState({
        applyError: 'Durable review scope is unavailable; refusing an unsafe disk mutation.',
      });
      return false;
    }
    return true;
  }, [decisionScopeToken]);

  const reviewMutationBusy = isReviewActionLocked({
    applying,
    fileApplyCount: filesApplying.size,
    undoing,
    closing,
  });
  const reviewActionsBusy =
    reviewMutationBusy ||
    reviewConflictRefreshPending ||
    reviewConflictLoadError !== null ||
    reviewConflictCandidateCount > 0 ||
    resolvingConflictCandidateId !== null ||
    isReviewActionPersistenceBlocking(reviewActionPersistenceStatus) ||
    (decisionHydrationKey !== null && (!decisionHydrationReady || !draftHistoryHydrationReady));
  // Candidate discovery and persistence drains are safe to finish in the close flush.
  // Only an active mutation or conflict resolution must keep the close control locked.
  const reviewCloseBusy = reviewMutationBusy || resolvingConflictCandidateId !== null;

  const hasReviewActionInFlight = useCallback(() => {
    const state = useStore.getState();
    const hydrationReady =
      decisionHydrationKey === null ||
      (state.decisionHydrationScopeKey === decisionHydrationKey &&
        state.decisionHydrationStatus === 'loaded' &&
        draftHistoryHydration.key === decisionHydrationKey &&
        draftHistoryHydration.status === 'loaded');
    return (
      !hydrationReady ||
      reviewConflictRefreshPending ||
      reviewConflictLoadError !== null ||
      reviewConflictCandidateCount > 0 ||
      resolvingConflictCandidateId !== null ||
      isReviewActionPersistenceBlocking(getReviewActionPersistenceStatus()) ||
      isReviewActionLocked({
        applying: state.applying,
        fileApplyCount: fileApplyInFlightRef.current.size,
        undoing: undoInFlightRef.current,
        closing: closingRef.current,
      })
    );
  }, [
    decisionHydrationKey,
    draftHistoryHydration.key,
    draftHistoryHydration.status,
    getReviewActionPersistenceStatus,
    reviewConflictLoadError,
    reviewConflictRefreshPending,
    resolvingConflictCandidateId,
    reviewConflictCandidateCount,
  ]);

  const hasReviewDraft = useCallback(
    (filePath: string): boolean => filePath in useStore.getState().editedContents,
    []
  );

  // One-shot scroll-to-file ref (for initialFilePath)
  const initialScrollDoneKeyRef = useRef<string | null>(null);

  // Continuous scroll navigation
  const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
    scrollContainerRef,
  });

  // Sort files to match the visual order of the file tree (directories first, then alphabetical)
  const sortedFiles = useMemo(
    () => sortChangeReviewFiles(activeChangeSet?.files ?? []),
    [activeChangeSet]
  );
  const reviewFileLabels = useMemo(() => buildReviewFileLabels(sortedFiles), [sortedFiles]);
  const resolveReviewFileLabel = useCallback(
    (filePath: string): string => resolveReviewFileLabelFromMap(reviewFileLabels, filePath),
    [reviewFileLabels]
  );
  // A content-derived key avoids tearing down/recreating the main-process watcher
  // when Zustand returns a new array containing the exact same review paths.
  const watchedReviewFilePathsKey = useMemo(
    () => buildWatchedReviewFilePathsKey(sortedFiles),
    [sortedFiles]
  );
  const watchedReviewFilePathsKeyRef = useRef(watchedReviewFilePathsKey);
  useEffect(() => {
    watchedReviewFilePathsKeyRef.current = watchedReviewFilePathsKey;
  }, [watchedReviewFilePathsKey]);
  const globalDiffLoadingState = useMemo(
    () =>
      buildGlobalDiffLoadingState({
        files: sortedFiles,
        activeFilePath,
        fileContentsLoading,
        fileContents,
      }),
    [activeFilePath, fileContents, fileContentsLoading, sortedFiles]
  );

  // File paths for viewed tracking
  const allFilePaths = useMemo(() => sortedFiles.map((f) => f.filePath), [sortedFiles]);

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

  const {
    viewedSet,
    isViewed,
    markViewed,
    unmarkViewed,
    viewedCount,
    totalCount: viewedTotalCount,
    progress: viewedProgress,
  } = useViewedFiles(teamName, scopeKey, allFilePaths);

  const editedCount = Object.keys(editedContents).length;
  const reviewMutationBlockedByExternalChange = Object.keys(reviewExternalChangesByFile).length > 0;
  const blockReviewMutationForExternalChange = useCallback((filePath?: string): boolean => {
    const externalChanges = useStore.getState().reviewExternalChangesByFile;
    const blocked = filePath
      ? hasUnresolvedReviewExternalChange(filePath, externalChanges)
      : Object.keys(externalChanges).length > 0;
    if (blocked) {
      useStore.setState({
        applyError: 'Reload files changed outside Changes before continuing review actions.',
      });
    }
    return blocked;
  }, []);

  // Scroll-spy handler
  const handleVisibleFileChange = useCallback((filePath: string) => {
    setActiveFilePath(filePath);
  }, []);

  useEffect(() => {
    if (!open || !projectPath || !isElectronMode()) return;
    let disposed = false;

    const unsubscribe = api.review.onExternalFileChange((event) => {
      const normalizedPath = normalizePathForComparison(event.path);
      const processExternalChange = (): void => {
        if (disposed) return;
        const state = useStore.getState();
        const active = state.activeChangeSet;
        if (!active) return;
        const file = active.files.find(
          (entry) => normalizePathForComparison(entry.filePath) === normalizedPath
        );
        if (!file) return;
        const changeType =
          event.type === 'create' ? 'add' : event.type === 'delete' ? 'unlink' : 'change';
        const durableDraftHistory = getDraftHistoryEntry(file.filePath);
        if (file.filePath in state.editedContents || durableDraftHistory) {
          if (!(file.filePath in state.editedContents) && durableDraftHistory) {
            state.updateEditedContent(file.filePath, durableDraftHistory.editorState.doc);
          }
          state.markReviewFileExternallyChanged(file.filePath, changeType);
        } else {
          state.markReviewFileExternallyChanged(file.filePath, changeType);
        }
        useStore.setState({
          applyError:
            'A reviewed file changed outside Changes. Reload it from disk before continuing review actions.',
        });
      };

      const recentWrite = recentReviewWritesRef.current.get(normalizedPath);
      if (recentWrite && Date.now() - recentWrite.at < REVIEW_LOCAL_WRITE_COOLDOWN_MS) {
        const verifyExpectedWrite = async (): Promise<void> => {
          if (disposed) return;
          const pathBusy = [...fileApplyInFlightRef.current].some(
            (filePath) => normalizePathForComparison(filePath) === normalizedPath
          );
          if (pathBusy || undoInFlightRef.current || useStore.getState().applying) {
            // A slow fsync, antivirus hook, or network volume can legitimately take
            // longer than the old 2.5s cap. Verify only after our mutation settles.
            window.setTimeout(() => void verifyExpectedWrite(), 25);
            return;
          }
          const latest = recentReviewWritesRef.current.get(normalizedPath);
          if (!latest) return;
          try {
            const result = await api.review.checkConflict(
              reviewScope,
              event.path,
              latest.expectedContent ?? ''
            );
            const matchesExpected =
              latest.expectedContent === null
                ? result.hasConflict && result.conflictContent === null
                : !result.hasConflict;
            if (matchesExpected) return;
          } catch {
            // A failed verification is not evidence that this was our own event.
          }
          recentReviewWritesRef.current.delete(normalizedPath);
          processExternalChange();
        };
        void verifyExpectedWrite();
        return;
      }
      processExternalChange();
    });

    const initialWatchedFilePaths = watchedReviewFilePathsKeyRef.current
      ? watchedReviewFilePathsKeyRef.current.split('\0')
      : [];
    void api.review.watchFiles(projectPath, initialWatchedFilePaths);

    return () => {
      disposed = true;
      unsubscribe();
      void api.review.unwatchFiles();
    };
  }, [getDraftHistoryEntry, open, projectPath, reviewScope]);

  useEffect(() => {
    if (!open || !projectPath || !isElectronMode()) return;
    const watchedFilePaths = watchedReviewFilePathsKey ? watchedReviewFilePathsKey.split('\0') : [];
    void api.review.watchFiles(projectPath, watchedFilePaths);
  }, [open, projectPath, watchedReviewFilePathsKey]);

  // Tree click → scroll to file
  const handleTreeFileClick = useCallback(
    (filePath: string) => {
      scrollToFile(filePath);
      setActiveFilePath(filePath);
    },
    [scrollToFile]
  );

  const handleHistoryActionNavigation = useCallback(
    (action: ReviewUndoAction) => {
      const actionFilePath = getReviewActionFilePath(action);
      if (!actionFilePath) return;
      const targetFile = sortedFiles.find(
        (file) =>
          normalizePathForComparison(file.filePath) === normalizePathForComparison(actionFilePath)
      );
      if (!targetFile) {
        useStore.setState({
          applyError: 'The file from this review action is no longer in the current change set.',
        });
        return;
      }
      handleTreeFileClick(targetFile.filePath);
    },
    [handleTreeFileClick, sortedFiles]
  );

  const dialogViewPorts = useMemo(
    () =>
      // eslint-disable-next-line react-hooks/refs -- Factory only captures refs for later callbacks.
      createChangeReviewDialogViewPorts({
        editorViewMapRef,
        editorActions: {
          acceptAllChunks,
          ignoreNextDocChange: ignoreNextReviewDocChange,
          rejectAllChunks,
          rejectChunk,
        },
        fileApplyInFlightRef,
        undoInFlightRef,
        closingRef,
        pendingApplyCleanupKeyRef,
        expectedDraftHistoryKeyRef,
        recentReviewWritesRef,
        setFilesApplying,
        setDiscardCounters,
        setUndoing,
        setClosing,
        handleSerializedStateChanged,
        addReviewFile,
        fetchFileContent,
        navigateToHistoryAction: handleHistoryActionNavigation,
      }),
    [addReviewFile, fetchFileContent, handleHistoryActionNavigation, handleSerializedStateChanged]
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
    [activeChangeSet, fileChunkCounts, fileContents]
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

  const handleFullyViewed = useCallback(
    (filePath: string) => {
      if (autoViewed && !isViewed(filePath)) {
        markViewed(filePath);
      }
    },
    [autoViewed, isViewed, markViewed]
  );

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
  const isReviewFileMutationInFlight = useCallback(
    (filePath: string): boolean => fileApplyInFlightRef.current.has(filePath),
    []
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
    isFileMutationInFlight: isReviewFileMutationInFlight,
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

  // Selection change handler (debounced for non-empty, immediate for clear)
  const handleSelectionChange = useCallback((info: EditorSelectionInfo | null) => {
    if (!info) {
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
      setSelectionInfo(null);
      return;
    }
    activeSelectionFileRef.current = info.filePath;
    if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    selectionTimerRef.current = setTimeout(() => {
      setSelectionInfo(info);
    }, SELECTION_DEBOUNCE_MS);
  }, []);

  // Scroll repositioning - re-query coords when parent scrolls (rAF-throttled)
  const hasData =
    lifecycleAuthorized &&
    !changeSetLoading &&
    !changeSetError &&
    !!activeChangeSet &&
    (decisionHydrationKey === null || (decisionHydrationReady && draftHistoryHydrationReady));
  useEffect(() => {
    if (!hasData) return;
    const container = scrollContainerRef.current;
    if (!container) return;

    let rafId = 0;
    const onScroll = (): void => {
      cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        const fp = activeSelectionFileRef.current;
        if (!fp) return;
        const view = editorViewMapRef.current.get(fp);
        if (!view) return;
        const sel = view.state.selection.main;
        if (sel.empty) {
          setSelectionInfo(null);
          return;
        }
        const info = buildSelectionInfo(view, sel);
        if (info) {
          setSelectionInfo({ ...info, filePath: fp });
        } else {
          setSelectionInfo(null);
        }
      });
    };

    container.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(rafId);
      container.removeEventListener('scroll', onScroll);
    };
  }, [hasData]);

  // Track container rect for menu positioning
  useEffect(() => {
    const el = diffContentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(() => {
      setContainerRect(el.getBoundingClientRect());
    });
    observer.observe(el);
    setContainerRect(el.getBoundingClientRect());
    return () => observer.disconnect();
  }, [hasData]);

  // Save active file (for Cmd+S keyboard shortcut)
  const handleSaveActiveFile = useCallback(() => {
    if (!activeFilePath || hasReviewActionInFlight()) return;
    void handleSaveFile(activeFilePath);
  }, [activeFilePath, handleSaveFile, hasReviewActionInFlight]);

  // Continuous navigation options for cross-file hunk navigation
  const continuousOptions = useMemo(
    () => ({
      editorViewMapRef,
      activeFilePath,
      scrollToFile,
      enabled: true,
    }),
    [activeFilePath, scrollToFile]
  );

  const diffNav = useDiffNavigation(
    sortedFiles,
    activeFilePath,
    scrollToFile,
    activeEditorViewRef,
    open,
    handleHunkAccepted,
    handleHunkRejected,
    () => void requestClose(),
    handleSaveActiveFile,
    continuousOptions,
    (filePath, fallbackSnippetsLength) =>
      getFileHunkCount(filePath, fallbackSnippetsLength, fileChunkCounts)
  );

  const reviewHunkOrder = useMemo(() => {
    const offsets: Record<string, number> = {};
    let total = 0;
    for (const file of sortedFiles) {
      offsets[file.filePath] = total;
      total += getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);
    }
    return { offsets, total };
  }, [sortedFiles, fileChunkCounts]);

  const toggleCollapsedFile = useCallback((filePath: string) => {
    setCollapsedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(filePath)) next.delete(filePath);
      else next.add(filePath);
      return next;
    });
  }, []);

  // Persist collapsed state (best-effort)
  useEffect(() => {
    if (!open) return;
    if (typeof window === 'undefined') return;
    const id = window.setTimeout(() => {
      try {
        window.localStorage.setItem(collapseStorageKey, JSON.stringify([...collapsedFiles]));
      } catch {
        // ignore
      }
    }, 200);
    return () => window.clearTimeout(id);
  }, [open, collapseStorageKey, collapsedFiles]);

  // Prune collapsed entries to only current files to avoid stale growth
  useEffect(() => {
    if (!activeChangeSet) return;
    const allowed = new Set(activeChangeSet.files.map((f) => f.filePath));
    setCollapsedFiles((prev) => {
      const next = new Set<string>();
      for (const fp of prev) {
        if (allowed.has(fp)) next.add(fp);
      }
      return next.size === prev.size ? prev : next;
    });
  }, [activeChangeSet]);

  // Scroll to initialFilePath once data is loaded
  useEffect(() => {
    const scrollKey = buildInitialReviewFileScrollKey(activeChangeSet, initialFilePath);
    if (!activeChangeSet || !initialFilePath || !scrollKey) return;
    if (initialScrollDoneKeyRef.current === scrollKey) return;
    const targetFilePath = resolveReviewFilePath(activeChangeSet.files, initialFilePath);
    if (!targetFilePath) return;
    initialScrollDoneKeyRef.current = scrollKey;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToFile(targetFilePath));
    });
  }, [activeChangeSet, initialFilePath, scrollToFile]);

  // Clear selection state on close
  useEffect(() => {
    if (!open) {
      setSelectionInfo(null);
    }
  }, [open]);

  // Cleanup refs/timers on close
  useEffect(() => {
    if (!open) {
      activeSelectionFileRef.current = null;
      if (selectionTimerRef.current) clearTimeout(selectionTimerRef.current);
    }
  }, [open]);

  // Review actions use one ordered stack. Manual draft edits keep CodeMirror's native history.
  const resolveReviewKeyboardEditorContext = useCallback(
    (target: Element | null) => {
      const filePath = getEditorFilePathForTarget(target);
      return {
        editor: filePath ? (editorViewMapRef.current.get(filePath) ?? null) : null,
        hasDraft: filePath ? hasReviewDraft(filePath) : false,
      };
    },
    [getEditorFilePathForTarget, hasReviewDraft]
  );
  const getReviewUndoCount = useCallback(
    (): number => getReviewUndoHistory().length,
    [getReviewUndoHistory]
  );
  const getReviewRedoCount = useCallback(
    (): number => getReviewRedoHistory().length,
    [getReviewRedoHistory]
  );
  const reportReviewUndoDraftBlock = useCallback((): void => {
    useStore.setState({
      applyError: 'Save or discard manual edits before undoing a review action.',
    });
  }, []);
  useChangeReviewHistoryKeyboardShortcuts({
    active: open,
    editedCount,
    resolveEditorContext: resolveReviewKeyboardEditorContext,
    hasActionInFlight: hasReviewActionInFlight,
    getUndoCount: getReviewUndoCount,
    getRedoCount: getReviewRedoCount,
    undoLatest: handleUndoLatestReviewAction,
    redoLatest: handleRedoLatestReviewAction,
    reportManualDraftBlock: reportReviewUndoDraftBlock,
  });

  // Cmd+N IPC listener (forwarded from main process)
  useEffect(() => {
    if (!open) return;
    const cleanup = window.electronAPI?.review.onCmdN?.(() => {
      const fp = activeFilePathRef.current;
      if (!fp) return;
      const view = editorViewMapRef.current.get(fp);
      if (!view) return;

      const cursorPos = view.state.selection.main.head;
      const idx = computeChunkIndexAtPos(view.state, cursorPos);
      const beforeContent = view.state.doc.toString();
      if (!rejectChunk(view)) return;
      const afterContent = view.state.doc.toString();
      if (handleHunkRejected(fp, idx, beforeContent, afterContent) === false) {
        ignoreNextReviewDocChange(view);
        view.dispatch({
          changes: { from: 0, to: view.state.doc.length, insert: beforeContent },
          annotations: Transaction.addToHistory.of(false),
        });
        return;
      }
      requestAnimationFrame(() => diffNav.goToNextHunk());
    });
    return cleanup ?? undefined;
  }, [open, diffNav, handleHunkRejected]);

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

  // Active file for timeline (derived from scroll-spy)
  const activeFile = useMemo(
    () => findActiveReviewFile(activeChangeSet, activeFilePath),
    [activeChangeSet, activeFilePath]
  );

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
              <div className="w-64 shrink-0 overflow-y-auto border-r border-border bg-surface-sidebar">
                <ReviewFileTree
                  files={activeChangeSet.files}
                  fileContents={fileContents}
                  pathChangeLabels={pathChangeLabels}
                  selectedFilePath={null}
                  onSelectFile={handleTreeFileClick}
                  viewedSet={viewedSet}
                  onMarkViewed={markViewed}
                  onUnmarkViewed={unmarkViewed}
                  activeFilePath={activeFilePath ?? undefined}
                />

                {/* Edit Timeline for active file */}
                {activeFile?.timeline && activeFile.timeline.events.length > 0 && (
                  <div className="border-t border-border">
                    <button
                      onClick={() => setTimelineOpen(!timelineOpen)}
                      className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text"
                    >
                      <Clock className="size-3.5" />
                      <span>
                        {t('review.timeline.titleWithCount', {
                          count: activeFile.timeline.events.length,
                        })}
                      </span>
                      <ChevronDown
                        className={cn(
                          'ml-auto size-3 transition-transform',
                          timelineOpen && 'rotate-180'
                        )}
                      />
                    </button>
                    {timelineOpen && (
                      <FileEditTimeline
                        timeline={activeFile.timeline}
                        onEventClick={(idx) => diffNav.goToHunk(idx)}
                        activeSnippetIndex={diffNav.currentHunkIndex}
                      />
                    )}
                  </div>
                )}
              </div>

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
                      setSelectionInfo(null);
                    }}
                    onCreateTask={() => {
                      onEditorAction(buildSelectionAction('createTask', selectionInfo));
                      setSelectionInfo(null);
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
