import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { redoDepth, undoDepth } from '@codemirror/commands';
import { Transaction } from '@codemirror/state';
import { serializeReviewDraftEditorState } from '@features/change-review-history/renderer';
import { useAppTranslation } from '@features/localization/renderer';
import { api, isElectronMode } from '@renderer/api';
import { EditorSelectionMenu } from '@renderer/components/team/editor/EditorSelectionMenu';
import { Button } from '@renderer/components/ui/button';
import { useContinuousScrollNav } from '@renderer/hooks/useContinuousScrollNav';
import { useDiffNavigation } from '@renderer/hooks/useDiffNavigation';
import { useViewedFiles } from '@renderer/hooks/useViewedFiles';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFileHunkCount, REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';
import { buildSelectionAction } from '@renderer/utils/buildSelectionAction';
import { buildSelectionInfo, SELECTION_DEBOUNCE_MS } from '@renderer/utils/codemirrorSelectionInfo';
import { sortItemsAsTree } from '@renderer/utils/fileTreeBuilder';
import { displayMemberName } from '@renderer/utils/memberHelpers';
import { buildReviewDecisionScopeToken } from '@renderer/utils/reviewDecisionScope';
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import {
  buildTaskChangeSignature,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { classifyTaskChangeReviewability } from '@shared/utils/taskChangeReviewability';
import { threeWayTextMerge } from '@shared/utils/threeWayTextMerge';
import { AlertTriangle, ChevronDown, Clock, FileSearch, Info, X } from 'lucide-react';

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
import {
  appendOrderedReviewAction,
  getReviewCloseBlockReason,
  getReviewDecisionHydrationGuard,
  getReviewRenameRecoveryExpectation,
  hasReviewFileRejections,
  hasUnresolvedReviewExternalChange,
  isReviewActionLocked,
  isReviewFileFullyRejected,
  popOrderedReviewAction,
  reconcileReviewDecisionRecordsAfterApply,
  resolveReviewFileIsNew,
  restoreReviewDecisionRecordsForFile,
  restoreReviewDecisionRecordsForFiles,
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
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { ReviewDecisionRecords } from './reviewActionState';
import type { EditorView } from '@codemirror/view';
import type {
  ReviewDraftHistoryEntry,
  ReviewSerializedEditorState,
} from '@features/change-review-history/contracts';
import type {
  FileChangeSummary,
  HunkDecision,
  ReviewFileScope,
  ReviewRenameRecoveryExpectation,
  TaskChangeSetV2,
} from '@shared/types';
import type { EditorSelectionAction, EditorSelectionInfo } from '@shared/types/editor';

interface RecentHunkUndoAction {
  filePath: string;
  originalIndex: number;
}

interface ReviewDiskUndoSnapshot {
  filePath: string;
  beforeContent: string;
  afterContent: string | null;
  changeSetEpoch: number;
  file?: FileChangeSummary;
  fileIndex?: number;
  restoreConflict?: string;
  restoreMode?:
    | 'content'
    | 'create-file'
    | 'delete-file'
    | 'restore-rejected-rename'
    | 'reapply-rejected-rename';
  renameExpectation?: ReviewRenameRecoveryExpectation;
}

interface RecentDiskUndoAction {
  snapshot: ReviewDiskUndoSnapshot;
  originalIndex?: number;
  file?: FileChangeSummary;
  decisionSnapshot?: ReviewDecisionRecords;
}

interface RecentReviewWrite {
  at: number;
  expectedContent: string | null;
}

interface DraftHistoryHydrationState {
  key: string | null;
  status: 'idle' | 'loading' | 'loaded' | 'error';
}

interface PendingDraftHistoryWrite {
  hydrationKey: string;
  teamName: string;
  scopeKey: string;
  scopeToken: string;
  entry: Omit<ReviewDraftHistoryEntry, 'updatedAt'>;
}

type ReviewUndoAction =
  | { kind: 'bulk' }
  | { kind: 'disk'; action: RecentDiskUndoAction }
  | { kind: 'hunk'; action: RecentHunkUndoAction };

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
}

function isTaskChangeSetV2(cs: { teamName: string }): cs is TaskChangeSetV2 {
  return 'scope' in cs;
}

const TaskChangesEmptyState = ({
  changeSet,
}: {
  changeSet: TaskChangeSetV2 | null;
}): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const status = changeSet ? classifyTaskChangeReviewability(changeSet) : null;
  const diagnosticMessages =
    status && status.diagnostics.length > 0
      ? status.diagnostics.map((diagnostic) => diagnostic.message)
      : (changeSet?.warnings ?? []);
  const uniqueMessages = [
    ...new Set(diagnosticMessages.filter((message) => message.trim().length > 0)),
  ];
  const isAttention = status?.reviewability === 'attention_required';
  const isDiagnosticOnly = status?.reviewability === 'diagnostic_only';
  const isNoSafeDiff = isAttention || isDiagnosticOnly;
  const hasDiagnosticContext = uniqueMessages.length > 0;
  const Icon = isAttention ? AlertTriangle : hasDiagnosticContext ? Info : FileSearch;
  const title = isDiagnosticOnly
    ? t('review.empty.noSafeDiff')
    : isAttention
      ? t('review.continuousScroll.empty')
      : t('review.empty.noFileChangesRecorded');
  const description = isNoSafeDiff
    ? isDiagnosticOnly
      ? t('review.empty.noSafeDiffDescription')
      : t('review.empty.noSafeDiffDiagnosticsDescription')
    : hasDiagnosticContext
      ? t('review.empty.noFileEventsYet')
      : t('review.empty.noFileEvents');

  return (
    <div className="flex w-full items-center justify-center px-6">
      <div className="max-w-xl rounded-lg border border-border bg-surface-sidebar px-5 py-4 text-center">
        <Icon
          className={cn('mx-auto mb-2 size-5', isAttention ? 'text-amber-300' : 'text-text-muted')}
        />
        <div className="text-sm font-medium text-text">{title}</div>
        <p className="mt-1 text-xs leading-5 text-text-muted">{description}</p>
        {uniqueMessages.length > 0 && (
          <div
            className={cn(
              'mt-3 space-y-1 rounded border px-3 py-2 text-left text-xs',
              isAttention
                ? 'border-amber-500/20 bg-amber-500/10 text-amber-200'
                : 'border-border bg-surface-raised text-text-muted'
            )}
          >
            {uniqueMessages.map((message, index) => (
              <div key={`${message}:${index}`}>{message}</div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
};

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
}: ChangeReviewDialogProps): React.ReactElement | null => {
  const { t } = useAppTranslation('team');
  const {
    activeChangeSet,
    changeSetLoading,
    changeSetError,
    fetchAgentChanges,
    fetchTaskChanges,
    clearChangeReviewCache,
    hunkDecisions,
    fileDecisions,
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
    loadDecisionsFromDisk,
    persistDecisions,
    flushDecisionsToDisk,
    clearDecisionsFromDisk,
    resetAllReviewState,
    fileChunkCounts,
    pushReviewUndoSnapshot,
    undoBulkReview,
    hunkContextHashesByFile,
    changeSetEpoch,
    decisionHydrationScopeKey,
    decisionHydrationStatus,
    globalTasks,
  } = useStore();

  // Build scope keys (pure values - safe to compute before hooks that depend on them)
  const scopeKey = mode === 'task' ? `task:${taskId ?? ''}` : `agent:${memberName ?? ''}`;
  // Filesystem-safe: use `-` instead of `:` for decision persistence key
  const decisionScopeKey = mode === 'task' ? `task-${taskId ?? ''}` : `agent-${memberName ?? ''}`;
  const decisionScopeToken = useMemo(() => {
    if (!activeChangeSet) return null;
    if (mode === 'task') {
      if (!('taskId' in activeChangeSet) || activeChangeSet.taskId !== taskId) {
        return null;
      }
    } else if (!('memberName' in activeChangeSet) || activeChangeSet.memberName !== memberName) {
      return null;
    }

    return buildReviewDecisionScopeToken({
      mode,
      taskId,
      memberName,
      requestSignature:
        mode === 'task' ? buildTaskChangeSignature(taskChangeRequestOptions ?? {}) : undefined,
      changeSet: activeChangeSet,
    });
  }, [activeChangeSet, memberName, mode, taskChangeRequestOptions, taskId]);
  const [draftHistoryEntries, setDraftHistoryEntries] = useState<
    Record<string, ReviewDraftHistoryEntry>
  >({});
  const [draftHistoryHydration, setDraftHistoryHydration] = useState<DraftHistoryHydrationState>({
    key: null,
    status: 'idle',
  });
  const [draftHistoryRetryNonce, setDraftHistoryRetryNonce] = useState(0);
  const decisionHydrationKey = decisionScopeToken
    ? `${teamName}:${decisionScopeKey}:${decisionScopeToken}`
    : null;
  const decisionHydrationGuard = getReviewDecisionHydrationGuard({
    expectedScopeKey: decisionHydrationKey,
    hydratedScopeKey: decisionHydrationScopeKey,
    status: decisionHydrationStatus,
  });
  const decisionHydrationReady = decisionHydrationGuard === 'ready';
  const decisionHydrationFailed = decisionHydrationGuard === 'error';
  const decisionHydrationPending = decisionHydrationGuard === 'pending';
  const draftHistoryHydrationReady =
    decisionHydrationKey === null ||
    (draftHistoryHydration.key === decisionHydrationKey &&
      draftHistoryHydration.status === 'loaded');
  const draftHistoryHydrationPending =
    decisionHydrationKey !== null &&
    (draftHistoryHydration.key !== decisionHydrationKey ||
      draftHistoryHydration.status === 'idle' ||
      draftHistoryHydration.status === 'loading');
  const draftHistoryHydrationFailed =
    decisionHydrationKey !== null &&
    draftHistoryHydration.key === decisionHydrationKey &&
    draftHistoryHydration.status === 'error';

  // Active file from scroll-spy (replaces selectedReviewFilePath for continuous scroll)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
  const [filesApplying, setFilesApplying] = useState<Set<string>>(() => new Set());
  const [undoing, setUndoing] = useState(false);
  const [reviewUndoDepth, setReviewUndoDepth] = useState(0);
  const [closing, setClosing] = useState(false);
  const reviewScope = useMemo<ReviewFileScope>(
    () => ({ teamName, taskId, memberName }),
    [memberName, taskId, teamName]
  );
  const collapseStorageKey = useMemo(
    () => `review:collapsed:${teamName}:${decisionScopeKey}`,
    [teamName, decisionScopeKey]
  );
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
  // Last focused CM editor - for Cmd+Z outside editor
  const lastFocusedEditorRef = useRef<EditorView | null>(null);
  // Ordered review action history. This is the source of truth for Ctrl/Cmd+Z routing.
  // Per-kind stacks below retain the actual recovery payloads.
  const reviewUndoActionsRef = useRef<ReviewUndoAction[]>([]);
  const reviewRedoBlockedRef = useRef(false);
  const hunkDecisionUndoStackRef = useRef<Record<string, number[]>>({});
  const recentHunkUndoActionsRef = useRef<RecentHunkUndoAction[]>([]);
  const fileApplyInFlightRef = useRef(new Set<string>());
  const undoInFlightRef = useRef(false);
  const closingRef = useRef(false);
  const recentDiskUndoActionsRef = useRef<RecentDiskUndoAction[]>([]);
  const bulkDiskUndoStackRef = useRef<ReviewDiskUndoSnapshot[][]>([]);
  const recentReviewWritesRef = useRef(new Map<string, RecentReviewWrite>());
  // Exact disk state on which each manual draft started. Map.has() distinguishes
  // a genuinely missing file (null baseline) from an uncaptured baseline.
  const draftDiskBaselineRef = useRef(new Map<string, string | null>());
  const draftHistoryEntriesRef = useRef<Record<string, ReviewDraftHistoryEntry>>({});
  const draftHistoryWriteChainsRef = useRef(new Map<string, Promise<void>>());
  const pendingDraftHistoryWritesRef = useRef(new Map<string, PendingDraftHistoryWrite>());
  const draftHistoryWriteErrorsRef = useRef(new Map<string, unknown>());
  const expectedDraftHistoryKeyRef = useRef<string | null>(null);
  const suppressedDraftHistoryFilesRef = useRef(new Set<string>());

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

  useEffect(() => {
    expectedDraftHistoryKeyRef.current = decisionHydrationKey;
  }, [decisionHydrationKey]);

  const startDraftHistoryDrain = useCallback((writeKey: string): Promise<void> => {
    const active = draftHistoryWriteChainsRef.current.get(writeKey);
    if (active) return active;

    let failedRevision: number | null = null;
    const drain = (async () => {
      while (true) {
        const pending = pendingDraftHistoryWritesRef.current.get(writeKey);
        if (!pending) return;
        pendingDraftHistoryWritesRef.current.delete(writeKey);
        try {
          const saved = await api.review.saveDraftHistoryEntry(
            pending.teamName,
            pending.scopeKey,
            pending.scopeToken,
            pending.entry
          );
          draftHistoryWriteErrorsRef.current.delete(writeKey);
          const current = draftHistoryEntriesRef.current[pending.entry.filePath];
          if (
            expectedDraftHistoryKeyRef.current === pending.hydrationKey &&
            current?.revision === saved.revision
          ) {
            const updatedEntries = {
              ...draftHistoryEntriesRef.current,
              [pending.entry.filePath]: saved,
            };
            draftHistoryEntriesRef.current = updatedEntries;
            setDraftHistoryEntries(updatedEntries);
          }
        } catch (error) {
          failedRevision = pending.entry.revision;
          if (!pendingDraftHistoryWritesRef.current.has(writeKey)) {
            pendingDraftHistoryWritesRef.current.set(writeKey, pending);
          }
          draftHistoryWriteErrorsRef.current.set(writeKey, error);
          if (expectedDraftHistoryKeyRef.current === pending.hydrationKey) {
            useStore.setState({
              applyError: 'Unable to save manual edit history. Retry Save or keep Changes open.',
            });
          }
          throw error;
        }
      }
    })();
    draftHistoryWriteChainsRef.current.set(writeKey, drain);
    void drain
      .catch(() => undefined)
      .finally(() => {
        if (draftHistoryWriteChainsRef.current.get(writeKey) === drain) {
          draftHistoryWriteChainsRef.current.delete(writeKey);
        }
        const pending = pendingDraftHistoryWritesRef.current.get(writeKey);
        if (pending && failedRevision !== null && pending.entry.revision > failedRevision) {
          void startDraftHistoryDrain(writeKey);
        }
      });
    return drain;
  }, []);

  const enqueueDraftHistoryWrite = useCallback(
    (entry: Omit<ReviewDraftHistoryEntry, 'updatedAt'>): void => {
      if (!decisionHydrationKey || !decisionScopeToken) return;
      const writeKey = `${decisionHydrationKey}\0${entry.filePath}`;
      pendingDraftHistoryWritesRef.current.set(writeKey, {
        hydrationKey: decisionHydrationKey,
        teamName,
        scopeKey: decisionScopeKey,
        scopeToken: decisionScopeToken,
        entry,
      });
      void startDraftHistoryDrain(writeKey);
    },
    [decisionHydrationKey, decisionScopeKey, decisionScopeToken, startDraftHistoryDrain, teamName]
  );

  const flushDraftHistoryWrites = useCallback(async (): Promise<boolean> => {
    if (!decisionHydrationKey) return true;
    const prefix = `${decisionHydrationKey}\0`;
    const pendingKeys = [...pendingDraftHistoryWritesRef.current.keys()].filter((key) =>
      key.startsWith(prefix)
    );
    for (const key of pendingKeys) void startDraftHistoryDrain(key);

    while (true) {
      const writes = [...draftHistoryWriteChainsRef.current.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([, write]) => write);
      if (writes.length === 0) break;
      await Promise.allSettled(writes);
    }
    const hasPending = [...pendingDraftHistoryWritesRef.current.keys()].some((key) =>
      key.startsWith(prefix)
    );
    const hasErrors = [...draftHistoryWriteErrorsRef.current.keys()].some((key) =>
      key.startsWith(prefix)
    );
    return !hasPending && !hasErrors;
  }, [decisionHydrationKey, startDraftHistoryDrain]);

  const clearDraftHistoryForFile = useCallback(
    (filePath: string): Promise<void> => {
      const normalizedPath = normalizePathForComparison(filePath);
      suppressedDraftHistoryFilesRef.current.add(normalizedPath);
      const entries = { ...draftHistoryEntriesRef.current };
      delete entries[filePath];
      draftHistoryEntriesRef.current = entries;
      setDraftHistoryEntries(entries);
      if (!decisionHydrationKey || !decisionScopeToken) return Promise.resolve();

      const writeKey = `${decisionHydrationKey}\0${filePath}`;
      pendingDraftHistoryWritesRef.current.delete(writeKey);
      const previous = draftHistoryWriteChainsRef.current.get(writeKey) ?? Promise.resolve();
      const clear = previous
        .catch(() => undefined)
        .then(() =>
          api.review.clearDraftHistory(teamName, decisionScopeKey, decisionScopeToken, filePath)
        )
        .then(() => {
          draftHistoryWriteErrorsRef.current.delete(writeKey);
        });
      draftHistoryWriteChainsRef.current.set(writeKey, clear);
      void clear
        .catch((error) => {
          draftHistoryWriteErrorsRef.current.set(writeKey, error);
          if (expectedDraftHistoryKeyRef.current === decisionHydrationKey) {
            useStore.setState({
              applyError: `Unable to discard saved manual edit history: ${String(error)}`,
            });
          }
        })
        .finally(() => {
          if (draftHistoryWriteChainsRef.current.get(writeKey) === clear) {
            draftHistoryWriteChainsRef.current.delete(writeKey);
          }
          if (pendingDraftHistoryWritesRef.current.has(writeKey)) {
            void startDraftHistoryDrain(writeKey);
          }
        });
      return clear;
    },
    [decisionHydrationKey, decisionScopeKey, decisionScopeToken, startDraftHistoryDrain, teamName]
  );

  const publishDraftHistoryCheckpoint = useCallback(
    (
      filePath: string,
      editorState: ReviewSerializedEditorState,
      diskBaseline: string | null
    ): void => {
      if (!decisionHydrationKey || !draftHistoryHydrationReady) return;
      const current = draftHistoryEntriesRef.current[filePath];
      if (
        current?.diskBaseline === diskBaseline &&
        JSON.stringify(current.editorState) === JSON.stringify(editorState)
      ) {
        return;
      }
      const entry: ReviewDraftHistoryEntry = {
        filePath,
        codec: 'codemirror-history-v1',
        revision: (current?.revision ?? 0) + 1,
        diskBaseline,
        editorState,
        updatedAt: new Date().toISOString(),
      };
      const entries = { ...draftHistoryEntriesRef.current, [filePath]: entry };
      draftHistoryEntriesRef.current = entries;
      setDraftHistoryEntries(entries);
      enqueueDraftHistoryWrite(entry);
    },
    [decisionHydrationKey, draftHistoryHydrationReady, enqueueDraftHistoryWrite]
  );

  const handleSerializedStateChanged = useCallback(
    (filePath: string, editorState: ReviewSerializedEditorState): void => {
      const baselineKey = normalizePathForComparison(filePath);
      if (suppressedDraftHistoryFilesRef.current.has(baselineKey)) return;
      const existing = draftHistoryEntriesRef.current[filePath];
      if (!draftDiskBaselineRef.current.has(baselineKey)) {
        if (!existing) return;
        draftDiskBaselineRef.current.set(baselineKey, existing.diskBaseline);
      }
      publishDraftHistoryCheckpoint(
        filePath,
        editorState,
        draftDiskBaselineRef.current.get(baselineKey) ?? null
      );
    },
    [publishDraftHistoryCheckpoint]
  );

  const handleSerializedStateRestoreError = useCallback(
    (filePath: string, error: unknown): void => {
      useStore.setState({
        applyError: `Saved manual edit history for ${filePath} is incompatible and was not applied: ${String(error)}`,
      });
    },
    []
  );

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
    recentDiskUndoActionsRef.current = [];
    bulkDiskUndoStackRef.current = [];
    recentHunkUndoActionsRef.current = [];
    hunkDecisionUndoStackRef.current = {};
    reviewUndoActionsRef.current = [];
    reviewRedoBlockedRef.current = false;
    lastFocusedEditorRef.current = null;
    recentReviewWritesRef.current.clear();
    draftDiskBaselineRef.current.clear();
    draftHistoryEntriesRef.current = {};
    setDraftHistoryEntries({});
    setDraftHistoryHydration({ key: null, status: 'idle' });
    undoInFlightRef.current = false;
    closingRef.current = false;
    setUndoing(false);
    setReviewUndoDepth(0);
    setClosing(false);
    setFilesApplying(new Set());
  }, [changeSetEpoch, scopeKey, teamName]);

  useEffect(() => {
    if (!open || !decisionHydrationKey || !decisionScopeToken || !activeChangeSet) {
      if (!decisionHydrationKey) {
        setDraftHistoryHydration({ key: null, status: 'idle' });
      }
      return;
    }
    let cancelled = false;
    const hydrationKey = decisionHydrationKey;
    setDraftHistoryHydration({ key: hydrationKey, status: 'loading' });

    void (async () => {
      try {
        const snapshot = await api.review.loadDraftHistory(
          teamName,
          decisionScopeKey,
          decisionScopeToken
        );
        if (cancelled || expectedDraftHistoryKeyRef.current !== hydrationKey) return;

        const allowedFiles = new Map(
          activeChangeSet.files.map((file) => [normalizePathForComparison(file.filePath), file])
        );
        const recoveredEntries: Record<string, ReviewDraftHistoryEntry> = {};
        const recoveredDrafts: Record<string, string> = {};
        const externalChanges: Record<string, { type: 'change' }> = {};

        for (const entry of Object.values(snapshot?.entries ?? {})) {
          const file = allowedFiles.get(normalizePathForComparison(entry.filePath));
          if (file?.filePath !== entry.filePath) continue;
          const baselineKey = normalizePathForComparison(file.filePath);
          const conflict = await api.review.checkConflict(
            reviewScope,
            file.filePath,
            entry.diskBaseline ?? ''
          );
          if (cancelled || expectedDraftHistoryKeyRef.current !== hydrationKey) return;
          const diskMatchesBaseline =
            entry.diskBaseline === null
              ? conflict.hasConflict && conflict.conflictContent === null
              : !conflict.hasConflict;

          recoveredEntries[file.filePath] = entry;
          draftDiskBaselineRef.current.set(baselineKey, entry.diskBaseline);
          if (!diskMatchesBaseline || entry.editorState.doc !== entry.diskBaseline) {
            recoveredDrafts[file.filePath] = entry.editorState.doc;
          }
          if (!diskMatchesBaseline) externalChanges[file.filePath] = { type: 'change' };
        }

        draftHistoryEntriesRef.current = recoveredEntries;
        setDraftHistoryEntries(recoveredEntries);
        useStore.setState((state) => ({
          editedContents: { ...state.editedContents, ...recoveredDrafts },
          reviewExternalChangesByFile: {
            ...state.reviewExternalChangesByFile,
            ...externalChanges,
          },
          applyError:
            Object.keys(externalChanges).length > 0
              ? 'Recovered manual edits are based on files that changed on disk. Review each conflict before saving.'
              : state.applyError,
        }));
        setDraftHistoryHydration({ key: hydrationKey, status: 'loaded' });
      } catch (error) {
        if (cancelled || expectedDraftHistoryKeyRef.current !== hydrationKey) return;
        setDraftHistoryHydration({ key: hydrationKey, status: 'error' });
        useStore.setState({
          applyError: `Unable to load saved manual edit history: ${String(error)}`,
        });
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [
    activeChangeSet,
    changeSetEpoch,
    decisionHydrationKey,
    decisionScopeKey,
    decisionScopeToken,
    open,
    reviewScope,
    teamName,
    draftHistoryRetryNonce,
  ]);

  const pushReviewUndoAction = useCallback((action: ReviewUndoAction): void => {
    const previous = reviewUndoActionsRef.current;
    const stack = appendOrderedReviewAction(previous, action);
    for (const dropped of previous) {
      if (stack.includes(dropped)) continue;
      if (dropped.kind === 'bulk') {
        bulkDiskUndoStackRef.current.shift();
      } else if (dropped.kind === 'disk') {
        const index = recentDiskUndoActionsRef.current.indexOf(dropped.action);
        if (index !== -1) recentDiskUndoActionsRef.current.splice(index, 1);
      } else {
        const index = recentHunkUndoActionsRef.current.indexOf(dropped.action);
        if (index !== -1) recentHunkUndoActionsRef.current.splice(index, 1);
        const fileStack = hunkDecisionUndoStackRef.current[dropped.action.filePath];
        const fileIndex = fileStack?.indexOf(dropped.action.originalIndex) ?? -1;
        if (fileStack && fileIndex !== -1) fileStack.splice(fileIndex, 1);
        if (fileStack?.length === 0) {
          delete hunkDecisionUndoStackRef.current[dropped.action.filePath];
        }
      }
    }
    reviewUndoActionsRef.current = stack;
    reviewRedoBlockedRef.current = false;
    setReviewUndoDepth(stack.length);
  }, []);

  const completeReviewUndoAction = useCallback((action: ReviewUndoAction): boolean => {
    const result = popOrderedReviewAction(reviewUndoActionsRef.current, action);
    if (!result.popped) return false;
    reviewUndoActionsRef.current = result.stack;
    reviewRedoBlockedRef.current = true;
    setReviewUndoDepth(result.stack.length);
    return true;
  }, []);

  const clearReviewActionHistory = useCallback((): void => {
    recentDiskUndoActionsRef.current = [];
    bulkDiskUndoStackRef.current = [];
    recentHunkUndoActionsRef.current = [];
    hunkDecisionUndoStackRef.current = {};
    reviewUndoActionsRef.current = [];
    reviewRedoBlockedRef.current = false;
    useStore.setState({ reviewUndoStack: [] });
    setReviewUndoDepth(0);
  }, []);

  const clearReviewActionHistoryForFile = useCallback(
    (filePath: string): void => {
      const actions = reviewUndoActionsRef.current;
      if (actions.some((action) => action.kind === 'bulk')) {
        // Bulk decision snapshots span files and cannot be safely split after the fact.
        clearReviewActionHistory();
        return;
      }
      const normalizedPath = normalizePathForComparison(filePath);
      const retained = actions.filter((action) => {
        const actionPath =
          action.kind === 'disk'
            ? action.action.snapshot.filePath
            : action.kind === 'hunk'
              ? action.action.filePath
              : null;
        return actionPath === null || normalizePathForComparison(actionPath) !== normalizedPath;
      });
      reviewUndoActionsRef.current = retained;
      recentDiskUndoActionsRef.current = retained.flatMap((action) =>
        action.kind === 'disk' ? [action.action] : []
      );
      recentHunkUndoActionsRef.current = retained.flatMap((action) =>
        action.kind === 'hunk' ? [action.action] : []
      );
      hunkDecisionUndoStackRef.current = {};
      for (const action of recentHunkUndoActionsRef.current) {
        const fileActions = hunkDecisionUndoStackRef.current[action.filePath] ?? [];
        fileActions.push(action.originalIndex);
        hunkDecisionUndoStackRef.current[action.filePath] = fileActions;
      }
      reviewRedoBlockedRef.current = false;
      setReviewUndoDepth(retained.length);
    },
    [clearReviewActionHistory]
  );

  const reviewMutationBusy = isReviewActionLocked({
    applying,
    fileApplyCount: filesApplying.size,
    undoing,
    closing,
  });
  const reviewActionsBusy =
    reviewMutationBusy ||
    (decisionHydrationKey !== null && (!decisionHydrationReady || !draftHistoryHydrationReady));

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
      isReviewActionLocked({
        applying: state.applying,
        fileApplyCount: fileApplyInFlightRef.current.size,
        undoing: undoInFlightRef.current,
        closing: closingRef.current,
      })
    );
  }, [decisionHydrationKey, draftHistoryHydration.key, draftHistoryHydration.status]);

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

  const dropHunkUndoMetadata = useCallback((filePath: string, originalIndex: number): void => {
    const stack = hunkDecisionUndoStackRef.current[filePath];
    const stackIndex = stack?.lastIndexOf(originalIndex) ?? -1;
    if (stack && stackIndex !== -1) stack.splice(stackIndex, 1);
    if (stack?.length === 0) delete hunkDecisionUndoStackRef.current[filePath];

    for (let index = recentHunkUndoActionsRef.current.length - 1; index >= 0; index--) {
      const action = recentHunkUndoActionsRef.current[index];
      if (action.filePath === filePath && action.originalIndex === originalIndex) {
        recentHunkUndoActionsRef.current.splice(index, 1);
        break;
      }
    }
  }, []);

  // One-shot scroll-to-file ref (for initialFilePath)
  const initialScrollDoneKeyRef = useRef<string | null>(null);

  // Continuous scroll navigation
  const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
    scrollContainerRef,
  });

  // Sort files to match the visual order of the file tree (directories first, then alphabetical)
  const sortedFiles = useMemo(
    () => sortItemsAsTree(activeChangeSet?.files ?? [], (f) => f.relativePath),
    [activeChangeSet]
  );
  // A content-derived key avoids tearing down/recreating the main-process watcher
  // when Zustand returns a new array containing the exact same review paths.
  const watchedReviewFilePathsKey = useMemo(
    () => sortedFiles.map((file) => file.filePath).join('\0'),
    [sortedFiles]
  );
  const watchedReviewFilePathsKeyRef = useRef(watchedReviewFilePathsKey);
  watchedReviewFilePathsKeyRef.current = watchedReviewFilePathsKey;
  const loadingFiles = useMemo(
    () => sortedFiles.filter((file) => fileContentsLoading[file.filePath]),
    [sortedFiles, fileContentsLoading]
  );
  const globalDiffLoadingState = useMemo(() => {
    if (loadingFiles.length === 0) return null;

    const preferredFile =
      (activeFilePath
        ? loadingFiles.find((file) => file.filePath === activeFilePath)
        : undefined) ?? loadingFiles[0];
    const snippetCount = loadingFiles.reduce(
      (sum, file) => sum + file.snippets.filter((snippet) => !snippet.isError).length,
      0
    );

    return {
      totalFilesCount: sortedFiles.length,
      readyFilesCount: sortedFiles.filter((file) => file.filePath in fileContents).length,
      loadingFilesCount: loadingFiles.length,
      snippetCount,
      activeFileName: preferredFile?.relativePath ?? preferredFile?.filePath,
    };
  }, [activeFilePath, loadingFiles, sortedFiles, fileContents]);

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
        const durableDraftHistory = draftHistoryEntriesRef.current[file.filePath];
        if (file.filePath in state.editedContents || durableDraftHistory) {
          if (!(file.filePath in state.editedContents) && durableDraftHistory) {
            state.updateEditedContent(file.filePath, durableDraftHistory.editorState.doc);
          }
          state.markReviewFileExternallyChanged(file.filePath, changeType);
          return;
        }
        clearReviewActionHistoryForFile(file.filePath);
        // External bytes invalidate both the diff snapshot and every decision keyed to it.
        state.clearReviewStateForFile(file.filePath);
        void state.fetchFileContent(teamName, memberName, file.filePath);
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
  }, [clearReviewActionHistoryForFile, open, projectPath, reviewScope, teamName, memberName]);

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

  // Accept/Reject all across all files
  const handleAcceptAll = useCallback(() => {
    if (!activeChangeSet || !canAcceptAll || hasReviewActionInFlight()) return;
    const currentDrafts = useStore.getState().editedContents;
    pushReviewUndoSnapshot();
    const acceptedFiles = new Set<string>();
    for (const file of activeChangeSet.files) {
      if (file.filePath in currentDrafts) continue;
      if (acceptAllFile(file.filePath)) acceptedFiles.add(file.filePath);
    }
    if (acceptedFiles.size === 0) {
      undoBulkReview();
      return;
    }
    bulkDiskUndoStackRef.current.push([]);
    pushReviewUndoAction({ kind: 'bulk' });
    requestAnimationFrame(() => {
      for (const [filePath, view] of editorViewMapRef.current.entries()) {
        if (!acceptedFiles.has(filePath)) continue;
        acceptAllChunks(view);
      }
    });
  }, [
    activeChangeSet,
    acceptAllFile,
    canAcceptAll,
    hasReviewActionInFlight,
    pushReviewUndoAction,
    pushReviewUndoSnapshot,
    undoBulkReview,
  ]);

  const handleRejectAll = useCallback(() => {
    if (!activeChangeSet || hasReviewActionInFlight()) return;
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
    pushReviewUndoSnapshot();
    const diskUndoSnapshots: ReviewDiskUndoSnapshot[] = [];
    bulkDiskUndoStackRef.current.push(diskUndoSnapshots);
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
          changeSetEpoch,
          file,
          restoreMode: shouldDeleteOnUndo ? 'delete-file' : undefined,
          renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
          fileIndex: isNewFile
            ? activeChangeSet.files.findIndex((candidate) => candidate.filePath === file.filePath)
            : undefined,
        });
      }
      fileApplyInFlightRef.current.add(file.filePath);
      rejectAllFile(file.filePath);
    }
    setFilesApplying(new Set(rejectableFilePaths));
    requestAnimationFrame(() => {
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
          for (const snapshot of diskUndoSnapshots) {
            markRecentReviewWrite(
              snapshot.filePath,
              isLedgerRenameReviewFile(snapshot.file) ? null : snapshot.afterContent
            );
          }
          const result = await applyReview(teamName, taskId, memberName);
          if (useStore.getState().changeSetEpoch !== changeSetEpoch) return;
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
            bulkDiskUndoStackRef.current.pop();
            undoBulkReview();
            return;
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

          if (useStore.getState().changeSetEpoch !== changeSetEpoch) return;
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
          pushReviewUndoAction({ kind: 'bulk' });
        } finally {
          for (const file of requestedFiles) {
            fileApplyInFlightRef.current.delete(file.filePath);
          }
          if (useStore.getState().changeSetEpoch === changeSetEpoch) {
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
      pushReviewUndoAction({ kind: 'bulk' });
    }
  }, [
    activeChangeSet,
    rejectablePendingFiles,
    rejectAllFile,
    pushReviewUndoSnapshot,
    applyReview,
    teamName,
    taskId,
    memberName,
    fileContents,
    changeSetEpoch,
    readCurrentReviewDiskContent,
    fetchFileContent,
    hasReviewActionInFlight,
    markRecentReviewWrite,
    rollbackEditorContent,
    pushReviewUndoAction,
    setUndoInFlight,
    undoBulkReview,
  ]);

  // File-level accept/reject (Cursor-style)
  const handleRestoreRejectedFileAsAccepted = useCallback(
    async (filePath: string): Promise<void> => {
      if (hasReviewDraft(filePath) || hasReviewActionInFlight()) return;
      const operationEpoch = changeSetEpoch;
      const file = activeChangeSet?.files.find((candidate) => candidate.filePath === filePath);
      if (!file) return;
      const content = fileContents[filePath] ?? null;
      const isExpectedDeletion = isReviewFileExpectedDeleted(file);
      const normalizedFilePath = normalizePathForComparison(filePath);
      const latestDiskSnapshot = [...recentDiskUndoActionsRef.current]
        .reverse()
        .find(
          (action) => normalizePathForComparison(action.snapshot.filePath) === normalizedFilePath
        )?.snapshot;
      const sessionSnapshot =
        [...recentDiskUndoActionsRef.current]
          .reverse()
          .find(
            (action) =>
              action.originalIndex === undefined &&
              normalizePathForComparison(action.snapshot.filePath) === normalizedFilePath
          )?.snapshot ??
        [...bulkDiskUndoStackRef.current]
          .reverse()
          .flatMap((snapshots) => snapshots)
          .find((snapshot) => normalizePathForComparison(snapshot.filePath) === normalizedFilePath);
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
        let rejectedDiskContent =
          sessionSnapshot?.afterContent ?? content?.originalFullContent ?? '';
        let restoredDiskContent: string | null = desiredContent;
        let restoreMode: ReviewDiskUndoSnapshot['restoreMode'] = 'content';
        let rollbackRestoredDisk: (() => Promise<unknown>) | null = null;
        let renameExpectation: ReviewRenameRecoveryExpectation | null = null;

        if (isLedgerRenameReviewFile(file)) {
          renameExpectation =
            sessionSnapshot?.renameExpectation ?? getReviewRenameRecoveryExpectation(file);
          if (!renameExpectation) {
            throw new Error('Rename recovery metadata is unavailable; refusing an unsafe restore.');
          }
          await api.review.restoreRejectedRename(reviewScope, filePath, renameExpectation);
          restoreMode = 'reapply-rejected-rename';
          rollbackRestoredDisk = () =>
            api.review.reapplyRejectedRename(reviewScope, filePath, renameExpectation!);
        } else if (isExpectedDeletion) {
          const expectedRejectedContent =
            latestDiskSnapshot?.afterContent ??
            sessionSnapshot?.afterContent ??
            content?.originalFullContent;
          if (expectedRejectedContent === null || expectedRejectedContent === undefined) {
            throw new Error('Deleted file baseline is unavailable; refusing an unsafe restore.');
          }
          await api.review.deleteEditedFile(reviewScope, filePath, expectedRejectedContent);
          rejectedDiskContent = expectedRejectedContent;
          restoredDiskContent = null;
          restoreMode = 'create-file';
          rollbackRestoredDisk = () =>
            api.review.saveEditedFile(reviewScope, filePath, expectedRejectedContent, null);
        } else if (resolveReviewFileIsNew(file, content)) {
          const current = await api.review.checkConflict(reviewScope, filePath, '');
          const isMissing = current.hasConflict && current.conflictContent === null;
          if (isMissing) {
            await api.review.saveEditedFile(reviewScope, filePath, desiredContent, null);
            rejectedDiskContent = '';
            restoreMode = 'delete-file';
            rollbackRestoredDisk = () =>
              api.review.deleteEditedFile(reviewScope, filePath, desiredContent);
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
            await api.review.saveEditedFile(
              reviewScope,
              filePath,
              desiredContent,
              current.currentContent
            );
            rollbackRestoredDisk = () =>
              api.review.saveEditedFile(reviewScope, filePath, rejectedDiskContent, desiredContent);
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
          await api.review.saveEditedFile(
            reviewScope,
            filePath,
            restoredDiskContent,
            current.currentContent
          );
          rollbackRestoredDisk = () =>
            api.review.saveEditedFile(
              reviewScope,
              filePath,
              rejectedDiskContent,
              restoredDiskContent
            );
        }

        if (useStore.getState().changeSetEpoch !== operationEpoch) return;
        restoreFileDecisions(file, { hunkDecisions: {}, fileDecisions: {} });
        if (!acceptAllFile(filePath)) {
          restoreFileDecisions(file, decisionSnapshot);
          try {
            await rollbackRestoredDisk?.();
          } catch (rollbackError) {
            const detail =
              rollbackError instanceof Error ? rollbackError.message : 'unknown rollback error';
            throw new Error(
              `Review state changed while restoring the file, and disk rollback failed: ${detail}`
            );
          }
          throw new Error('Review state changed while restoring the file; disk was rolled back.');
        }

        const snapshot: ReviewDiskUndoSnapshot = {
          filePath,
          beforeContent: rejectedDiskContent,
          afterContent: restoredDiskContent,
          changeSetEpoch: operationEpoch,
          file,
          restoreMode,
          renameExpectation: renameExpectation ?? undefined,
        };
        const undoAction: RecentDiskUndoAction = {
          snapshot,
          file,
          decisionSnapshot,
        };
        recentDiskUndoActionsRef.current.push(undoAction);
        pushReviewUndoAction({ kind: 'disk', action: undoAction });
        markRecentReviewWrite(filePath, restoredDiskContent);
        clearReviewFileExternalChange(filePath);
        useStore.getState().invalidateResolvedFileContent(filePath);
        setDiscardCounters((previous) => ({
          ...previous,
          [filePath]: (previous[filePath] ?? 0) + 1,
        }));
        void fetchFileContent(teamName, memberName, filePath);
      } catch (error) {
        if (useStore.getState().changeSetEpoch === operationEpoch) {
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
        fileApplyInFlightRef.current.delete(filePath);
        if (useStore.getState().changeSetEpoch === operationEpoch) {
          setFileApplying(filePath, false);
        }
      }
    },
    [
      acceptAllFile,
      activeChangeSet,
      changeSetEpoch,
      clearReviewFileExternalChange,
      fetchFileContent,
      fileContents,
      hasReviewActionInFlight,
      hasReviewDraft,
      markRecentReviewWrite,
      memberName,
      pushReviewUndoAction,
      restoreFileDecisions,
      reviewExternalChangesByFile,
      reviewScope,
      setFileApplying,
      teamName,
    ]
  );

  const handleAcceptFile = useCallback(
    (filePath: string) => {
      if (hasReviewDraft(filePath) || hasReviewActionInFlight()) return;
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
      pushReviewUndoSnapshot();
      if (!acceptAllFile(filePath)) {
        undoBulkReview();
        return;
      }
      bulkDiskUndoStackRef.current.push([]);
      pushReviewUndoAction({ kind: 'bulk' });
      const view = editorViewMapRef.current.get(filePath);
      if (view) {
        requestAnimationFrame(() => acceptAllChunks(view));
      }
    },
    [
      acceptAllFile,
      activeChangeSet,
      hasReviewActionInFlight,
      hasReviewDraft,
      handleRestoreRejectedFileAsAccepted,
      pushReviewUndoAction,
      pushReviewUndoSnapshot,
      undoBulkReview,
    ]
  );

  const handleRejectFile = useCallback(
    async (filePath: string) => {
      if (hasReviewDraft(filePath) || hasReviewActionInFlight()) return;
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      const operationEpoch = changeSetEpoch;
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

        // Mark rejected in store + update CM view immediately for feedback
        rejectAllFile(filePath);
        if (view) {
          rejectAllChunks(view);
        }

        if (REVIEW_INSTANT_APPLY) {
          // Reject a whole file should apply immediately (restore original on disk),
          // and NEW-file reject should delete it.
          markRecentReviewWrite(
            filePath,
            isNew || isLedgerRenameReviewFile(file) ? null : afterContent
          );
          const result = await applySingleFileDecision(teamName, filePath, taskId, memberName);
          if (useStore.getState().changeSetEpoch !== operationEpoch) return;

          if (isNew) {
            const hasErrorForFile =
              !result ||
              result.errors.some(
                (error) =>
                  normalizePathForComparison(error.filePath) ===
                  normalizePathForComparison(filePath)
              );
            if (!hasErrorForFile) {
              const restoreContent =
                beforeContent ??
                getResolvedReviewModifiedContent(file, fileContents[filePath] ?? null) ??
                '';
              const index = activeChangeSet?.files.findIndex((f) => f.filePath === filePath) ?? 0;
              const snapshot: ReviewDiskUndoSnapshot = {
                filePath,
                beforeContent: restoreContent,
                afterContent: null,
                fileIndex: Math.max(0, index),
                file,
                changeSetEpoch: operationEpoch,
              };
              const undoAction: RecentDiskUndoAction = {
                snapshot,
                file,
                decisionSnapshot,
              };
              recentDiskUndoActionsRef.current.push(undoAction);
              pushReviewUndoAction({ kind: 'disk', action: undoAction });
              markRecentReviewWrite(filePath, null);
              useStore.getState().invalidateResolvedFileContent(filePath);
              void fetchFileContent(teamName, memberName, filePath);
            } else {
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
                const snapshot: ReviewDiskUndoSnapshot = {
                  filePath,
                  beforeContent,
                  afterContent,
                  changeSetEpoch: operationEpoch,
                  file,
                  restoreMode: shouldDeleteOnUndo ? 'delete-file' : undefined,
                  renameExpectation: getReviewRenameRecoveryExpectation(file) ?? undefined,
                };
                if (snapshot.restoreMode !== 'delete-file' && !isLedgerRenameReviewFile(file)) {
                  alignDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
                }
                const undoAction: RecentDiskUndoAction = {
                  snapshot,
                  file,
                  decisionSnapshot,
                };
                recentDiskUndoActionsRef.current.push(undoAction);
                pushReviewUndoAction({ kind: 'disk', action: undoAction });
              }
              markRecentReviewWrite(filePath, isLedgerRenameReviewFile(file) ? null : afterContent);
            } else {
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
        fileApplyInFlightRef.current.delete(filePath);
        if (useStore.getState().changeSetEpoch === operationEpoch) {
          setFileApplying(filePath, false);
        }
      }
    },
    [
      rejectAllFile,
      activeChangeSet,
      applySingleFileDecision,
      teamName,
      taskId,
      memberName,
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
      pushReviewUndoAction,
    ]
  );

  // Per-file callbacks for ContinuousScrollView
  const handleHunkAccepted = useCallback(
    (filePath: string, hunkIndex: number) => {
      if (hasReviewDraft(filePath) || hasReviewActionInFlight()) {
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
      if (!hunkDecisionUndoStackRef.current[filePath]) {
        hunkDecisionUndoStackRef.current[filePath] = [];
      }
      hunkDecisionUndoStackRef.current[filePath].push(originalIndex);
      const undoAction: RecentHunkUndoAction = { filePath, originalIndex };
      recentHunkUndoActionsRef.current.push(undoAction);
      pushReviewUndoAction({ kind: 'hunk', action: undoAction });
      return true;
    },
    [
      hasReviewActionInFlight,
      hasReviewDraft,
      pushReviewUndoAction,
      rollbackEditorContent,
      setHunkDecision,
    ]
  );

  const handleHunkRejected = useCallback(
    (filePath: string, hunkIndex: number, beforeContent?: string, afterContent?: string) => {
      if (hasReviewDraft(filePath) || hasReviewActionInFlight()) {
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
      if (!hunkDecisionUndoStackRef.current[filePath]) {
        hunkDecisionUndoStackRef.current[filePath] = [];
      }
      hunkDecisionUndoStackRef.current[filePath].push(originalIndex);
      const hunkUndoAction: RecentHunkUndoAction = { filePath, originalIndex };
      recentHunkUndoActionsRef.current.push(hunkUndoAction);
      if (REVIEW_INSTANT_APPLY) {
        markRecentReviewWrite(filePath, isNewFileFullyRejected ? null : afterContent);
        void (async () => {
          try {
            const result = await applySingleFileDecision(teamName, filePath, taskId, memberName);
            if (useStore.getState().changeSetEpoch !== operationEpoch) return;
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
              const snapshot: ReviewDiskUndoSnapshot = {
                filePath,
                beforeContent,
                afterContent: isNewFileFullyRejected ? null : afterContent,
                changeSetEpoch: operationEpoch,
                file,
              };
              snapshot.restoreMode = isNewFileFullyRejected
                ? 'create-file'
                : shouldDeleteOnUndo
                  ? 'delete-file'
                  : undefined;
              snapshot.renameExpectation =
                getReviewRenameRecoveryExpectation(snapshot.file) ?? undefined;
              if (
                actualAfterContent !== null &&
                snapshot.restoreMode !== 'delete-file' &&
                !isLedgerRenameReviewFile(snapshot.file)
              ) {
                alignDiskUndoSnapshotWithAppliedContent(snapshot, actualAfterContent);
              }
              const diskUndoAction: RecentDiskUndoAction = {
                snapshot,
                originalIndex,
              };
              recentDiskUndoActionsRef.current.push(diskUndoAction);
              pushReviewUndoAction({ kind: 'disk', action: diskUndoAction });
              markRecentReviewWrite(filePath, snapshot.afterContent);
              return;
            }

            const view = editorViewMapRef.current.get(filePath);
            if (view?.dom.isConnected) rollbackEditorContent(filePath, beforeContent);
            clearHunkDecisionByOriginalIndex(filePath, originalIndex);
            dropHunkUndoMetadata(filePath, originalIndex);
            useStore.getState().invalidateResolvedFileContent(filePath);
            setDiscardCounters((previous) => ({
              ...previous,
              [filePath]: (previous[filePath] ?? 0) + 1,
            }));
            void fetchFileContent(teamName, memberName, filePath);
          } finally {
            fileApplyInFlightRef.current.delete(filePath);
            if (useStore.getState().changeSetEpoch === operationEpoch) {
              setFileApplying(filePath, false);
            }
          }
        })();
      } else {
        fileApplyInFlightRef.current.delete(filePath);
        setFileApplying(filePath, false);
        pushReviewUndoAction({ kind: 'hunk', action: hunkUndoAction });
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
      teamName,
      taskId,
      memberName,
      markRecentReviewWrite,
      fetchFileContent,
      setFileApplying,
      readCurrentReviewDiskContent,
      dropHunkUndoMetadata,
      rollbackEditorContent,
      activeChangeSet,
      fileContents,
      pushReviewUndoAction,
    ]
  );

  const handleContentChanged = useCallback(
    (filePath: string, content: string, previousContent?: string) => {
      reviewRedoBlockedRef.current = false;
      const baselineKey = normalizePathForComparison(filePath);
      suppressedDraftHistoryFilesRef.current.delete(baselineKey);
      if (!draftDiskBaselineRef.current.has(baselineKey)) {
        const fileContent = fileContents[filePath] ?? null;
        if (isReviewFileMissingOnDisk(fileContent)) {
          draftDiskBaselineRef.current.set(baselineKey, null);
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
          if (baseline != null) draftDiskBaselineRef.current.set(baselineKey, baseline);
        }
      }
      const diskBaseline = draftDiskBaselineRef.current.get(baselineKey);
      if (diskBaseline !== null && diskBaseline !== undefined && content === diskBaseline) {
        discardFileEdits(filePath);
      } else {
        updateEditedContent(filePath, content);
      }
    },
    [activeChangeSet, discardFileEdits, fileContents, updateEditedContent]
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
      if (!draftDiskBaselineRef.current.has(baselineKey)) {
        useStore.setState({
          applyError: 'The draft disk baseline is unavailable. Reload the file before saving.',
        });
        return;
      }
      const expectedCurrentContent = draftDiskBaselineRef.current.get(baselineKey) ?? null;
      const contentToSave = initialState.editedContents[filePath];
      if (contentToSave === undefined) return;
      const operationEpoch = initialState.changeSetEpoch;
      markRecentReviewWrite(filePath, contentToSave);
      await saveEditedFile(filePath, reviewScope, expectedCurrentContent);
      const state = useStore.getState();
      if (state.changeSetEpoch === operationEpoch && !state.applyError) {
        // Keep the exact saved baseline even when the buffer is clean. Native history is
        // still valuable: Undo after Save (or restart) should produce a dirty draft.
        draftDiskBaselineRef.current.set(baselineKey, contentToSave);
        const serializedState = draftHistoryEntriesRef.current[filePath]?.editorState;
        if (serializedState) {
          publishDraftHistoryCheckpoint(filePath, serializedState, contentToSave);
          if (!(await flushDraftHistoryWrites())) {
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
      clearReviewActionHistoryForFile,
      hasReviewActionInFlight,
      saveEditedFile,
      reviewScope,
      markRecentReviewWrite,
      publishDraftHistoryCheckpoint,
      flushDraftHistoryWrites,
    ]
  );

  const handleRestoreMissingFile = useCallback(
    (filePath: string, content: string) => {
      if (hasReviewActionInFlight()) return;
      const operationEpoch = useStore.getState().changeSetEpoch;
      const baselineKey = normalizePathForComparison(filePath);
      draftDiskBaselineRef.current.set(baselineKey, null);
      markRecentReviewWrite(filePath, content);
      updateEditedContent(filePath, content);
      // Ensure editedContents is set before saveEditedFile reads it.
      void Promise.resolve().then(async () => {
        await saveEditedFile(filePath, reviewScope, null);
        const state = useStore.getState();
        if (state.changeSetEpoch === operationEpoch && !state.applyError) {
          draftDiskBaselineRef.current.set(baselineKey, content);
          const serializedState = draftHistoryEntriesRef.current[filePath]?.editorState;
          if (serializedState) {
            publishDraftHistoryCheckpoint(filePath, serializedState, content);
            if (!(await flushDraftHistoryWrites())) {
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
      hasReviewActionInFlight,
      clearReviewActionHistoryForFile,
      updateEditedContent,
      saveEditedFile,
      reviewScope,
      markRecentReviewWrite,
      publishDraftHistoryCheckpoint,
      flushDraftHistoryWrites,
    ]
  );

  const handleReloadFromDisk = useCallback(
    (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      draftDiskBaselineRef.current.delete(normalizePathForComparison(filePath));
      void clearDraftHistoryForFile(filePath);
      clearReviewActionHistoryForFile(filePath);
      reloadReviewFileFromDisk(filePath);
      setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
      void fetchFileContent(teamName, memberName, filePath);
    },
    [
      clearReviewActionHistoryForFile,
      clearDraftHistoryForFile,
      hasReviewActionInFlight,
      reloadReviewFileFromDisk,
      fetchFileContent,
      teamName,
      memberName,
    ]
  );

  const handleKeepDraft = useCallback(
    (filePath: string) => {
      if (hasReviewActionInFlight()) return;
      const baselineKey = normalizePathForComparison(filePath);
      if (!draftDiskBaselineRef.current.has(baselineKey)) {
        useStore.setState({
          applyError: 'The draft disk baseline is unavailable. Reload the file before continuing.',
        });
        return;
      }
      const expected = draftDiskBaselineRef.current.get(baselineKey) ?? '';
      const operationEpoch = useStore.getState().changeSetEpoch;
      fileApplyInFlightRef.current.add(filePath);
      setFileApplying(filePath, true);
      void (async () => {
        try {
          const current = await api.review.checkConflict(reviewScope, filePath, expected);
          if (useStore.getState().changeSetEpoch !== operationEpoch) return;
          const nextBaseline =
            current.hasConflict && current.conflictContent === null ? null : current.currentContent;
          draftDiskBaselineRef.current.set(baselineKey, nextBaseline);
          const serializedState = draftHistoryEntriesRef.current[filePath]?.editorState;
          if (serializedState) {
            publishDraftHistoryCheckpoint(filePath, serializedState, nextBaseline);
            if (!(await flushDraftHistoryWrites())) {
              throw new Error('Unable to persist the rebased manual edit history');
            }
          }
          clearReviewFileExternalChange(filePath);
          useStore.setState({ applyError: null });
        } catch (error) {
          if (useStore.getState().changeSetEpoch === operationEpoch) {
            useStore.setState({ applyError: String(error) });
          }
        } finally {
          fileApplyInFlightRef.current.delete(filePath);
          if (useStore.getState().changeSetEpoch === operationEpoch) {
            setFileApplying(filePath, false);
          }
        }
      })();
    },
    [
      clearReviewFileExternalChange,
      flushDraftHistoryWrites,
      hasReviewActionInFlight,
      publishDraftHistoryCheckpoint,
      reviewScope,
      setFileApplying,
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
      draftDiskBaselineRef.current.delete(normalizePathForComparison(filePath));
      void clearDraftHistoryForFile(filePath);
      discardFileEdits(filePath);
      setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
    },
    [clearDraftHistoryForFile, discardFileEdits, handleReloadFromDisk, hasReviewActionInFlight]
  );

  const restoreDiskSnapshot = useCallback(
    async (snapshot: ReviewDiskUndoSnapshot): Promise<boolean> => {
      if (useStore.getState().changeSetEpoch !== snapshot.changeSetEpoch) return false;
      if (snapshot.restoreConflict) {
        useStore.setState({ applyError: snapshot.restoreConflict });
        return false;
      }
      useStore.setState({ applyError: null });
      try {
        const restoreMode =
          snapshot.restoreMode ??
          (isLedgerRenameReviewFile(snapshot.file) ? 'restore-rejected-rename' : 'content');
        const expectedRestoredContent =
          restoreMode === 'delete-file' || restoreMode === 'reapply-rejected-rename'
            ? null
            : snapshot.beforeContent;
        markRecentReviewWrite(snapshot.filePath, expectedRestoredContent);
        if (restoreMode === 'restore-rejected-rename') {
          if (!snapshot.renameExpectation) {
            throw new Error('Rename recovery metadata is unavailable; refusing an unsafe restore.');
          }
          await api.review.restoreRejectedRename(
            reviewScope,
            snapshot.filePath,
            snapshot.renameExpectation
          );
        } else if (restoreMode === 'reapply-rejected-rename') {
          if (!snapshot.renameExpectation) {
            throw new Error('Rename recovery metadata is unavailable; refusing an unsafe restore.');
          }
          await api.review.reapplyRejectedRename(
            reviewScope,
            snapshot.filePath,
            snapshot.renameExpectation
          );
        } else if (restoreMode === 'delete-file') {
          if (snapshot.afterContent === null) {
            throw new Error('Undo delete snapshot is missing the expected file content.');
          }
          await api.review.deleteEditedFile(reviewScope, snapshot.filePath, snapshot.afterContent);
        } else if (restoreMode === 'create-file') {
          await api.review.saveEditedFile(
            reviewScope,
            snapshot.filePath,
            snapshot.beforeContent,
            null
          );
        } else {
          await api.review.saveEditedFile(
            reviewScope,
            snapshot.filePath,
            snapshot.beforeContent,
            snapshot.afterContent
          );
        }
        if (useStore.getState().changeSetEpoch !== snapshot.changeSetEpoch) return false;
        if (snapshot.afterContent === null && snapshot.file && restoreMode !== 'create-file') {
          addReviewFile(snapshot.file, {
            index: snapshot.fileIndex,
            content: {
              ...snapshot.file,
              originalFullContent: '',
              modifiedFullContent: snapshot.beforeContent,
              isNewFile: true,
              contentSource: 'disk-current',
            },
          });
        }
        markRecentReviewWrite(snapshot.filePath, expectedRestoredContent);
        clearReviewFileExternalChange(snapshot.filePath);
        useStore.getState().invalidateResolvedFileContent(snapshot.filePath);
        setDiscardCounters((previous) => ({
          ...previous,
          [snapshot.filePath]: (previous[snapshot.filePath] ?? 0) + 1,
        }));
        void fetchFileContent(teamName, memberName, snapshot.filePath);
        return true;
      } catch (error) {
        if (useStore.getState().changeSetEpoch === snapshot.changeSetEpoch) {
          useStore.setState({
            applyError:
              error instanceof Error
                ? error.message
                : 'Unable to undo because the file changed on disk.',
          });
          useStore.getState().invalidateResolvedFileContent(snapshot.filePath);
          setDiscardCounters((previous) => ({
            ...previous,
            [snapshot.filePath]: (previous[snapshot.filePath] ?? 0) + 1,
          }));
          void fetchFileContent(teamName, memberName, snapshot.filePath);
        }
        return false;
      }
    },
    [
      addReviewFile,
      clearReviewFileExternalChange,
      fetchFileContent,
      markRecentReviewWrite,
      memberName,
      reviewScope,
      teamName,
    ]
  );

  // Undo last bulk review operation (Accept All / Reject All)
  const handleUndoBulk = useCallback(async (): Promise<boolean> => {
    if (hasReviewActionInFlight() || editedCount > 0) return false;
    const diskSnapshots = bulkDiskUndoStackRef.current.at(-1) ?? [];
    if (diskSnapshots.length > 0) {
      setUndoInFlight(true);
      try {
        const failed: ReviewDiskUndoSnapshot[] = [];
        const restoredFiles: FileChangeSummary[] = [];
        let firstFailure: string | null = null;
        for (const snapshot of diskSnapshots) {
          if (!(await restoreDiskSnapshot(snapshot))) {
            failed.push(snapshot);
            firstFailure ??= useStore.getState().applyError;
            continue;
          }
          const file =
            snapshot.file ??
            activeChangeSet?.files.find(
              (candidate) =>
                normalizePathForComparison(candidate.filePath) ===
                normalizePathForComparison(snapshot.filePath)
            );
          if (file) restoredFiles.push(file);
        }
        if (failed.length > 0) {
          const state = useStore.getState();
          const decisionSnapshot = state.reviewUndoStack.at(-1);
          if (decisionSnapshot && restoredFiles.length > 0) {
            useStore.setState(
              restoreReviewDecisionRecordsForFiles(restoredFiles, state, decisionSnapshot)
            );
          }
          diskSnapshots.splice(0, diskSnapshots.length, ...failed);
          useStore.setState({
            applyError:
              firstFailure ?? 'Some files could not be restored because their disk state changed.',
          });
          return false;
        }
      } finally {
        setUndoInFlight(false);
      }
    }

    bulkDiskUndoStackRef.current.pop();
    const restored = undoBulkReview();
    if (restored && activeChangeSet) {
      // Nuclear reset: increment discard counters for all files to force CM remount
      setDiscardCounters((prev) => {
        const next = { ...prev };
        for (const file of activeChangeSet.files) {
          next[file.filePath] = (next[file.filePath] ?? 0) + 1;
        }
        return next;
      });
    }
    return restored;
  }, [
    activeChangeSet,
    editedCount,
    hasReviewActionInFlight,
    restoreDiskSnapshot,
    setUndoInFlight,
    undoBulkReview,
  ]);

  const handleUndoRecentDiskAction = useCallback(
    async (action: RecentDiskUndoAction): Promise<boolean> => {
      if (undoInFlightRef.current || fileApplyInFlightRef.current.has(action.snapshot.filePath)) {
        return false;
      }
      setUndoInFlight(true);
      try {
        if (!(await restoreDiskSnapshot(action.snapshot))) return false;
        const diskIndex = recentDiskUndoActionsRef.current.lastIndexOf(action);
        if (diskIndex !== -1) recentDiskUndoActionsRef.current.splice(diskIndex, 1);

        if (action.originalIndex !== undefined) {
          const fileStack = hunkDecisionUndoStackRef.current[action.snapshot.filePath];
          const stackIndex = fileStack?.lastIndexOf(action.originalIndex) ?? -1;
          if (fileStack && stackIndex !== -1) fileStack.splice(stackIndex, 1);
          if (fileStack?.length === 0) {
            delete hunkDecisionUndoStackRef.current[action.snapshot.filePath];
          }
          for (let index = recentHunkUndoActionsRef.current.length - 1; index >= 0; index--) {
            const hunkAction = recentHunkUndoActionsRef.current[index];
            if (
              hunkAction.filePath === action.snapshot.filePath &&
              hunkAction.originalIndex === action.originalIndex
            ) {
              recentHunkUndoActionsRef.current.splice(index, 1);
              break;
            }
          }
          clearHunkDecisionByOriginalIndex(action.snapshot.filePath, action.originalIndex);
        } else if (action.file && action.decisionSnapshot) {
          restoreFileDecisions(action.file, action.decisionSnapshot);
        }
        return true;
      } finally {
        setUndoInFlight(false);
      }
    },
    [clearHunkDecisionByOriginalIndex, restoreDiskSnapshot, restoreFileDecisions, setUndoInFlight]
  );

  const handleUndoHunkAction = useCallback(
    (action: RecentHunkUndoAction): boolean => {
      const actionIndex = recentHunkUndoActionsRef.current.lastIndexOf(action);
      if (actionIndex === -1) return false;
      recentHunkUndoActionsRef.current.splice(actionIndex, 1);

      const fileStack = hunkDecisionUndoStackRef.current[action.filePath];
      const stackIndex = fileStack?.lastIndexOf(action.originalIndex) ?? -1;
      if (fileStack && stackIndex !== -1) fileStack.splice(stackIndex, 1);
      if (fileStack?.length === 0) delete hunkDecisionUndoStackRef.current[action.filePath];

      clearHunkDecisionByOriginalIndex(action.filePath, action.originalIndex);
      // Remount instead of using CodeMirror's native undo history. Native redo could
      // otherwise replay the visual edit without restoring the persisted decision.
      setDiscardCounters((previous) => ({
        ...previous,
        [action.filePath]: (previous[action.filePath] ?? 0) + 1,
      }));
      return true;
    },
    [clearHunkDecisionByOriginalIndex]
  );

  const handleUndoLatestReviewAction = useCallback(async (): Promise<void> => {
    if (hasReviewActionInFlight() || editedCount > 0) return;
    const action = reviewUndoActionsRef.current.at(-1);
    if (!action) return;

    const restored =
      action.kind === 'bulk'
        ? await handleUndoBulk()
        : action.kind === 'disk'
          ? await handleUndoRecentDiskAction(action.action)
          : handleUndoHunkAction(action.action);
    if (restored) completeReviewUndoAction(action);
  }, [
    completeReviewUndoAction,
    editedCount,
    handleUndoBulk,
    handleUndoHunkAction,
    handleUndoRecentDiskAction,
    hasReviewActionInFlight,
  ]);

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

  const requestClose = useCallback(async (): Promise<void> => {
    const state = useStore.getState();
    if (decisionHydrationKey) {
      const matchesCurrentHydration = state.decisionHydrationScopeKey === decisionHydrationKey;
      const matchesDraftHydration = draftHistoryHydration.key === decisionHydrationKey;
      if (
        (matchesCurrentHydration && state.decisionHydrationStatus === 'error') ||
        (matchesDraftHydration && draftHistoryHydration.status === 'error')
      ) {
        // The persisted state is unknown. Close without overwriting or clearing its last good copy.
        onOpenChange(false);
        return;
      }
      if (
        !matchesCurrentHydration ||
        state.decisionHydrationStatus !== 'loaded' ||
        !matchesDraftHydration ||
        draftHistoryHydration.status !== 'loaded'
      ) {
        useStore.setState({
          applyError: 'Wait for saved review state to finish loading before closing Changes.',
        });
        return;
      }
    }
    for (const [filePath, view] of editorViewMapRef.current.entries()) {
      if (filePath in state.editedContents || draftHistoryEntriesRef.current[filePath]) {
        handleSerializedStateChanged(filePath, serializeReviewDraftEditorState(view.state));
      }
    }
    for (const filePath of Object.keys(state.editedContents)) {
      if (!draftHistoryEntriesRef.current[filePath]) {
        useStore.setState({
          applyError: `Manual edits for ${filePath} are not durable yet. Keep Changes open and retry.`,
        });
        return;
      }
    }
    const blockReason = getReviewCloseBlockReason({
      busy: hasReviewActionInFlight(),
      draftCount: 0,
    });
    if (blockReason) {
      useStore.setState({ applyError: blockReason });
      return;
    }

    closingRef.current = true;
    setClosing(true);
    try {
      if (!(await flushDraftHistoryWrites())) {
        useStore.setState({
          applyError: 'Unable to save manual edit history. Changes remains open.',
        });
        return;
      }
      if (decisionScopeToken) {
        const hasCurrentDecisions =
          Object.keys(state.hunkDecisions).length > 0 ||
          Object.keys(state.fileDecisions).length > 0;
        let flushed: boolean;
        if (hasCurrentDecisions) {
          // React's persistence effect may not have run after the final click yet.
          // Schedule from the authoritative current store snapshot before flushing.
          persistDecisions(teamName, decisionScopeKey, decisionScopeToken);
          flushed = await flushDecisionsToDisk(teamName, decisionScopeKey, decisionScopeToken);
        } else {
          flushed = await clearDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken);
        }
        if (!flushed) {
          useStore.setState({
            applyError: 'Unable to save review decisions. Changes remains open.',
          });
          return;
        }
      }
      onOpenChange(false);
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  }, [
    decisionScopeKey,
    decisionScopeToken,
    decisionHydrationKey,
    draftHistoryHydration.key,
    draftHistoryHydration.status,
    flushDecisionsToDisk,
    flushDraftHistoryWrites,
    hasReviewActionInFlight,
    handleSerializedStateChanged,
    onOpenChange,
    persistDecisions,
    clearDecisionsFromDisk,
    teamName,
  ]);

  const handleDiscardSavedDecisionState = useCallback(async (): Promise<void> => {
    if (!decisionScopeToken || !decisionHydrationKey || reviewMutationBusy) return;
    closingRef.current = true;
    setClosing(true);
    try {
      if (decisionHydrationFailed) {
        const cleared = await clearDecisionsFromDisk(
          teamName,
          decisionScopeKey,
          decisionScopeToken
        );
        if (!cleared) {
          useStore.setState({
            applyError: 'Unable to discard the unreadable saved review decisions.',
          });
          return;
        }
      }
      if (draftHistoryHydrationFailed) {
        try {
          await api.review.clearDraftHistory(teamName, decisionScopeKey, decisionScopeToken);
        } catch (error) {
          useStore.setState({
            applyError: `Unable to discard the unreadable manual edit history: ${String(error)}`,
          });
          return;
        }
        draftDiskBaselineRef.current.clear();
        draftHistoryEntriesRef.current = {};
        setDraftHistoryEntries({});
        setDraftHistoryHydration({ key: decisionHydrationKey, status: 'loaded' });
      }
      const state = useStore.getState();
      if (decisionHydrationFailed && state.decisionHydrationScopeKey !== decisionHydrationKey) {
        return;
      }
      // Keep any in-memory choice that raced an earlier load. Only the explicitly
      // discarded disk copy is reset; the current review can now become authoritative.
      useStore.setState({
        ...(decisionHydrationFailed ? { decisionHydrationStatus: 'loaded' as const } : {}),
        applyError: null,
      });
    } finally {
      closingRef.current = false;
      setClosing(false);
    }
  }, [
    clearDecisionsFromDisk,
    decisionHydrationFailed,
    decisionHydrationKey,
    decisionScopeKey,
    decisionScopeToken,
    draftHistoryHydrationFailed,
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
    if (!open) return;

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
    if (!open || !decisionScopeToken) return;
    void loadDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken);
  }, [decisionScopeKey, decisionScopeToken, loadDecisionsFromDisk, open, teamName]);

  // Persist decisions to disk on change (debounced via store action).
  // When decisions go from non-empty to empty (e.g. undo to clean state),
  // clear the persisted file so stale decisions don't reload on reopen.
  const hasDecisions =
    Object.keys(hunkDecisions).length > 0 || Object.keys(fileDecisions).length > 0;
  const hadDecisionsRef = useRef(false);
  useEffect(() => {
    hadDecisionsRef.current = false;
  }, [decisionScopeToken]);
  useEffect(() => {
    if (!open || !decisionScopeToken) return;
    // Never persist a decision before its instant disk mutation has completed.
    // On failure the decision is reconciled/rolled back first; when the busy state
    // clears this effect runs again with the authoritative post-operation state.
    if (!decisionHydrationReady || reviewActionsBusy) return;
    if (hasDecisions) {
      hadDecisionsRef.current = true;
      persistDecisions(teamName, decisionScopeKey, decisionScopeToken);
    } else if (hadDecisionsRef.current) {
      hadDecisionsRef.current = false;
      void clearDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken);
    }
  }, [
    open,
    hasDecisions,
    hunkDecisions,
    fileDecisions,
    fileContents,
    fileChunkCounts,
    teamName,
    decisionScopeKey,
    decisionScopeToken,
    persistDecisions,
    clearDecisionsFromDisk,
    reviewActionsBusy,
    decisionHydrationReady,
  ]);

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
      if (e.key === 'Escape') {
        e.preventDefault();
        void requestClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, requestClose]);

  // Track last focused CM editor for Cmd+Z outside editor
  useEffect(() => {
    if (!open) return;

    const handleFocusIn = (e: FocusEvent): void => {
      const target = e.target as Element | null;
      if (!target?.closest?.('.cm-editor')) return;

      const filePath = getEditorFilePathForTarget(target);
      if (!filePath) return;

      const view = editorViewMapRef.current.get(filePath);
      if (view) {
        lastFocusedEditorRef.current = view;
      }
    };

    document.addEventListener('focusin', handleFocusIn);
    return () => {
      document.removeEventListener('focusin', handleFocusIn);
      lastFocusedEditorRef.current = null;
    };
  }, [open, getEditorFilePathForTarget]);

  // Review actions use one ordered stack. Manual draft edits keep CodeMirror's native history.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (!(e.metaKey || e.ctrlKey) || e.code !== 'KeyZ') return;

      const tag = document.activeElement?.tagName;
      if (tag === 'INPUT' || tag === 'TEXTAREA') return;
      const activeElement = document.activeElement;
      const editorFilePath = getEditorFilePathForTarget(activeElement);
      const hasDraftInFocusedEditor = editorFilePath ? hasReviewDraft(editorFilePath) : false;
      const focusedEditor = editorFilePath
        ? (editorViewMapRef.current.get(editorFilePath) ?? null)
        : null;

      if (e.shiftKey) {
        if (focusedEditor && redoDepth(focusedEditor.state) > 0) return;
        if (reviewRedoBlockedRef.current && !hasDraftInFocusedEditor) {
          // A review Undo remounts the diff and intentionally drops native CM redo.
          // Swallow Shift+Z so it cannot replay only the visual half of the action.
          e.preventDefault();
          e.stopPropagation();
          useStore.setState({
            applyError: 'Redo is unavailable for review actions; repeat Accept or Reject instead.',
          });
        }
        return;
      }

      if (
        focusedEditor &&
        undoDepth(focusedEditor.state) > 0 &&
        (hasDraftInFocusedEditor || reviewUndoActionsRef.current.length === 0)
      ) {
        return;
      }
      if (hasDraftInFocusedEditor) return;
      if (hasReviewActionInFlight()) {
        e.preventDefault();
        e.stopPropagation();
        return;
      }

      if (reviewUndoActionsRef.current.length > 0) {
        e.preventDefault();
        e.stopPropagation();
        if (editedCount > 0) {
          useStore.setState({
            applyError: 'Save or discard manual edits before undoing a review action.',
          });
          return;
        }
        void handleUndoLatestReviewAction();
        return;
      }

      // Persisted/replayed review decisions intentionally have no session Undo payload.
      // Native CodeMirror Undo would change only the visual document and desynchronize
      // it from the decision store, so without a manual draft there is nothing to undo.
      e.preventDefault();
      e.stopPropagation();
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [
    open,
    getEditorFilePathForTarget,
    editedCount,
    handleUndoLatestReviewAction,
    hasReviewActionInFlight,
    hasReviewDraft,
  ]);

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
  const reviewStats = useMemo(() => {
    if (!activeChangeSet) return { pending: 0, accepted: 0, rejected: 0 };

    let pending = 0;
    let accepted = 0;
    let rejected = 0;

    for (const file of activeChangeSet.files) {
      // File-level decision takes priority (set by Accept All / Reject All)
      const reviewKey = getFileReviewKey(file);
      const fileDec = fileDecisions[reviewKey] ?? fileDecisions[file.filePath];
      const count = getFileHunkCount(file.filePath, file.snippets.length, fileChunkCounts);

      if (fileDec === 'accepted') {
        accepted += count;
        continue;
      }
      if (fileDec === 'rejected') {
        rejected += count;
        continue;
      }

      for (let i = 0; i < count; i++) {
        const key = buildHunkDecisionKey(reviewKey, i);
        const decision: HunkDecision =
          hunkDecisions[key] ?? hunkDecisions[`${file.filePath}:${i}`] ?? 'pending';
        if (decision === 'pending') pending++;
        else if (decision === 'accepted') accepted++;
        else if (decision === 'rejected') rejected++;
      }
    }

    return { pending, accepted, rejected };
  }, [activeChangeSet, hunkDecisions, fileDecisions, fileChunkCounts]);

  const changeStats = useMemo(() => {
    if (!activeChangeSet) return { linesAdded: 0, linesRemoved: 0, filesChanged: 0 };
    return {
      linesAdded: activeChangeSet.totalLinesAdded,
      linesRemoved: activeChangeSet.totalLinesRemoved,
      filesChanged: activeChangeSet.totalFiles,
    };
  }, [activeChangeSet]);

  const handleApply = useCallback(async () => {
    if (hasReviewActionInFlight()) return;
    await applyReview(teamName, taskId, memberName);
    // Only cleanup if apply succeeded (no error in store)
    const state = useStore.getState();
    if (!state.applyError) {
      void clearDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken ?? undefined);
      resetAllReviewState();
    }
  }, [
    applyReview,
    teamName,
    taskId,
    memberName,
    clearDecisionsFromDisk,
    decisionScopeKey,
    decisionScopeToken,
    resetAllReviewState,
    hasReviewActionInFlight,
  ]);

  const taskChangeSet =
    activeChangeSet && isTaskChangeSetV2(activeChangeSet) ? activeChangeSet : null;
  const hasReviewFiles = (activeChangeSet?.files.length ?? 0) > 0;
  const shouldShowScopeBanner =
    mode === 'task' &&
    !!taskChangeSet &&
    (taskChangeSet.provenance?.sourceKind !== 'ledger' ||
      classifyTaskChangeReviewability(taskChangeSet).reviewability === 'attention_required' ||
      taskChangeSet.scope.confidence.tier > 1);

  // Active file for timeline (derived from scroll-spy)
  const activeFile = useMemo(() => {
    if (!activeChangeSet || !activeFilePath) return null;
    return activeChangeSet.files.find((f) => f.filePath === activeFilePath) ?? null;
  }, [activeChangeSet, activeFilePath]);

  const title = useMemo(() => {
    if (mode === 'agent') return `Changes by ${displayMemberName(memberName ?? 'unknown')}`;
    const task = taskId ? globalTasks.find((t) => t.id === taskId) : undefined;
    const shortId = task?.displayId ?? taskId?.slice(0, 8) ?? '?';
    const subject = task?.subject;
    return subject ? `Changes for task #${shortId} - ${subject}` : `Changes for task #${shortId}`;
  }, [mode, memberName, taskId, globalTasks]);

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
          onClick={() => void requestClose()}
          disabled={reviewMutationBusy || decisionHydrationPending || draftHistoryHydrationPending}
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
            canUndo={reviewUndoDepth > 0 && editedCount === 0}
            onUndo={() => void handleUndoLatestReviewAction()}
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

      {/* Apply error */}
      {applyError && (
        <div className="border-b border-red-500/20 bg-red-500/10 px-4 py-2 text-xs text-red-400">
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
          <div className="flex w-full flex-col items-center justify-center gap-3 px-6 text-center text-sm text-red-400">
            <p>Saved review state could not be loaded. The stored copy was left untouched.</p>
            <div className="flex items-center gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reviewMutationBusy}
                onClick={() => {
                  if (decisionScopeToken && decisionHydrationFailed) {
                    void loadDecisionsFromDisk(teamName, decisionScopeKey, decisionScopeToken);
                  }
                  if (draftHistoryHydrationFailed) {
                    setDraftHistoryRetryNonce((value) => value + 1);
                  }
                }}
              >
                Retry
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={reviewMutationBusy}
                onClick={() => void handleDiscardSavedDecisionState()}
                className="border-red-500/30 text-red-300 hover:bg-red-500/10"
              >
                Discard saved state
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
