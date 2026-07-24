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
  createChangeReviewConflictCommandPort,
  createChangeReviewConflictQueryPort,
  createChangeReviewConflictStateBridge,
  createChangeReviewDecisionPersistencePort,
  createChangeReviewDraftHistoryPort,
  createChangeReviewHistoryMutationCommandPort,
  createChangeReviewHistoryMutationStatePort,
  findActiveReviewFile,
  isReviewActionPersistenceBlocking,
  resolveReviewFileLabel as resolveReviewFileLabelFromMap,
  shouldShowTaskScopeBanner,
  sortChangeReviewFiles,
  TaskChangesEmptyState,
  toTaskChangeSetV2,
  useChangeReviewActionHistoryController,
  useChangeReviewConflictDiscoveryController,
  useChangeReviewConflictInteractionController,
  useChangeReviewDecisionAutoPersistence,
  useChangeReviewDecisionPersistenceController,
  useChangeReviewDraftHistoryController,
  useChangeReviewHistoryKeyboardShortcuts,
  useChangeReviewHistoryMutationController,
  useChangeReviewLifecycleRegistration,
  useChangeReviewOperationGeneration,
  useChangeReviewScopeIdentity,
} from '@features/change-review/renderer';
import { serializeReviewDraftEditorState } from '@features/change-review-history/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import {
  buildReviewExternalReloadState,
  buildReviewRestoreDecisionState,
} from '@features/review-mutations';
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
import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';
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
  getReviewCloseBlockReason,
  getReviewRenameRecoveryExpectation,
  hasReviewFileRejections,
  hasUnresolvedReviewExternalChange,
  hasUnscopedLocalReviewState,
  isReviewActionLocked,
  isReviewFileFullyRejected,
  reconcileReviewDecisionRecordsAfterApply,
  replaceReviewScopedRecord,
  resolveReviewFileIsNew,
  restoreReviewDecisionRecordsForFile,
  shouldCreateFileWhenUndoingReject,
  shouldDeleteFileWhenUndoingReject,
  shouldRequestReviewCloseForEscape,
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
import {
  buildForwardDiskMutationSteps,
  markReviewMutationDiskPostimages,
} from './reviewHistoryTimeline';
import { ReviewToolbar } from './ReviewToolbar';
import { SavedReviewStateRecoveryGate } from './SavedReviewStateRecoveryGate';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { ReviewDecisionRecords } from './reviewActionState';
import type { EditorView } from '@codemirror/view';
import type {
  ChangeReviewHistoryMutationViewPort,
  ReviewDraftHistoryHydrationState,
} from '@features/change-review/renderer';
import type { TaskChangeRequestOptions } from '@renderer/utils/taskChangeRequest';
import type {
  FileChangeSummary,
  HunkDecision,
  ReviewDecisionSnapshot,
  ReviewDiskUndoAction,
  ReviewDiskUndoSnapshot,
  ReviewMutationDiskPostimage,
  ReviewRedoAction,
  ReviewRenameRecoveryExpectation,
  ReviewUndoAction,
} from '@shared/types';
import type { EditorSelectionAction, EditorSelectionInfo } from '@shared/types/editor';

type RecentHunkUndoAction = Extract<ReviewUndoAction, { kind: 'hunk' }>['action'];
type RecentDiskUndoAction = ReviewDiskUndoAction;
interface RecentReviewWrite {
  at: number;
  expectedContent: string | null;
}

interface ReviewCloseFlushResult {
  ok: boolean;
  blocker?: string;
}

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

function isLedgerRenameReviewFile(file: FileChangeSummary | undefined): boolean {
  return Boolean(file?.snippets.some((snippet) => snippet.ledger?.relation?.kind === 'rename'));
}

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
    fetchAgentChanges,
    fetchTaskChanges,
    clearChangeReviewCache,
    hunkDecisions,
    fileDecisions,
    reviewActionHistory,
    reviewRedoHistory,
    fileContents,
    fileContentsLoading,
    collapseUnchanged,
    applying,
    applyError,
    setHunkDecision,
    clearHunkDecisionByOriginalIndex,
    setCollapseUnchanged,
    fetchFileContent,
    acceptAllFile,
    rejectAllFile,
    applyReview,
    applySingleFileDecision,
    addReviewFile,
    editedContents,
    updateEditedContent,
    discardFileEdits,
    saveEditedFile,
    reviewExternalChangesByFile,
    clearReviewFileExternalChange,
    reloadReviewFileFromDisk,
    quiesceDecisionPersistence,
    recordDecisionRevision,
    clearDecisionsFromDisk,
    resetAllReviewState,
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
  const recentReviewWritesRef = useRef(new Map<string, RecentReviewWrite>());
  // Exact disk state on which each manual draft started. Map.has() distinguishes
  // a genuinely missing file (null baseline) from an uncaptured baseline.
  const expectedDraftHistoryKeyRef = useRef<string | null>(null);

  // Proxy ref for useDiffNavigation (points to active file's editor)
  const activeEditorViewRef = useRef<EditorView | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

  const markRecentReviewWrite = useCallback(
    (filePath: string, expectedContent: string | null): void => {
      recentReviewWritesRef.current.set(normalizePathForComparison(filePath), {
        at: Date.now(),
        expectedContent,
      });
    },
    []
  );

  const markCommittedReviewPostimages = useCallback(
    (postimages: readonly ReviewMutationDiskPostimage[] | undefined): void => {
      markReviewMutationDiskPostimages(postimages, markRecentReviewWrite);
    },
    [markRecentReviewWrite]
  );

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
    scheduleAutoPersistence: scheduleReviewDecisionAutoPersistence,
    clearAfterDurableStateEmptied: clearReviewDecisionsAfterStateEmptied,
    flushForClose: flushReviewDecisionsForClose,
    getDiagnostics: getReviewDecisionPersistenceDiagnostics,
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
    retryHydration: retryDraftHistoryHydration,
    discardUnreadableScope: discardUnreadableDraftHistoryScope,
    getDiagnostics: getDraftHistoryDiagnostics,
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

  const setFileApplying = useCallback((filePath: string, value: boolean): void => {
    setFilesApplying((previous) => {
      const next = new Set(previous);
      if (value) next.add(filePath);
      else next.delete(filePath);
      return next;
    });
  }, []);

  const setUndoInFlight = useCallback((value: boolean): void => {
    undoInFlightRef.current = value;
    setUndoing(value);
  }, []);

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

  const restoreFileDecisions = useCallback(
    (
      file: FileChangeSummary,
      snapshot: {
        hunkDecisions: Record<string, HunkDecision>;
        fileDecisions: Record<string, HunkDecision>;
      }
    ): void => {
      useStore.setState((state) => {
        return restoreReviewDecisionRecordsForFile(file, state, snapshot);
      });
    },
    []
  );

  const rollbackEditorContent = useCallback((filePath: string, content: string): void => {
    const view = editorViewMapRef.current.get(filePath);
    if (!view?.dom.isConnected) return;
    ignoreNextReviewDocChange(view);
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: content },
      annotations: Transaction.addToHistory.of(false),
    });
  }, []);

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

  // Accept/Reject all across all files
  const handleAcceptAll = useCallback(() => {
    if (
      !activeChangeSet ||
      !canAcceptAll ||
      hasReviewActionInFlight() ||
      blockReviewMutationForExternalChange()
    ) {
      return;
    }
    const operationScope = captureReviewOperationScope();
    if (!operationScope) return;
    const reviewState = useStore.getState();
    const currentDrafts = reviewState.editedContents;
    const decisionSnapshot: ReviewDecisionSnapshot = {
      hunkDecisions: { ...reviewState.hunkDecisions },
      fileDecisions: { ...reviewState.fileDecisions },
    };
    const acceptedFiles = new Set<string>();
    for (const file of activeChangeSet.files) {
      if (file.filePath in currentDrafts) continue;
      if (acceptAllFile(file.filePath)) acceptedFiles.add(file.filePath);
    }
    if (acceptedFiles.size === 0) return;
    pushReviewUndoAction({
      kind: 'bulk',
      descriptor: { intent: 'accept-all', fileCount: acceptedFiles.size },
      decisionSnapshot,
      diskSnapshots: [],
    });
    void persistLatestAcceptedReviewAction();
    requestAnimationFrame(() => {
      if (!isCurrentReviewOperationScope(operationScope)) return;
      for (const [filePath, view] of editorViewMapRef.current.entries()) {
        if (!acceptedFiles.has(filePath)) continue;
        acceptAllChunks(view);
      }
    });
  }, [
    acceptAllFile,
    activeChangeSet,
    blockReviewMutationForExternalChange,
    canAcceptAll,
    captureReviewOperationScope,
    hasReviewActionInFlight,
    isCurrentReviewOperationScope,
    persistLatestAcceptedReviewAction,
    pushReviewUndoAction,
  ]);

  const handleRejectAll = useCallback(() => {
    if (!activeChangeSet || hasReviewActionInFlight() || blockReviewMutationForExternalChange()) {
      return;
    }
    const operationScope = captureReviewOperationScope();
    if (!operationScope) return;
    const currentDrafts = useStore.getState().editedContents;
    const requestedFiles = rejectablePendingFiles.filter(
      (file) => !(file.filePath in currentDrafts)
    );
    const rejectableFilePaths = new Set(requestedFiles.map((file) => file.filePath));
    if (rejectableFilePaths.size === 0) return;
    const reviewState = useStore.getState();
    const decisionSnapshot = {
      hunkDecisions: { ...reviewState.hunkDecisions },
      fileDecisions: { ...reviewState.fileDecisions },
    };
    const diskUndoSnapshots: ReviewDiskUndoSnapshot[] = [];
    for (const file of requestedFiles) {
      const content = fileContents[file.filePath] ?? null;
      const isNewFile = resolveReviewFileIsNew(file, content);
      const hunkCount = getFileHunkCount(
        file.filePath,
        file.snippets.length,
        reviewState.fileChunkCounts
      );
      const shouldDeleteOnUndo = shouldDeleteFileWhenUndoingReject(
        file,
        hunkCount,
        decisionSnapshot
      );
      const beforeContent =
        editorViewMapRef.current.get(file.filePath)?.state.doc.toString() ??
        getResolvedReviewModifiedContent(file, content);
      const afterContent = isNewFile ? null : (content?.originalFullContent ?? null);
      if (beforeContent != null && (afterContent != null || isNewFile)) {
        diskUndoSnapshots.push({
          filePath: file.filePath,
          beforeContent,
          afterContent,
          file,
          restoreMode: isNewFile ? 'create-file' : shouldDeleteOnUndo ? 'delete-file' : undefined,
          renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
          fileIndex: isNewFile
            ? activeChangeSet.files.findIndex((candidate) => candidate.filePath === file.filePath)
            : undefined,
        });
      }
      fileApplyInFlightRef.current.add(file.filePath);
      rejectAllFile(file.filePath);
    }
    const preparedAction = pushReviewUndoAction({
      kind: 'bulk',
      descriptor: { intent: 'reject-all', fileCount: requestedFiles.length },
      decisionSnapshot,
      diskSnapshots: diskUndoSnapshots,
    });
    setFilesApplying(new Set(rejectableFilePaths));
    requestAnimationFrame(() => {
      if (!isCurrentReviewOperationScope(operationScope)) return;
      for (const [filePath, view] of editorViewMapRef.current.entries()) {
        if (!rejectableFilePaths.has(filePath)) continue;
        rejectAllChunks(view);
      }
    });
    if (REVIEW_INSTANT_APPLY) {
      // In instant-apply mode we don't show an "Apply" button, so bulk reject must
      // be applied immediately to match Cursor-like UX (including deleting new files).
      void (async () => {
        try {
          if (!isCurrentReviewOperationScope(operationScope)) return;
          if (!ensureDurableReviewScope()) {
            useStore.setState({
              hunkDecisions: decisionSnapshot.hunkDecisions,
              fileDecisions: decisionSnapshot.fileDecisions,
            });
            for (const snapshot of diskUndoSnapshots) {
              rollbackEditorContent(snapshot.filePath, snapshot.beforeContent);
            }
            discardLatestReviewAction(preparedAction);
            return;
          }
          for (const snapshot of diskUndoSnapshots) {
            markRecentReviewWrite(
              snapshot.filePath,
              isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
            );
          }
          const result = await applyReview(teamName, taskId, memberName);
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== changeSetEpoch
          ) {
            return;
          }
          markCommittedReviewPostimages(result?.diskPostimages);
          bindCommittedReviewAction(preparedAction, result?.committedReviewAction);
          const currentDecisionState = useStore.getState();
          const reconciliation = reconcileReviewDecisionRecordsAfterApply(
            requestedFiles,
            result ? result.errors.map((entry) => entry.filePath) : null,
            currentDecisionState,
            decisionSnapshot
          );
          useStore.setState({
            hunkDecisions: reconciliation.hunkDecisions,
            fileDecisions: reconciliation.fileDecisions,
          });
          const failedPaths = new Set(
            reconciliation.failed.map((file) => normalizePathForComparison(file.filePath))
          );
          const successfulFiles = reconciliation.successful;

          for (const file of requestedFiles) {
            if (!failedPaths.has(normalizePathForComparison(file.filePath))) continue;
            const beforeContent = diskUndoSnapshots.find(
              (snapshot) => snapshot.filePath === file.filePath
            )?.beforeContent;
            if (beforeContent !== undefined) rollbackEditorContent(file.filePath, beforeContent);
            useStore.getState().invalidateResolvedFileContent(file.filePath);
            setDiscardCounters((previous) => ({
              ...previous,
              [file.filePath]: (previous[file.filePath] ?? 0) + 1,
            }));
            void fetchFileContent(teamName, memberName, file.filePath);
          }

          for (let index = diskUndoSnapshots.length - 1; index >= 0; index--) {
            if (failedPaths.has(normalizePathForComparison(diskUndoSnapshots[index].filePath))) {
              diskUndoSnapshots.splice(index, 1);
            }
          }

          if (successfulFiles.length === 0) {
            discardLatestReviewAction(preparedAction);
            return;
          }
          const retainedAction = getLatestUndoAction();
          if (
            retainedAction?.id === preparedAction.id &&
            retainedAction.kind === 'bulk' &&
            retainedAction.descriptor?.intent === 'reject-all'
          ) {
            retainedAction.descriptor = {
              intent: 'reject-all',
              fileCount: diskUndoSnapshots.length,
            };
          }

          setUndoInFlight(true);
          await Promise.all(
            diskUndoSnapshots.map(async (snapshot) => {
              if (
                snapshot.afterContent === null ||
                snapshot.restoreMode === 'delete-file' ||
                isLedgerRenameReviewFile(snapshot.file)
              ) {
                return;
              }
              const appliedContent = await readCurrentReviewDiskContent(
                snapshot.filePath,
                snapshot.afterContent
              );
              alignDiskUndoSnapshotWithAppliedContent(snapshot, appliedContent);
            })
          );

          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== changeSetEpoch
          ) {
            return;
          }
          for (const file of successfulFiles) {
            const snapshot = diskUndoSnapshots.find(
              (candidate) =>
                normalizePathForComparison(candidate.filePath) ===
                normalizePathForComparison(file.filePath)
            );
            if (snapshot) {
              markRecentReviewWrite(
                file.filePath,
                isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
              );
            }
          }
          publishReviewUndoHistory();
        } finally {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === changeSetEpoch
          ) {
            for (const file of requestedFiles) {
              fileApplyInFlightRef.current.delete(file.filePath);
            }
            setFilesApplying((previous) => {
              const next = new Set(previous);
              for (const file of requestedFiles) next.delete(file.filePath);
              return next;
            });
            setUndoInFlight(false);
          }
        }
      })();
    } else {
      for (const file of requestedFiles) fileApplyInFlightRef.current.delete(file.filePath);
      setFilesApplying(new Set());
    }
  }, [
    activeChangeSet,
    bindCommittedReviewAction,
    blockReviewMutationForExternalChange,
    captureReviewOperationScope,
    rejectablePendingFiles,
    rejectAllFile,
    applyReview,
    teamName,
    taskId,
    memberName,
    fileContents,
    changeSetEpoch,
    readCurrentReviewDiskContent,
    fetchFileContent,
    hasReviewActionInFlight,
    isCurrentReviewOperationScope,
    markCommittedReviewPostimages,
    markRecentReviewWrite,
    rollbackEditorContent,
    pushReviewUndoAction,
    discardLatestReviewAction,
    ensureDurableReviewScope,
    getLatestUndoAction,
    publishReviewUndoHistory,
    setUndoInFlight,
  ]);

  // File-level accept/reject (Cursor-style)
  const handleRestoreRejectedFileAsAccepted = useCallback(
    async (filePath: string): Promise<void> => {
      if (
        hasReviewDraft(filePath) ||
        hasReviewActionInFlight() ||
        blockReviewMutationForExternalChange(filePath)
      ) {
        return;
      }
      const operationEpoch = changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      const file = activeChangeSet?.files.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      const content = fileContents[filePath] ?? null;
      const isExpectedDeletion = isReviewFileExpectedDeleted(file);
      const normalizedFilePath = normalizePathForComparison(filePath);
      const diskHistory = getReviewUndoHistory().flatMap((action): ReviewDiskUndoAction[] =>
        action.kind === 'disk'
          ? [action.action]
          : action.kind === 'bulk'
            ? action.diskSnapshots.map((snapshot) => ({ snapshot }))
            : []
      );
      const latestDiskSnapshot = [...diskHistory]
        .reverse()
        .find(
          (action) => normalizePathForComparison(action.snapshot.filePath) === normalizedFilePath
        )?.snapshot;
      const sessionSnapshot = [...diskHistory]
        .reverse()
        .find(
          (action) =>
            action.originalIndex === undefined &&
            normalizePathForComparison(action.snapshot.filePath) === normalizedFilePath
        )?.snapshot;
      const hasAuthoritativeAgentContent =
        content?.contentSource === 'ledger-exact' || content?.contentSource === 'ledger-snapshot';
      const canReconstructCreatedFile = resolveReviewFileIsNew(file, content);
      const desiredContent =
        sessionSnapshot?.beforeContent ??
        (hasAuthoritativeAgentContent || canReconstructCreatedFile
          ? getResolvedReviewModifiedContent(file, content)
          : null);
      if (desiredContent === null) {
        useStore.setState({
          applyError:
            'Agent content is unavailable after reopen; restore it from Git or rerun the change.',
        });
        return;
      }

      const decisionSnapshot: ReviewDecisionRecords = {
        hunkDecisions: { ...useStore.getState().hunkDecisions },
        fileDecisions: { ...useStore.getState().fileDecisions },
      };
      const rejectedHunkCount = getFileHunkCount(
        file.filePath,
        file.snippets.length,
        useStore.getState().fileChunkCounts
      );
      const rejectedNewFileWasRemoved =
        canReconstructCreatedFile &&
        isReviewFileFullyRejected(file, rejectedHunkCount, decisionSnapshot);
      useStore.setState({ applyError: null });
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      markRecentReviewWrite(filePath, isExpectedDeletion ? null : desiredContent);
      try {
        if (!decisionScopeToken) {
          throw new Error('Durable review scope is unavailable; refusing an unsafe restore.');
        }
        let rejectedDiskContent =
          sessionSnapshot?.afterContent ?? content?.originalFullContent ?? '';
        let restoredDiskContent: string | null = desiredContent;
        let restoreMode: ReviewDiskUndoSnapshot['restoreMode'] = 'content';
        let renameExpectation: ReviewRenameRecoveryExpectation | null = null;

        if (isLedgerRenameReviewFile(file)) {
          renameExpectation =
            sessionSnapshot?.renameExpectation ?? getReviewRenameRecoveryExpectation(file);
          if (!renameExpectation) {
            throw new Error('Rename recovery metadata is unavailable; refusing an unsafe restore.');
          }
          restoreMode = 'reapply-rejected-rename';
        } else if (isExpectedDeletion) {
          const expectedRejectedContent =
            latestDiskSnapshot?.afterContent ??
            sessionSnapshot?.afterContent ??
            content?.originalFullContent;
          if (expectedRejectedContent === null || expectedRejectedContent === undefined) {
            throw new Error('Deleted file baseline is unavailable; refusing an unsafe restore.');
          }
          rejectedDiskContent = expectedRejectedContent;
          restoredDiskContent = null;
          restoreMode = 'create-file';
        } else if (resolveReviewFileIsNew(file, content)) {
          const current = await api.review.checkConflict(reviewScope, filePath, '');
          const isMissing = current.hasConflict && current.conflictContent === null;
          if (isMissing) {
            rejectedDiskContent = '';
            restoreMode = 'delete-file';
          } else {
            if (rejectedNewFileWasRemoved) {
              throw new Error('A file now exists at this path; refusing to overwrite it.');
            }
            if (hasUnresolvedReviewExternalChange(filePath, reviewExternalChangesByFile)) {
              throw new Error(
                'Choose Reload from disk or Keep my draft before restoring this file.'
              );
            }
            rejectedDiskContent = current.currentContent;
            restoredDiskContent = desiredContent;
          }
        } else {
          const baseline = sessionSnapshot?.afterContent ?? content?.originalFullContent;
          if (baseline === null || baseline === undefined) {
            throw new Error('Original file content is unavailable; unable to restore safely.');
          }
          const current = await api.review.checkConflict(reviewScope, filePath, baseline);
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
          !isCurrentReviewOperationScope(operationScope) ||
          useStore.getState().changeSetEpoch !== operationEpoch
        ) {
          return;
        }
        const quiesced = await quiesceDecisionPersistence(
          teamName,
          decisionScopeKey,
          decisionScopeToken
        );
        if (
          !isCurrentReviewOperationScope(operationScope) ||
          useStore.getState().changeSetEpoch !== operationEpoch
        ) {
          return;
        }
        if (!quiesced) {
          throw new Error('Unable to finish saving the previous review state. Retry Restore.');
        }
        useStore.setState((state) => buildReviewRestoreDecisionState(file, state));

        const snapshot: ReviewDiskUndoSnapshot = {
          filePath,
          beforeContent: rejectedDiskContent,
          afterContent: restoredDiskContent,
          file,
          restoreMode,
          renameExpectation: renameExpectation ?? undefined,
        };
        const undoAction: RecentDiskUndoAction = {
          snapshot,
          file,
          decisionSnapshot,
        };
        const preparedAction = pushReviewUndoAction({
          kind: 'disk',
          descriptor: {
            intent: isLedgerRenameReviewFile(file) ? 'restore-rename' : 'restore-file',
            filePath,
          },
          action: undoAction,
        });
        try {
          const state = useStore.getState();
          markRecentReviewWrite(filePath, restoredDiskContent);
          const committed = await api.review.executeMutation({
            scope: reviewScope,
            decisionPersistenceScope: {
              scopeKey: decisionScopeKey,
              scopeToken: decisionScopeToken,
            },
            kind: isLedgerRenameReviewFile(file) ? 'rename' : 'restore',
            diskSteps: buildForwardDiskMutationSteps(preparedAction.id, [snapshot]),
            persistedState: {
              hunkDecisions: state.hunkDecisions,
              fileDecisions: state.fileDecisions,
              hunkContextHashesByFile: state.hunkContextHashesByFile,
              reviewActionHistory: getReviewUndoHistory(),
              reviewRedoHistory: getReviewRedoHistory(),
            },
            expectedDecisionRevision: state.decisionRevision,
          });
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          markCommittedReviewPostimages(committed.diskPostimages);
          bindCommittedReviewAction(preparedAction, committed.committedReviewAction);
          recordDecisionRevision(
            teamName,
            decisionScopeKey,
            decisionScopeToken,
            committed.decisionRevision
          );
        } catch (error) {
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          restoreFileDecisions(file, decisionSnapshot);
          discardLatestReviewAction(preparedAction);
          throw error;
        }
        markRecentReviewWrite(filePath, restoredDiskContent);
        clearReviewFileExternalChange(filePath);
        useStore.getState().invalidateResolvedFileContent(filePath);
        setDiscardCounters((previous) => ({
          ...previous,
          [filePath]: (previous[filePath] ?? 0) + 1,
        }));
        void fetchFileContent(teamName, memberName, filePath);
      } catch (error) {
        if (
          isCurrentReviewOperationScope(operationScope) &&
          useStore.getState().changeSetEpoch === operationEpoch
        ) {
          useStore.setState({
            applyError: error instanceof Error ? error.message : 'Unable to restore the file.',
          });
          useStore.getState().invalidateResolvedFileContent(filePath);
          setDiscardCounters((previous) => ({
            ...previous,
            [filePath]: (previous[filePath] ?? 0) + 1,
          }));
          void fetchFileContent(teamName, memberName, filePath);
        }
      } finally {
        if (
          isCurrentReviewOperationScope(operationScope) &&
          useStore.getState().changeSetEpoch === operationEpoch
        ) {
          fileApplyInFlightRef.current.delete(filePath);
          setFileApplying(filePath, false);
        }
      }
    },
    [
      activeChangeSet,
      bindCommittedReviewAction,
      blockReviewMutationForExternalChange,
      captureReviewOperationScope,
      changeSetEpoch,
      clearReviewFileExternalChange,
      fetchFileContent,
      fileContents,
      getReviewRedoHistory,
      getReviewUndoHistory,
      hasReviewActionInFlight,
      hasReviewDraft,
      isCurrentReviewOperationScope,
      markCommittedReviewPostimages,
      markRecentReviewWrite,
      memberName,
      decisionScopeKey,
      decisionScopeToken,
      discardLatestReviewAction,
      pushReviewUndoAction,
      quiesceDecisionPersistence,
      recordDecisionRevision,
      restoreFileDecisions,
      reviewExternalChangesByFile,
      reviewScope,
      setFileApplying,
      teamName,
    ]
  );

  const handleAcceptFile = useCallback(
    (filePath: string) => {
      if (
        hasReviewDraft(filePath) ||
        hasReviewActionInFlight() ||
        blockReviewMutationForExternalChange(filePath)
      ) {
        return;
      }
      const file = activeChangeSet?.files.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      const state = useStore.getState();
      const content = state.fileContents[file.filePath];
      const currentFileDecision =
        state.fileDecisions[getFileReviewKey(file)] ?? state.fileDecisions[file.filePath];
      if (
        !content ||
        isReviewAcceptDisabled({
          hasEdits: false,
          isMissingOnDisk: isReviewFileMissingOnDisk(content),
          isContentUnavailable: isReviewTextContentUnavailable(file, content),
          fileDecision: currentFileDecision,
        })
      ) {
        return;
      }
      const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
      if (
        hasReviewFileRejections(file, count, {
          hunkDecisions: state.hunkDecisions,
          fileDecisions: state.fileDecisions,
        })
      ) {
        void handleRestoreRejectedFileAsAccepted(filePath);
        return;
      }
      const decisionSnapshot: ReviewDecisionSnapshot = {
        hunkDecisions: { ...state.hunkDecisions },
        fileDecisions: { ...state.fileDecisions },
      };
      if (!acceptAllFile(filePath)) return;
      pushReviewUndoAction({
        kind: 'bulk',
        descriptor: { intent: 'accept-file', filePath },
        decisionSnapshot,
        diskSnapshots: [],
      });
      void persistLatestAcceptedReviewAction();
      const view = editorViewMapRef.current.get(filePath);
      if (view) {
        requestAnimationFrame(() => acceptAllChunks(view));
      }
    },
    [
      acceptAllFile,
      activeChangeSet,
      blockReviewMutationForExternalChange,
      hasReviewActionInFlight,
      hasReviewDraft,
      handleRestoreRejectedFileAsAccepted,
      persistLatestAcceptedReviewAction,
      pushReviewUndoAction,
    ]
  );

  const handleRejectFile = useCallback(
    async (filePath: string) => {
      if (
        hasReviewDraft(filePath) ||
        hasReviewActionInFlight() ||
        blockReviewMutationForExternalChange(filePath)
      ) {
        return;
      }
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      const operationEpoch = changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) {
        fileApplyInFlightRef.current.delete(filePath);
        setFileApplying(filePath, false);
        return;
      }
      try {
        const file = activeChangeSet?.files.find((f) => f.filePath === filePath);
        if (!file) return;
        const state = useStore.getState();
        if (!isReviewRejectable(file, state.fileContents[file.filePath] ?? null)) return;
        const count = getFileHunkCount(file.filePath, file.snippets.length, state.fileChunkCounts);
        if (
          isReviewFileFullyRejected(file, count, {
            hunkDecisions: state.hunkDecisions,
            fileDecisions: state.fileDecisions,
          })
        ) {
          return;
        }
        const decisionSnapshot = {
          hunkDecisions: { ...state.hunkDecisions },
          fileDecisions: { ...state.fileDecisions },
        };
        const isNew = resolveReviewFileIsNew(file, fileContents[filePath]);
        const shouldDeleteOnUndo = shouldDeleteFileWhenUndoingReject(file, count, decisionSnapshot);
        const view = editorViewMapRef.current.get(filePath);
        const beforeContent =
          view?.state.doc.toString() ??
          (file ? getResolvedReviewModifiedContent(file, fileContents[filePath] ?? null) : null);
        const afterContent = isNew ? null : (fileContents[filePath]?.originalFullContent ?? null);
        const restoreContent =
          beforeContent ?? getResolvedReviewModifiedContent(file, fileContents[filePath] ?? null);
        if (restoreContent === null || (!isNew && afterContent === null)) {
          useStore.setState({
            applyError: 'Exact disk contents are unavailable; refusing a reject without Undo.',
          });
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
                activeChangeSet?.files.findIndex((entry) => entry.filePath === filePath) ?? 0
              )
            : undefined,
          restoreMode: isNew ? 'create-file' : shouldDeleteOnUndo ? 'delete-file' : undefined,
          renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
        };

        // Mark rejected in store + update CM view immediately for feedback
        rejectAllFile(filePath);
        if (view) {
          rejectAllChunks(view);
        }
        const preparedAction = pushReviewUndoAction({
          kind: 'disk',
          descriptor: { intent: 'reject-file', filePath },
          action: { snapshot, file, decisionSnapshot },
        });

        if (REVIEW_INSTANT_APPLY) {
          // Reject a whole file should apply immediately (restore original on disk),
          // and NEW-file reject should delete it.
          markRecentReviewWrite(
            filePath,
            isNew || isLedgerRenameReviewFile(file) ? null : afterContent
          );
          if (!ensureDurableReviewScope()) {
            restoreFileDecisions(file, decisionSnapshot);
            rollbackEditorContent(filePath, restoreContent);
            discardLatestReviewAction(preparedAction);
            return;
          }
          const result = await applySingleFileDecision(teamName, filePath, taskId, memberName);
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          markCommittedReviewPostimages(result?.diskPostimages);
          bindCommittedReviewAction(preparedAction, result?.committedReviewAction);

          if (isNew) {
            const hasErrorForFile =
              !result ||
              result.errors.some(
                (error) =>
                  normalizePathForComparison(error.filePath) ===
                  normalizePathForComparison(filePath)
              );
            if (!hasErrorForFile) {
              markRecentReviewWrite(filePath, null);
              useStore.getState().invalidateResolvedFileContent(filePath);
              void fetchFileContent(teamName, memberName, filePath);
            } else {
              discardLatestReviewAction(preparedAction);
              restoreFileDecisions(file, decisionSnapshot);
              if (beforeContent != null) rollbackEditorContent(filePath, beforeContent);
              useStore.getState().invalidateResolvedFileContent(filePath);
              setDiscardCounters((previous) => ({
                ...previous,
                [filePath]: (previous[filePath] ?? 0) + 1,
              }));
              void fetchFileContent(teamName, memberName, filePath);
            }
          } else {
            const hasErrorForFile =
              !result ||
              result.errors.some(
                (error) =>
                  normalizePathForComparison(error.filePath) ===
                  normalizePathForComparison(filePath)
              );
            if (result && !hasErrorForFile) {
              if (beforeContent != null && afterContent != null) {
                const actualAfterContent = await readCurrentReviewDiskContent(
                  filePath,
                  afterContent
                );
                if (
                  !isCurrentReviewOperationScope(operationScope) ||
                  useStore.getState().changeSetEpoch !== operationEpoch
                ) {
                  return;
                }
                if (snapshot.restoreMode !== 'delete-file' && !isLedgerRenameReviewFile(file)) {
                  alignDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
                }
                publishReviewUndoHistory();
              }
              markRecentReviewWrite(filePath, isLedgerRenameReviewFile(file) ? null : afterContent);
            } else {
              discardLatestReviewAction(preparedAction);
              restoreFileDecisions(file, decisionSnapshot);
              if (beforeContent != null) rollbackEditorContent(filePath, beforeContent);
              useStore.getState().invalidateResolvedFileContent(filePath);
              setDiscardCounters((previous) => ({
                ...previous,
                [filePath]: (previous[filePath] ?? 0) + 1,
              }));
              void fetchFileContent(teamName, memberName, filePath);
            }
          }
        }
      } finally {
        if (
          isCurrentReviewOperationScope(operationScope) &&
          useStore.getState().changeSetEpoch === operationEpoch
        ) {
          fileApplyInFlightRef.current.delete(filePath);
          setFileApplying(filePath, false);
        }
      }
    },
    [
      rejectAllFile,
      activeChangeSet,
      applySingleFileDecision,
      bindCommittedReviewAction,
      teamName,
      taskId,
      blockReviewMutationForExternalChange,
      captureReviewOperationScope,
      memberName,
      markCommittedReviewPostimages,
      markRecentReviewWrite,
      fileContents,
      fetchFileContent,
      changeSetEpoch,
      setFileApplying,
      readCurrentReviewDiskContent,
      hasReviewActionInFlight,
      restoreFileDecisions,
      rollbackEditorContent,
      hasReviewDraft,
      isCurrentReviewOperationScope,
      pushReviewUndoAction,
      discardLatestReviewAction,
      ensureDurableReviewScope,
      publishReviewUndoHistory,
    ]
  );

  // Per-file callbacks for ContinuousScrollView
  const handleHunkAccepted = useCallback(
    (filePath: string, hunkIndex: number) => {
      if (
        hasReviewDraft(filePath) ||
        hasReviewActionInFlight() ||
        blockReviewMutationForExternalChange(filePath)
      ) {
        // Older navigation adapters ignored the callback's `false` result and still
        // mutated CodeMirror. Restore the guarded document after that synchronous call.
        const view = editorViewMapRef.current.get(filePath);
        const guardedContent = view?.state.doc.toString();
        if (view && guardedContent !== undefined) {
          queueMicrotask(() => {
            if (view.dom.isConnected && view.state.doc.toString() !== guardedContent) {
              rollbackEditorContent(filePath, guardedContent);
            }
          });
        }
        return false;
      }
      const originalIndex = setHunkDecision(filePath, hunkIndex, 'accepted');
      const undoAction: RecentHunkUndoAction = { filePath, originalIndex };
      pushReviewUndoAction({
        kind: 'hunk',
        descriptor: { intent: 'accept-hunk', filePath, hunkIndex: originalIndex },
        action: undoAction,
      });
      void persistLatestAcceptedReviewAction();
      return true;
    },
    [
      hasReviewActionInFlight,
      hasReviewDraft,
      blockReviewMutationForExternalChange,
      persistLatestAcceptedReviewAction,
      pushReviewUndoAction,
      rollbackEditorContent,
      setHunkDecision,
    ]
  );

  const handleHunkRejected = useCallback(
    (filePath: string, hunkIndex: number, beforeContent?: string, afterContent?: string) => {
      if (
        hasReviewDraft(filePath) ||
        hasReviewActionInFlight() ||
        blockReviewMutationForExternalChange(filePath)
      ) {
        return false;
      }
      if (beforeContent === undefined || afterContent === undefined) {
        // Backward-compatible path for older navigation adapters that supplied only
        // file/index. Perform the CodeMirror mutation here so disk Undo gets exact bytes.
        const view = editorViewMapRef.current.get(filePath);
        if (!view?.dom.isConnected) return false;
        beforeContent = view.state.doc.toString();
        if (!rejectChunk(view)) return false;
        afterContent = view.state.doc.toString();
      }
      const operationEpoch = changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) {
        const view = editorViewMapRef.current.get(filePath);
        if (view?.dom.isConnected) rollbackEditorContent(filePath, beforeContent);
        return false;
      }
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      const decisionState = useStore.getState();
      const file = activeChangeSet?.files.find((candidate) => candidate.filePath === filePath);
      const hunkCount = file
        ? getFileHunkCount(file.filePath, file.snippets.length, decisionState.fileChunkCounts)
        : 0;
      const shouldDeleteOnUndo = shouldDeleteFileWhenUndoingReject(file, hunkCount, decisionState);
      const originalIndex = setHunkDecision(filePath, hunkIndex, 'rejected');
      const isNewFileFullyRejected = shouldCreateFileWhenUndoingReject(
        file,
        Boolean(file && resolveReviewFileIsNew(file, fileContents[filePath])),
        hunkCount,
        useStore.getState()
      );
      const hunkUndoAction: RecentHunkUndoAction = { filePath, originalIndex };
      if (REVIEW_INSTANT_APPLY) {
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
          renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
        };
        const preparedAction = pushReviewUndoAction({
          kind: 'disk',
          descriptor: { intent: 'reject-hunk', filePath, hunkIndex: originalIndex },
          action: { snapshot, originalIndex },
        });
        markRecentReviewWrite(filePath, isNewFileFullyRejected ? null : afterContent);
        void (async () => {
          try {
            if (!ensureDurableReviewScope()) {
              rollbackEditorContent(filePath, beforeContent);
              clearHunkDecisionByOriginalIndex(filePath, originalIndex);
              discardLatestReviewAction(preparedAction);
              return;
            }
            const result = await applySingleFileDecision(teamName, filePath, taskId, memberName);
            if (
              !isCurrentReviewOperationScope(operationScope) ||
              useStore.getState().changeSetEpoch !== operationEpoch
            ) {
              return;
            }
            markCommittedReviewPostimages(result?.diskPostimages);
            bindCommittedReviewAction(preparedAction, result?.committedReviewAction);
            const hasErrorForFile =
              !result ||
              result.errors.some(
                (error) =>
                  normalizePathForComparison(error.filePath) ===
                  normalizePathForComparison(filePath)
              );
            if (result && !hasErrorForFile) {
              const actualAfterContent = isNewFileFullyRejected
                ? null
                : await readCurrentReviewDiskContent(filePath, afterContent);
              if (
                !isCurrentReviewOperationScope(operationScope) ||
                useStore.getState().changeSetEpoch !== operationEpoch
              ) {
                return;
              }
              if (
                actualAfterContent !== null &&
                snapshot.restoreMode !== 'delete-file' &&
                !isLedgerRenameReviewFile(snapshot.file)
              ) {
                alignDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
              }
              publishReviewUndoHistory();
              markRecentReviewWrite(filePath, snapshot.afterContent);
              return;
            }

            const view = editorViewMapRef.current.get(filePath);
            if (view?.dom.isConnected) rollbackEditorContent(filePath, beforeContent);
            clearHunkDecisionByOriginalIndex(filePath, originalIndex);
            discardLatestReviewAction(preparedAction);
            useStore.getState().invalidateResolvedFileContent(filePath);
            setDiscardCounters((previous) => ({
              ...previous,
              [filePath]: (previous[filePath] ?? 0) + 1,
            }));
            void fetchFileContent(teamName, memberName, filePath);
          } finally {
            if (
              isCurrentReviewOperationScope(operationScope) &&
              useStore.getState().changeSetEpoch === operationEpoch
            ) {
              fileApplyInFlightRef.current.delete(filePath);
              setFileApplying(filePath, false);
            }
          }
        })();
      } else {
        fileApplyInFlightRef.current.delete(filePath);
        setFileApplying(filePath, false);
        pushReviewUndoAction({
          kind: 'hunk',
          descriptor: { intent: 'reject-hunk', filePath, hunkIndex: originalIndex },
          action: hunkUndoAction,
        });
      }
      return true;
    },
    [
      hasReviewActionInFlight,
      hasReviewDraft,
      changeSetEpoch,
      setHunkDecision,
      clearHunkDecisionByOriginalIndex,
      applySingleFileDecision,
      bindCommittedReviewAction,
      teamName,
      taskId,
      markCommittedReviewPostimages,
      memberName,
      markRecentReviewWrite,
      fetchFileContent,
      setFileApplying,
      readCurrentReviewDiskContent,
      rollbackEditorContent,
      activeChangeSet,
      blockReviewMutationForExternalChange,
      captureReviewOperationScope,
      fileContents,
      isCurrentReviewOperationScope,
      pushReviewUndoAction,
      discardLatestReviewAction,
      ensureDurableReviewScope,
      publishReviewUndoHistory,
    ]
  );

  const handleContentChanged = useCallback(
    (filePath: string, content: string, previousContent?: string) => {
      const baselineKey = normalizePathForComparison(filePath);
      unsuppressDraftHistoryFile(baselineKey);
      if (!hasDraftHistoryBaseline(baselineKey)) {
        const fileContent = fileContents[filePath] ?? null;
        if (isReviewFileMissingOnDisk(fileContent)) {
          setDraftHistoryBaseline(baselineKey, null);
        } else {
          const baseline =
            previousContent ??
            getResolvedReviewModifiedContent(
              activeChangeSet?.files.find((file) => file.filePath === filePath) ?? {
                filePath,
                relativePath: filePath,
                snippets: [],
                linesAdded: 0,
                linesRemoved: 0,
                isNewFile: false,
              },
              fileContent
            );
          if (baseline != null) setDraftHistoryBaseline(baselineKey, baseline);
        }
      }
      const diskBaseline = getDraftHistoryBaseline(baselineKey);
      if (diskBaseline !== null && diskBaseline !== undefined && content === diskBaseline) {
        discardFileEdits(filePath);
      } else {
        updateEditedContent(filePath, content);
      }
    },
    [
      activeChangeSet,
      discardFileEdits,
      fileContents,
      getDraftHistoryBaseline,
      hasDraftHistoryBaseline,
      setDraftHistoryBaseline,
      unsuppressDraftHistoryFile,
      updateEditedContent,
    ]
  );

  const handleFullyViewed = useCallback(
    (filePath: string) => {
      if (autoViewed && !isViewed(filePath)) {
        markViewed(filePath);
      }
    },
    [autoViewed, isViewed, markViewed]
  );

  const handleSaveFile = useCallback(
    async (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      const initialState = useStore.getState();
      if (!(filePath in initialState.editedContents)) return;
      const hasUnresolvedExternalChange = hasUnresolvedReviewExternalChange(
        filePath,
        initialState.reviewExternalChangesByFile
      );
      if (hasUnresolvedExternalChange) {
        useStore.setState({
          applyError: 'Choose Reload from disk or Keep my draft before saving this file.',
        });
        return;
      }
      const baselineKey = normalizePathForComparison(filePath);
      if (!hasDraftHistoryBaseline(baselineKey)) {
        useStore.setState({
          applyError: 'The draft disk baseline is unavailable. Reload the file before saving.',
        });
        return;
      }
      const expectedCurrentContent = getDraftHistoryBaseline(baselineKey) ?? null;
      const contentToSave = initialState.editedContents[filePath];
      if (contentToSave === undefined) return;
      const operationEpoch = initialState.changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      markRecentReviewWrite(filePath, contentToSave);
      await saveEditedFile(filePath, reviewScope, expectedCurrentContent);
      if (!isCurrentReviewOperationScope(operationScope)) return;
      const state = useStore.getState();
      if (state.changeSetEpoch === operationEpoch && !state.applyError) {
        // Keep the exact saved baseline even when the buffer is clean. Native history is
        // still valuable: Undo after Save (or restart) should produce a dirty draft.
        setDraftHistoryBaseline(baselineKey, contentToSave);
        const serializedState = getDraftHistoryEntry(filePath)?.editorState;
        if (serializedState) {
          publishDraftHistoryCheckpoint(filePath, serializedState, contentToSave);
          const flushed = await flushDraftHistoryWrites();
          if (!isCurrentReviewOperationScope(operationScope)) return;
          if (!flushed) {
            useStore.setState({
              applyError: 'The file was saved, but its durable Undo history could not be updated.',
            });
          }
        }
        clearReviewActionHistoryForFile(filePath);
        markRecentReviewWrite(filePath, contentToSave);
      }
    },
    [
      captureReviewOperationScope,
      clearReviewActionHistoryForFile,
      hasReviewActionInFlight,
      isCurrentReviewOperationScope,
      saveEditedFile,
      reviewScope,
      markRecentReviewWrite,
      publishDraftHistoryCheckpoint,
      flushDraftHistoryWrites,
      getDraftHistoryBaseline,
      getDraftHistoryEntry,
      hasDraftHistoryBaseline,
      setDraftHistoryBaseline,
    ]
  );

  const handleRestoreMissingFile = useCallback(
    (filePath: string, content: string) => {
      if (hasReviewActionInFlight()) return;
      const operationEpoch = useStore.getState().changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      const baselineKey = normalizePathForComparison(filePath);
      setDraftHistoryBaseline(baselineKey, null);
      markRecentReviewWrite(filePath, content);
      updateEditedContent(filePath, content);
      // Ensure editedContents is set before saveEditedFile reads it.
      void Promise.resolve().then(async () => {
        if (!isCurrentReviewOperationScope(operationScope)) return;
        await saveEditedFile(filePath, reviewScope, null);
        if (!isCurrentReviewOperationScope(operationScope)) return;
        const state = useStore.getState();
        if (state.changeSetEpoch === operationEpoch && !state.applyError) {
          setDraftHistoryBaseline(baselineKey, content);
          const serializedState = getDraftHistoryEntry(filePath)?.editorState;
          if (serializedState) {
            publishDraftHistoryCheckpoint(filePath, serializedState, content);
            const flushed = await flushDraftHistoryWrites();
            if (!isCurrentReviewOperationScope(operationScope)) return;
            if (!flushed) {
              useStore.setState({
                applyError:
                  'The file was restored, but its durable Undo history could not be updated.',
              });
            }
          }
          clearReviewActionHistoryForFile(filePath);
          markRecentReviewWrite(filePath, content);
        }
      });
    },
    [
      captureReviewOperationScope,
      hasReviewActionInFlight,
      isCurrentReviewOperationScope,
      clearReviewActionHistoryForFile,
      updateEditedContent,
      saveEditedFile,
      reviewScope,
      markRecentReviewWrite,
      publishDraftHistoryCheckpoint,
      flushDraftHistoryWrites,
      getDraftHistoryEntry,
      setDraftHistoryBaseline,
    ]
  );

  const handleReloadFromDisk = useCallback(
    (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      const operationEpoch = useStore.getState().changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      void (async () => {
        try {
          if (!decisionScopeToken) {
            throw new Error('Durable review scope is unavailable; refusing an unsafe reload.');
          }
          const quiesced = await quiesceDecisionPersistence(
            teamName,
            decisionScopeKey,
            decisionScopeToken
          );
          if (!isCurrentReviewOperationScope(operationScope)) return;
          if (!quiesced) {
            throw new Error('Unable to finish saving the previous review state. Retry Reload.');
          }
          const state = useStore.getState();
          const file = state.activeChangeSet?.files.find(
            (candidate) =>
              normalizePathForComparison(candidate.filePath) ===
              normalizePathForComparison(filePath)
          );
          if (!file) throw new Error('Reviewed file is unavailable for Reload.');
          const next = buildReviewExternalReloadState(file, {
            hunkDecisions: state.hunkDecisions,
            fileDecisions: state.fileDecisions,
            hunkContextHashesByFile: state.hunkContextHashesByFile,
            reviewActionHistory: getReviewUndoHistory(),
            reviewRedoHistory: getReviewRedoHistory(),
          });
          const committed = await api.review.executeMutation({
            scope: reviewScope,
            decisionPersistenceScope: {
              scopeKey: decisionScopeKey,
              scopeToken: decisionScopeToken,
            },
            kind: 'reload-external',
            externalFilePath: filePath,
            diskSteps: [],
            persistedState: next,
            expectedDecisionRevision: state.decisionRevision,
          });
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          replaceReviewActionHistories(next.reviewActionHistory, next.reviewRedoHistory);
          recordDecisionRevision(
            teamName,
            decisionScopeKey,
            decisionScopeToken,
            committed.decisionRevision
          );
          deleteDraftHistoryBaseline(filePath);
          useStore.setState({
            hunkDecisions: next.hunkDecisions,
            fileDecisions: next.fileDecisions,
            hunkContextHashesByFile: next.hunkContextHashesByFile ?? {},
            applyError: null,
          });
          // Never destroy recoverable draft history before the durable review mutation
          // commits. If cleanup fails, the external-change barrier stays visible and the
          // user can retry without losing the draft across a restart.
          await clearDraftHistoryForFile(filePath);
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          reloadReviewFileFromDisk(filePath);
          setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
          void fetchFileContent(teamName, memberName, filePath);
        } catch (error) {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === operationEpoch
          ) {
            useStore.setState({
              applyError:
                error instanceof Error ? error.message : 'Unable to reload the external file.',
            });
          }
        } finally {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === operationEpoch
          ) {
            fileApplyInFlightRef.current.delete(filePath);
            setFileApplying(filePath, false);
          }
        }
      })();
    },
    [
      captureReviewOperationScope,
      clearDraftHistoryForFile,
      deleteDraftHistoryBaseline,
      decisionScopeKey,
      decisionScopeToken,
      fetchFileContent,
      hasReviewActionInFlight,
      isCurrentReviewOperationScope,
      memberName,
      quiesceDecisionPersistence,
      recordDecisionRevision,
      reloadReviewFileFromDisk,
      reviewScope,
      getReviewRedoHistory,
      getReviewUndoHistory,
      replaceReviewActionHistories,
      setFileApplying,
      teamName,
    ]
  );

  const handleKeepDraft = useCallback(
    (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      const baselineKey = normalizePathForComparison(filePath);
      if (!hasDraftHistoryBaseline(baselineKey)) {
        useStore.setState({
          applyError: 'The draft disk baseline is unavailable. Reload the file before continuing.',
        });
        return;
      }
      const expected = getDraftHistoryBaseline(baselineKey) ?? '';
      const operationEpoch = useStore.getState().changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      void (async () => {
        try {
          const current = await api.review.checkConflict(reviewScope, filePath, expected);
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          const nextBaseline =
            current.hasConflict && current.conflictContent === null ? null : current.currentContent;
          setDraftHistoryBaseline(baselineKey, nextBaseline);
          const serializedState = getDraftHistoryEntry(filePath)?.editorState;
          if (serializedState) {
            publishDraftHistoryCheckpoint(filePath, serializedState, nextBaseline);
            const flushed = await flushDraftHistoryWrites();
            if (!isCurrentReviewOperationScope(operationScope)) return;
            if (!flushed) {
              throw new Error('Unable to persist the rebased manual edit history');
            }
          }
          clearReviewFileExternalChange(filePath);
          useStore.setState({ applyError: null });
        } catch (error) {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === operationEpoch
          ) {
            useStore.setState({ applyError: String(error) });
          }
        } finally {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === operationEpoch
          ) {
            fileApplyInFlightRef.current.delete(filePath);
            setFileApplying(filePath, false);
          }
        }
      })();
    },
    [
      captureReviewOperationScope,
      clearReviewFileExternalChange,
      flushDraftHistoryWrites,
      getDraftHistoryBaseline,
      getDraftHistoryEntry,
      hasDraftHistoryBaseline,
      hasReviewActionInFlight,
      isCurrentReviewOperationScope,
      publishDraftHistoryCheckpoint,
      reviewScope,
      setFileApplying,
      setDraftHistoryBaseline,
    ]
  );

  const handleDiscardFile = useCallback(
    (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      const state = useStore.getState();
      if (hasUnresolvedReviewExternalChange(filePath, state.reviewExternalChangesByFile)) {
        handleReloadFromDisk(filePath);
        return;
      }
      const operationEpoch = state.changeSetEpoch;
      const operationScope = captureReviewOperationScope();
      if (!operationScope) return;
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      void (async () => {
        try {
          await clearDraftHistoryForFile(filePath);
          if (
            !isCurrentReviewOperationScope(operationScope) ||
            useStore.getState().changeSetEpoch !== operationEpoch
          ) {
            return;
          }
          deleteDraftHistoryBaseline(filePath);
          discardFileEdits(filePath);
          setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
        } catch {
          // clearDraftHistoryForFile already reports the durable-history failure. Keep the
          // editor and its local Undo state intact so Discard can be retried safely.
        } finally {
          if (
            isCurrentReviewOperationScope(operationScope) &&
            useStore.getState().changeSetEpoch === operationEpoch
          ) {
            fileApplyInFlightRef.current.delete(filePath);
            setFileApplying(filePath, false);
          }
        }
      })();
    },
    [
      captureReviewOperationScope,
      clearDraftHistoryForFile,
      deleteDraftHistoryBaseline,
      discardFileEdits,
      handleReloadFromDisk,
      hasReviewActionInFlight,
      isCurrentReviewOperationScope,
      setFileApplying,
    ]
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
  const reviewHistoryMutationViewPort = useMemo<ChangeReviewHistoryMutationViewPort>(
    () => ({
      addMissingFile: (file, index, content) =>
        addReviewFile(file, {
          index,
          content: {
            ...file,
            originalFullContent: '',
            modifiedFullContent: content,
            isNewFile: true,
            contentSource: 'disk-current',
          },
        }),
      fetchFileContent: (targetTeamName, targetMemberName, filePath) => {
        void fetchFileContent(targetTeamName, targetMemberName, filePath);
      },
      incrementDiscardCounters: (filePaths) => {
        setDiscardCounters((previous) => {
          const next = { ...previous };
          for (const filePath of filePaths) {
            next[filePath] = (next[filePath] ?? 0) + 1;
          }
          return next;
        });
      },
      navigateToAction: handleHistoryActionNavigation,
      markExpectedWrite: markRecentReviewWrite,
      clearExpectedWrite: (filePath) => {
        recentReviewWritesRef.current.delete(normalizePathForComparison(filePath));
      },
      markCommittedPostimages: markCommittedReviewPostimages,
      setMutationInFlight: setUndoInFlight,
    }),
    [
      addReviewFile,
      fetchFileContent,
      handleHistoryActionNavigation,
      markCommittedReviewPostimages,
      markRecentReviewWrite,
      setUndoInFlight,
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
    viewPort: reviewHistoryMutationViewPort,
    captureOperationScope: captureReviewOperationScope,
    isCurrentOperationScope: isCurrentReviewOperationScope,
    hasActionInFlight: hasReviewActionInFlight,
    isFileMutationInFlight: isReviewFileMutationInFlight,
    blockForExternalChange: blockReviewMutationForExternalChange,
    getPersistenceStatus: getReviewActionPersistenceStatus,
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

  const flushReviewStateForClose = useCallback(async (): Promise<ReviewCloseFlushResult> => {
    const operationScope = captureReviewOperationScope();
    if (!operationScope) {
      return { ok: false, blocker: 'Review scope changed before Changes could close.' };
    }
    const scopeChangedResult: ReviewCloseFlushResult = {
      ok: false,
      blocker: 'Review scope changed while Changes was closing.',
    };
    const state = useStore.getState();
    const draftHistoryDiagnostics = getDraftHistoryDiagnostics();
    const decisionPersistenceDiagnostics = getReviewDecisionPersistenceDiagnostics();
    const localStateRequiresScope = hasUnscopedLocalReviewState({
      editedContentCount: Object.keys(state.editedContents).length,
      hunkDecisionCount: Object.keys(state.hunkDecisions).length,
      fileDecisionCount: Object.keys(state.fileDecisions).length,
      undoHistoryCount: state.reviewActionHistory.length,
      redoHistoryCount: state.reviewRedoHistory.length,
      pendingDraftWriteCount: draftHistoryDiagnostics.pendingWriteCount,
      draftWriteChainCount: draftHistoryDiagnostics.writeChainCount,
      draftWriteErrorCount: draftHistoryDiagnostics.writeErrorCount,
      pendingApplyCleanup: pendingApplyCleanupKeyRef.current !== null,
      pendingDecisionClear: decisionPersistenceDiagnostics.pendingDecisionClear,
      persistenceStatus: decisionPersistenceDiagnostics.persistenceStatus,
    });
    if (!decisionHydrationKey && localStateRequiresScope) {
      const blocker =
        'Manual edit history lost its saved review scope. Keep Changes open and retry recovery.';
      useStore.setState({ applyError: blocker });
      return { ok: false, blocker };
    }
    if (decisionHydrationKey) {
      const matchesCurrentHydration = state.decisionHydrationScopeKey === decisionHydrationKey;
      const matchesDraftHydration = draftHistoryHydration.key === decisionHydrationKey;
      if (
        (matchesCurrentHydration && state.decisionHydrationStatus === 'error') ||
        (matchesDraftHydration && draftHistoryHydration.status === 'error')
      ) {
        const scopedDraftHistoryDiagnostics = getDraftHistoryDiagnostics(decisionHydrationKey);
        const hasLocalState =
          Object.keys(state.editedContents).length > 0 ||
          Object.keys(state.hunkDecisions).length > 0 ||
          Object.keys(state.fileDecisions).length > 0 ||
          state.reviewActionHistory.length > 0 ||
          state.reviewRedoHistory.length > 0 ||
          scopedDraftHistoryDiagnostics.pendingWriteCount > 0 ||
          scopedDraftHistoryDiagnostics.writeChainCount > 0 ||
          scopedDraftHistoryDiagnostics.writeErrorCount > 0 ||
          pendingApplyCleanupKeyRef.current === decisionHydrationKey ||
          decisionPersistenceDiagnostics.pendingDecisionClear ||
          decisionPersistenceDiagnostics.persistenceStatus !== 'saved';
        if (hasLocalState) {
          const blocker =
            'Saved review state could not be reconciled with local changes. Retry recovery before closing Changes.';
          useStore.setState({ applyError: blocker });
          return { ok: false, blocker };
        }
        // With no local branch to lose, preserve the last readable disk copy and close.
        return { ok: true };
      }
      if (
        !matchesCurrentHydration ||
        state.decisionHydrationStatus !== 'loaded' ||
        !matchesDraftHydration ||
        draftHistoryHydration.status !== 'loaded'
      ) {
        const blocker = 'Wait for saved review state to finish loading before closing Changes.';
        useStore.setState({ applyError: blocker });
        return { ok: false, blocker };
      }
    }
    const blockReason = getReviewCloseBlockReason({
      busy: isReviewActionLocked({
        applying: state.applying,
        fileApplyCount: fileApplyInFlightRef.current.size,
        undoing: undoInFlightRef.current,
        closing: closingRef.current,
      }),
      draftCount: 0,
    });
    if (blockReason) {
      useStore.setState({ applyError: blockReason });
      return { ok: false, blocker: blockReason };
    }

    closingRef.current = true;
    setClosing(true);
    try {
      for (const [filePath, view] of editorViewMapRef.current.entries()) {
        if (filePath in state.editedContents || getDraftHistoryEntry(filePath)) {
          handleSerializedStateChanged(filePath, serializeReviewDraftEditorState(view.state));
        }
      }
      const currentState = useStore.getState();
      for (const filePath of Object.keys(currentState.editedContents)) {
        if (!getDraftHistoryEntry(filePath)) {
          const blocker = `Manual edits for ${filePath} are not durable yet. Keep Changes open and retry.`;
          useStore.setState({ applyError: blocker });
          return { ok: false, blocker };
        }
      }
      const draftsFlushed = await flushDraftHistoryWrites();
      if (!isCurrentReviewOperationScope(operationScope)) return scopeChangedResult;
      if (!draftsFlushed) {
        const blocker = 'Unable to save manual edit history. Changes remains open.';
        useStore.setState({ applyError: blocker });
        return { ok: false, blocker };
      }
      if (decisionScopeToken && pendingApplyCleanupKeyRef.current === decisionHydrationKey) {
        const cleared = await clearDecisionsFromDisk(
          teamName,
          decisionScopeKey,
          decisionScopeToken
        );
        if (!isCurrentReviewOperationScope(operationScope)) return scopeChangedResult;
        if (!cleared) {
          const blocker =
            'Review was applied, but its saved state could not be cleared. Changes remains open.';
          useStore.setState({ applyError: blocker });
          return { ok: false, blocker };
        }
        pendingApplyCleanupKeyRef.current = null;
        return { ok: true };
      }
      if (decisionScopeToken) {
        const flushed = await flushReviewDecisionsForClose();
        if (!isCurrentReviewOperationScope(operationScope)) return scopeChangedResult;
        if (!flushed) {
          const blocker = 'Unable to save review decisions. Changes remains open.';
          useStore.setState({ applyError: blocker });
          return { ok: false, blocker };
        }
      }
      return { ok: true };
    } finally {
      if (isCurrentReviewOperationScope(operationScope)) {
        closingRef.current = false;
        setClosing(false);
      }
    }
  }, [
    captureReviewOperationScope,
    clearDecisionsFromDisk,
    decisionScopeKey,
    decisionHydrationKey,
    decisionScopeToken,
    draftHistoryHydration.key,
    draftHistoryHydration.status,
    flushDraftHistoryWrites,
    flushReviewDecisionsForClose,
    getDraftHistoryDiagnostics,
    getDraftHistoryEntry,
    getReviewDecisionPersistenceDiagnostics,
    handleSerializedStateChanged,
    isCurrentReviewOperationScope,
    teamName,
  ]);

  const requestLifecycleClose = useCallback(async (): Promise<boolean> => {
    const operationScope = captureReviewOperationScope();
    if (!operationScope) return false;
    const result = await flushReviewStateForClose();
    if (!isCurrentReviewOperationScope(operationScope)) return false;
    if (result.ok) onOpenChange(false);
    return result.ok;
  }, [
    captureReviewOperationScope,
    flushReviewStateForClose,
    isCurrentReviewOperationScope,
    onOpenChange,
  ]);

  const requestClose = useCallback(async (): Promise<void> => {
    await requestLifecycleClose();
  }, [requestLifecycleClose]);

  const closeRejectedDialog = useCallback((): void => onOpenChange(false), [onOpenChange]);
  useChangeReviewLifecycleRegistration({
    open,
    authorized: lifecycleAuthorized,
    hostId: resolvedLifecycleHostId,
    sessionId: reviewLifecycleSessionId,
    tabId: lifecycleTabId,
    focus: onLifecycleFocus,
    requestClose: requestLifecycleClose,
    closeRejectedDialog,
    setAuthorized: setLifecycleAuthorized,
    appCloseParticipantId: `changes:${teamName}:${decisionHydrationKey ?? scopeKey}`,
    flushForAppClose: flushReviewStateForClose,
    registerOwner: registerChangeReviewLifecycleOwner,
    registerAppCloseParticipant,
  });

  const handleRetrySavedReviewState = useCallback(async (): Promise<void> => {
    if (!decisionScopeToken || !decisionHydrationKey || reviewMutationBusy) return;
    const operationScope = captureReviewOperationScope();
    if (!operationScope) return;
    setUndoInFlight(true);
    try {
      if (decisionHydrationFailed) {
        const recovered = await api.review.retryMutationRecovery({
          scope: reviewScope,
          decisionPersistenceScope: {
            scopeKey: decisionScopeKey,
            scopeToken: decisionScopeToken,
          },
        });
        if (!isCurrentReviewOperationScope(operationScope)) return;
        markCommittedReviewPostimages(recovered.diskPostimages);
        await hydrateReviewDecisions(
          { teamName, scopeKey: decisionScopeKey, scopeToken: decisionScopeToken },
          decisionHydrationKey
        );
        if (!isCurrentReviewOperationScope(operationScope)) return;
      }
      if (draftHistoryHydrationFailed) {
        retryDraftHistoryHydration();
      }
    } catch (error) {
      if (!isCurrentReviewOperationScope(operationScope)) return;
      useStore.setState({
        applyError: `Unable to resume the saved review update: ${String(error)}`,
      });
    } finally {
      if (isCurrentReviewOperationScope(operationScope)) setUndoInFlight(false);
    }
  }, [
    captureReviewOperationScope,
    decisionHydrationFailed,
    decisionScopeKey,
    decisionScopeToken,
    draftHistoryHydrationFailed,
    retryDraftHistoryHydration,
    decisionHydrationKey,
    hydrateReviewDecisions,
    isCurrentReviewOperationScope,
    markCommittedReviewPostimages,
    reviewMutationBusy,
    reviewScope,
    setUndoInFlight,
    teamName,
  ]);

  const handleDiscardSavedDecisionState = useCallback(async (): Promise<void> => {
    if (!decisionScopeToken || !decisionHydrationKey || reviewMutationBusy) {
      throw new Error('Saved review state is not ready to be discarded.');
    }
    const operationScope = captureReviewOperationScope();
    if (!operationScope) throw new Error('Saved review scope is no longer active.');
    closingRef.current = true;
    setClosing(true);
    try {
      if (decisionHydrationFailed) {
        const cleared = await clearDecisionsFromDisk(
          teamName,
          decisionScopeKey,
          decisionScopeToken,
          true
        );
        if (!isCurrentReviewOperationScope(operationScope)) return;
        if (!cleared) {
          const message = 'Unable to discard the unreadable saved review decisions.';
          useStore.setState({ applyError: message });
          throw new Error(message);
        }
      }
      if (draftHistoryHydrationFailed) {
        try {
          const discarded = await discardUnreadableDraftHistoryScope(operationScope);
          if (!discarded) return;
        } catch (error) {
          if (!isCurrentReviewOperationScope(operationScope)) return;
          const message = `Unable to discard the unreadable manual edit history: ${String(error)}`;
          useStore.setState({ applyError: message });
          throw new Error(message, { cause: error });
        }
      }
      const state = useStore.getState();
      if (decisionHydrationFailed && state.decisionHydrationScopeKey !== decisionHydrationKey) {
        throw new Error('Saved review scope changed before it could be discarded.');
      }
      // Keep any in-memory choice that raced an earlier load. Only the explicitly
      // discarded disk copy is reset; the current review can now become authoritative.
      useStore.setState({
        ...(decisionHydrationFailed ? { decisionHydrationStatus: 'loaded' as const } : {}),
        applyError: null,
      });
    } finally {
      if (isCurrentReviewOperationScope(operationScope)) {
        closingRef.current = false;
        setClosing(false);
      }
    }
  }, [
    captureReviewOperationScope,
    clearDecisionsFromDisk,
    decisionHydrationFailed,
    decisionHydrationKey,
    decisionScopeKey,
    decisionScopeToken,
    discardUnreadableDraftHistoryScope,
    draftHistoryHydrationFailed,
    isCurrentReviewOperationScope,
    reviewMutationBusy,
    teamName,
  ]);

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

  // Load data on open
  useEffect(() => {
    if (!open || !lifecycleAuthorized) return;

    resetAllReviewState();

    // Fetch changeSet
    if (mode === 'agent' && memberName) {
      void fetchAgentChanges(teamName, memberName);
    } else if (mode === 'task' && taskId) {
      void fetchTaskChanges(teamName, taskId, taskChangeRequestOptions ?? {});
    }

    // On close - clear only volatile cache, keep decisions in store
    return () => clearChangeReviewCache();
  }, [
    open,
    lifecycleAuthorized,
    mode,
    teamName,
    memberName,
    taskId,
    taskChangeRequestOptions,
    decisionScopeKey,
    fetchAgentChanges,
    fetchTaskChanges,
    clearChangeReviewCache,
    resetAllReviewState,
  ]);

  useEffect(() => {
    if (!open || !lifecycleAuthorized || !decisionScopeToken || !decisionHydrationKey) return;
    void hydrateReviewDecisions(
      { teamName, scopeKey: decisionScopeKey, scopeToken: decisionScopeToken },
      decisionHydrationKey
    );
  }, [
    decisionHydrationKey,
    decisionScopeKey,
    decisionScopeToken,
    lifecycleAuthorized,
    hydrateReviewDecisions,
    open,
    teamName,
  ]);

  // Persist decisions to disk on change (debounced via store action).
  // When decisions go from non-empty to empty (e.g. undo to clean state),
  // clear the persisted file so stale decisions don't reload on reopen.
  const hasDurableReviewState =
    Object.keys(hunkDecisions).length > 0 ||
    Object.keys(fileDecisions).length > 0 ||
    reviewActionHistory.length > 0 ||
    reviewRedoHistory.length > 0;
  useChangeReviewDecisionAutoPersistence({
    active: open && lifecycleAuthorized,
    hydrationKey: decisionHydrationKey,
    scope: conflictScope,
    hydrationReady: decisionHydrationReady,
    blocked: reviewActionsBusy,
    hasDurableReviewState,
    hunkDecisions,
    fileDecisions,
    undoHistory: reviewActionHistory,
    redoHistory: reviewRedoHistory,
    fileContents,
    fileChunkCounts,
    scheduleAutoPersistence: scheduleReviewDecisionAutoPersistence,
    clearAfterDurableStateEmptied: clearReviewDecisionsAfterStateEmptied,
  });

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

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (
        shouldRequestReviewCloseForEscape({
          key: e.key,
          defaultPrevented: e.defaultPrevented,
          hasOpenModalLayer: Boolean(
            document.querySelector('[role="alertdialog"][data-state="open"]')
          ),
        })
      ) {
        e.preventDefault();
        void requestClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, requestClose]);

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

  const handleApply = useCallback(async () => {
    if (hasReviewActionInFlight() || blockReviewMutationForExternalChange()) return;
    if (!decisionScopeToken || !decisionHydrationKey) {
      useStore.setState({
        applyError: 'Durable review scope is unavailable. Reload Changes before applying.',
      });
      return;
    }
    const operationScope = captureReviewOperationScope();
    if (!operationScope) return;

    if (pendingApplyCleanupKeyRef.current !== decisionHydrationKey) {
      const result = await applyReview(teamName, taskId, memberName);
      if (!isCurrentReviewOperationScope(operationScope)) return;
      markCommittedReviewPostimages(result?.diskPostimages);
      if (useStore.getState().applyError) return;
      if (expectedDraftHistoryKeyRef.current !== decisionHydrationKey) return;
      pendingApplyCleanupKeyRef.current = decisionHydrationKey;
    }

    closingRef.current = true;
    setClosing(true);
    try {
      const cleared = await clearDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken);
      if (!isCurrentReviewOperationScope(operationScope)) return;
      if (!cleared) {
        useStore.setState({
          applyError:
            'Review was applied, but its saved state could not be cleared. Changes remains open; retry Apply to finish cleanup.',
        });
        return;
      }
      pendingApplyCleanupKeyRef.current = null;
      if (expectedDraftHistoryKeyRef.current === decisionHydrationKey) {
        resetAllReviewState();
      }
    } finally {
      if (isCurrentReviewOperationScope(operationScope)) {
        closingRef.current = false;
        setClosing(false);
      }
    }
  }, [
    applyReview,
    blockReviewMutationForExternalChange,
    captureReviewOperationScope,
    teamName,
    taskId,
    memberName,
    markCommittedReviewPostimages,
    clearDecisionsFromDisk,
    decisionHydrationKey,
    decisionScopeKey,
    decisionScopeToken,
    resetAllReviewState,
    hasReviewActionInFlight,
    isCurrentReviewOperationScope,
  ]);

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
