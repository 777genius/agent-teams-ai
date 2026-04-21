import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { undo } from '@codemirror/commands';
import { rejectChunk } from '@codemirror/merge';
import { api, isElectronMode } from '@renderer/api';
import { EditorSelectionMenu } from '@renderer/components/team/editor/EditorSelectionMenu';
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
import { buildHunkDecisionKey, getFileReviewKey } from '@renderer/utils/reviewKey';
import { buildReviewDecisionScopeToken } from '@renderer/utils/reviewDecisionScope';
import {
  buildTaskChangeSignature,
  type TaskChangeRequestOptions,
} from '@renderer/utils/taskChangeRequest';
import { normalizePathForComparison } from '@shared/utils/platformPath';
import { ChevronDown, Clock, X } from 'lucide-react';

import { ChangesLoadingAnimation } from './ChangesLoadingAnimation';
import { acceptAllChunks, computeChunkIndexAtPos, rejectAllChunks } from './CodeMirrorDiffUtils';
import { ContinuousScrollView } from './ContinuousScrollView';
import { FileEditTimeline } from './FileEditTimeline';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { ReviewFileTree } from './ReviewFileTree';
import { ReviewToolbar } from './ReviewToolbar';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { EditorView } from '@codemirror/view';
import type {
  FileChangeSummary,
  FileChangeWithContent,
  HunkDecision,
  TaskChangeSetV2,
} from '@shared/types';
import type { EditorSelectionAction, EditorSelectionInfo } from '@shared/types/editor';

interface RecentHunkUndoAction {
  filePath: string;
  originalIndex: number;
  at: number;
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
    removeReviewFile,
    addReviewFile,
    clearReviewStateForFile,
    editedContents,
    updateEditedContent,
    discardFileEdits,
    saveEditedFile,
    reviewExternalChangesByFile,
    clearReviewFileExternalChange,
    reloadReviewFileFromDisk,
    loadDecisionsFromDisk,
    persistDecisions,
    clearDecisionsFromDisk,
    resetAllReviewState,
    fileChunkCounts,
    pushReviewUndoSnapshot,
    undoBulkReview,
    reviewUndoStack,
    hunkContextHashesByFile,
    globalTasks,
  } = useStore();

  // Build scope keys (pure values — safe to compute before hooks that depend on them)
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

  // Active file from scroll-spy (replaces selectedReviewFilePath for continuous scroll)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});
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
  // Last focused CM editor — for Cmd+Z outside editor
  const lastFocusedEditorRef = useRef<EditorView | null>(null);
  // Timestamp of last bulk accept/reject-all operation (for Ctrl/Cmd+Z UX)
  const lastBulkActionAtRef = useRef<number>(0);
  // Track recent per-hunk actions so Ctrl/Cmd+Z can clear persisted decisions (reopen-safe)
  const lastHunkActionAtRef = useRef<Record<string, number>>({});
  const hunkDecisionUndoStackRef = useRef<Record<string, number[]>>({});
  const recentHunkUndoActionsRef = useRef<RecentHunkUndoAction[]>([]);
  const lastEditorInteractionAtRef = useRef<Record<string, number>>({});
  const newFileApplyInFlightRef = useRef(new Set<string>());
  const lastFileActionAtRef = useRef<number>(0);
  const removedNewFileUndoStackRef = useRef<
    { file: FileChangeSummary; index: number; restoreContent: string; removedAt: number }[]
  >([]);
  const lastNewFileRemoveAtRef = useRef<number>(0);
  const recentReviewWritesRef = useRef(new Map<string, number>());

  // Proxy ref for useDiffNavigation (points to active file's editor)
  const activeEditorViewRef = useRef<EditorView | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

  const markRecentReviewWrite = useCallback((filePath: string): void => {
    recentReviewWritesRef.current.set(normalizePathForComparison(filePath), Date.now());
  }, []);

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

  // One-shot scroll-to-file ref (for initialFilePath)
  const initialScrollDoneRef = useRef(false);

  // Continuous scroll navigation
  const { scrollToFile, isProgrammaticScroll } = useContinuousScrollNav({
    scrollContainerRef,
  });

  // Sort files to match the visual order of the file tree (directories first, then alphabetical)
  const sortedFiles = useMemo(
    () => sortItemsAsTree(activeChangeSet?.files ?? [], (f) => f.relativePath),
    [activeChangeSet]
  );
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
    if (!activeChangeSet)
      return {} as Record<
        string,
        | { kind: 'deleted' }
        | { kind: 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string }
      >;

    const normalize = (s: string): string =>
      s.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trimEnd();
    const hashFull = (s: string): string => {
      // DJB2 (full string) — good enough for heuristic rename/move pairing
      let h = 5381;
      for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
      return (h >>> 0).toString(36);
    };
    const baseName = (p: string): string => p.split(/[\\/]/).filter(Boolean).pop() ?? p;

    type Label =
      | { kind: 'deleted' }
      | { kind: 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string };

    const out: Record<string, Label> = {};

    const deletedCandidates: { file: FileChangeSummary; hash: string }[] = [];
    const newCandidates: { file: FileChangeSummary; hash: string }[] = [];

    for (const f of activeChangeSet.files) {
      const content = fileContents[f.filePath];
      if (!content) continue;

      const modified = content.modifiedFullContent;
      const original = content.originalFullContent;

      if (!f.isNewFile && modified == null) {
        if (original != null) {
          deletedCandidates.push({ file: f, hash: hashFull(normalize(original)) });
        } else {
          out[f.filePath] = { kind: 'deleted' };
        }
      }

      if (f.isNewFile && modified != null) {
        newCandidates.push({ file: f, hash: hashFull(normalize(modified)) });
      }
    }

    const deletedByHash = new Map<string, { file: FileChangeSummary; count: number }>();
    for (const d of deletedCandidates) {
      const prev = deletedByHash.get(d.hash);
      deletedByHash.set(d.hash, { file: d.file, count: (prev?.count ?? 0) + 1 });
    }

    const usedDeleted = new Set<string>();
    for (const n of newCandidates) {
      const entry = deletedByHash.get(n.hash);
      if (!entry) continue;
      if (entry.count !== 1) continue; // ambiguous
      const oldFile = entry.file;
      if (usedDeleted.has(oldFile.filePath)) continue;
      usedDeleted.add(oldFile.filePath);

      const oldName = baseName(oldFile.relativePath);
      const newName = baseName(n.file.relativePath);
      const kind: 'moved' | 'renamed' =
        oldName === newName && oldFile.relativePath !== n.file.relativePath ? 'moved' : 'renamed';

      out[n.file.filePath] = { kind, direction: 'from', otherPath: oldFile.relativePath };
      out[oldFile.filePath] = { kind, direction: 'to', otherPath: n.file.relativePath };
    }

    for (const d of deletedCandidates) {
      if (!usedDeleted.has(d.file.filePath) && !(d.file.filePath in out)) {
        out[d.file.filePath] = { kind: 'deleted' };
      }
    }

    return out;
  }, [activeChangeSet, fileContents]);

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

    const unsubscribe = api.review.onExternalFileChange((event) => {
      const normalizedPath = normalizePathForComparison(event.path);
      const recentWriteAt = recentReviewWritesRef.current.get(normalizedPath);
      if (recentWriteAt && Date.now() - recentWriteAt < REVIEW_LOCAL_WRITE_COOLDOWN_MS) {
        return;
      }

      const state = useStore.getState();
      const active = state.activeChangeSet;
      if (!active) return;

      const file = active.files.find(
        (entry) => normalizePathForComparison(entry.filePath) === normalizedPath
      );
      if (!file) return;

      const changeType =
        event.type === 'create' ? 'add' : event.type === 'delete' ? 'unlink' : 'change';

      if (file.filePath in state.editedContents) {
        state.markReviewFileExternallyChanged(file.filePath, changeType);
        return;
      }

      state.clearReviewFileExternalChange(file.filePath);
      state.invalidateResolvedFileContent(file.filePath);
      void state.fetchFileContent(teamName, memberName, file.filePath);
    });

    void api.review.watchFiles(
      projectPath,
      sortedFiles.map((file) => file.filePath)
    );

    return () => {
      unsubscribe();
      void api.review.unwatchFiles();
    };
  }, [open, projectPath, sortedFiles, teamName, memberName]);

  // Tree click → scroll to file
  const handleTreeFileClick = useCallback(
    (filePath: string) => {
      scrollToFile(filePath);
      setActiveFilePath(filePath);
    },
    [scrollToFile]
  );

  // Double rAF to ensure DOM/layout is ready before scrolling (reduces nesting in keydown handler)
  const scheduleScrollToFile = useCallback(
    (path: string) => {
      requestAnimationFrame(() => {
        requestAnimationFrame(() => scrollToFile(path));
      });
    },
    [scrollToFile]
  );

  // Accept/Reject all across all files
  const handleAcceptAll = useCallback(() => {
    if (!activeChangeSet) return;
    pushReviewUndoSnapshot();
    lastBulkActionAtRef.current = Date.now();
    for (const file of activeChangeSet.files) {
      acceptAllFile(file.filePath);
    }
    requestAnimationFrame(() => {
      for (const view of editorViewMapRef.current.values()) {
        acceptAllChunks(view);
      }
    });
  }, [activeChangeSet, acceptAllFile, pushReviewUndoSnapshot]);

  const handleRejectAll = useCallback(() => {
    if (!activeChangeSet) return;
    pushReviewUndoSnapshot();
    lastBulkActionAtRef.current = Date.now();
    for (const file of activeChangeSet.files) {
      rejectAllFile(file.filePath);
    }
    requestAnimationFrame(() => {
      for (const view of editorViewMapRef.current.values()) {
        rejectAllChunks(view);
      }
    });
    if (REVIEW_INSTANT_APPLY) {
      // In instant-apply mode we don't show an "Apply" button, so bulk reject must
      // be applied immediately to match Cursor-like UX (including deleting new files).
      void applyReview(teamName, taskId, memberName);
    }
  }, [
    activeChangeSet,
    rejectAllFile,
    pushReviewUndoSnapshot,
    applyReview,
    teamName,
    taskId,
    memberName,
  ]);

  // File-level accept/reject (Cursor-style)
  const handleAcceptFile = useCallback(
    (filePath: string) => {
      lastFileActionAtRef.current = Date.now();
      acceptAllFile(filePath);
      const view = editorViewMapRef.current.get(filePath);
      if (view) {
        requestAnimationFrame(() => acceptAllChunks(view));
      }
    },
    [acceptAllFile]
  );

  const handleRejectFile = useCallback(
    async (filePath: string) => {
      if (newFileApplyInFlightRef.current.has(filePath)) return;
      newFileApplyInFlightRef.current.add(filePath);
      try {
        const file = activeChangeSet?.files.find((f) => f.filePath === filePath);
        const isNew = file?.isNewFile ?? false;

        // Mark rejected in store + update CM view immediately for feedback
        lastFileActionAtRef.current = Date.now();
        rejectAllFile(filePath);
        const view = editorViewMapRef.current.get(filePath);
        if (view) {
          requestAnimationFrame(() => rejectAllChunks(view));
        }

        if (REVIEW_INSTANT_APPLY) {
          // Reject a whole file should apply immediately (restore original on disk),
          // and NEW-file reject should delete it.
          const result = await applySingleFileDecision(teamName, filePath, taskId, memberName);

          if (isNew) {
            const hasErrorForFile = !!result?.errors.some((e) => e.filePath === filePath);
            if (result && !hasErrorForFile && file) {
              // Keep undo payload so Ctrl/Cmd+Z can restore the file (and re-add it to the review list).
              const cachedModified = fileContents[filePath]?.modifiedFullContent;
              const restoreContent =
                cachedModified ??
                (() => {
                  const writeSnippets = file.snippets.filter(
                    (s) => !s.isError && (s.type === 'write-new' || s.type === 'write-update')
                  );
                  if (writeSnippets.length === 0) return '';
                  return writeSnippets[writeSnippets.length - 1].newString;
                })();
              const index = activeChangeSet?.files.findIndex((f) => f.filePath === filePath) ?? 0;
              removedNewFileUndoStackRef.current.push({
                file,
                index: Math.max(0, index),
                restoreContent,
                removedAt: Date.now(),
              });
              lastNewFileRemoveAtRef.current = Date.now();
              removeReviewFile(filePath);
            }
          } else {
            const hasErrorForFile = !!result?.errors.some((e) => e.filePath === filePath);
            if (result && !hasErrorForFile) {
              markRecentReviewWrite(filePath);
              // Disk state is now authoritative. Clear stale decisions/cache so reopening
              // doesn't try to re-apply and the diff can re-resolve from disk.
              clearReviewStateForFile(filePath);
              setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
              void fetchFileContent(teamName, memberName, filePath);
            }
          }
        }
      } finally {
        newFileApplyInFlightRef.current.delete(filePath);
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
      removeReviewFile,
      fileContents,
      clearReviewStateForFile,
      fetchFileContent,
    ]
  );

  // Per-file callbacks for ContinuousScrollView
  const handleHunkAccepted = useCallback(
    (filePath: string, hunkIndex: number) => {
      const originalIndex = setHunkDecision(filePath, hunkIndex, 'accepted');
      lastHunkActionAtRef.current[filePath] = Date.now();
      if (!hunkDecisionUndoStackRef.current[filePath]) {
        hunkDecisionUndoStackRef.current[filePath] = [];
      }
      hunkDecisionUndoStackRef.current[filePath].push(originalIndex);
      recentHunkUndoActionsRef.current.push({
        filePath,
        originalIndex,
        at: Date.now(),
      });
    },
    [setHunkDecision]
  );

  const handleHunkRejected = useCallback(
    (filePath: string, hunkIndex: number) => {
      const originalIndex = setHunkDecision(filePath, hunkIndex, 'rejected');
      lastHunkActionAtRef.current[filePath] = Date.now();
      if (!hunkDecisionUndoStackRef.current[filePath]) {
        hunkDecisionUndoStackRef.current[filePath] = [];
      }
      hunkDecisionUndoStackRef.current[filePath].push(originalIndex);
      recentHunkUndoActionsRef.current.push({
        filePath,
        originalIndex,
        at: Date.now(),
      });
      if (REVIEW_INSTANT_APPLY) {
        void applySingleFileDecision(teamName, filePath, taskId, memberName).then((result) => {
          const hasErrorForFile = !!result?.errors.some((e) => e.filePath === filePath);
          if (result && !hasErrorForFile) {
            markRecentReviewWrite(filePath);
            clearReviewStateForFile(filePath);
            setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
            void fetchFileContent(teamName, memberName, filePath);
          }
        });
      }
    },
    [
      setHunkDecision,
      applySingleFileDecision,
      teamName,
      taskId,
      memberName,
      markRecentReviewWrite,
      clearReviewStateForFile,
      fetchFileContent,
    ]
  );

  const handleContentChanged = useCallback(
    (filePath: string, content: string) => {
      updateEditedContent(filePath, content);
    },
    [updateEditedContent]
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
      await saveEditedFile(filePath, projectPath);
      if (!useStore.getState().applyError) {
        markRecentReviewWrite(filePath);
      }
    },
    [saveEditedFile, projectPath, markRecentReviewWrite]
  );

  const handleRestoreMissingFile = useCallback(
    (filePath: string, content: string) => {
      updateEditedContent(filePath, content);
      // Ensure editedContents is set before saveEditedFile reads it.
      void Promise.resolve().then(async () => {
        await saveEditedFile(filePath, projectPath);
        if (!useStore.getState().applyError) {
          markRecentReviewWrite(filePath);
        }
      });
    },
    [updateEditedContent, saveEditedFile, projectPath, markRecentReviewWrite]
  );

  const handleReloadFromDisk = useCallback(
    (filePath: string) => {
      reloadReviewFileFromDisk(filePath);
      setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
      void fetchFileContent(teamName, memberName, filePath);
    },
    [reloadReviewFileFromDisk, fetchFileContent, teamName, memberName]
  );

  const handleKeepDraft = useCallback(
    (filePath: string) => {
      clearReviewFileExternalChange(filePath);
    },
    [clearReviewFileExternalChange]
  );

  const handleDiscardFile = useCallback(
    (filePath: string) => {
      discardFileEdits(filePath);
      setDiscardCounters((prev) => ({ ...prev, [filePath]: (prev[filePath] ?? 0) + 1 }));
    },
    [discardFileEdits]
  );

  // Undo last bulk review operation (Accept All / Reject All)
  const handleUndoBulk = useCallback(() => {
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
  }, [undoBulkReview, activeChangeSet]);

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

  // Scroll repositioning — re-query coords when parent scrolls (rAF-throttled)
  const hasData = !changeSetLoading && !changeSetError && !!activeChangeSet;
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
    if (!activeFilePath) return;
    void (async () => {
      await saveEditedFile(activeFilePath, projectPath);
      if (!useStore.getState().applyError) {
        markRecentReviewWrite(activeFilePath);
      }
    })();
  }, [activeFilePath, saveEditedFile, projectPath, markRecentReviewWrite]);

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
    () => onOpenChange(false),
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

    // On close — clear only volatile cache, keep decisions in store
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
  ]);

  // Reset initial scroll flag when initialFilePath changes
  useEffect(() => {
    initialScrollDoneRef.current = false;
  }, [initialFilePath]);

  // Scroll to initialFilePath once data is loaded
  useEffect(() => {
    if (!activeChangeSet || !initialFilePath || initialScrollDoneRef.current) return;
    const hasFile = activeChangeSet.files.some((f) => f.filePath === initialFilePath);
    if (!hasFile) return;
    initialScrollDoneRef.current = true;
    requestAnimationFrame(() => {
      requestAnimationFrame(() => scrollToFile(initialFilePath));
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
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

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

  useEffect(() => {
    if (!open) return;

    const markEditorInteraction = (target: EventTarget | null): void => {
      const element = target instanceof Element ? target : null;
      if (!element?.closest?.('.cm-editor')) return;
      const filePath = getEditorFilePathForTarget(element);
      if (!filePath) return;
      lastEditorInteractionAtRef.current[filePath] = Date.now();
    };

    const handleMouseDown = (e: MouseEvent): void => {
      markEditorInteraction(e.target);
    };

    const handleKeyDown = (e: KeyboardEvent): void => {
      markEditorInteraction(e.target);
    };

    document.addEventListener('mousedown', handleMouseDown, true);
    document.addEventListener('keydown', handleKeyDown, true);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown, true);
      document.removeEventListener('keydown', handleKeyDown, true);
    };
  }, [open, getEditorFilePathForTarget]);

  // Cmd+Z: undo in last focused editor, or fall back to bulk review undo
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.code === 'KeyZ' && !e.shiftKey) {
        // Don't intercept native undo in input/textarea
        const tag = document.activeElement?.tagName;
        if (tag === 'INPUT' || tag === 'TEXTAREA') return;

        // Prefer bulk undo (Accept All / Reject All) shortly after bulk action,
        // even if focus is inside a CM editor (focus often remains there after clicking buttons).
        const now = Date.now();

        // Undo: rejected NEW file (deleted from disk + removed from review list)
        const removedStack = removedNewFileUndoStackRef.current;
        const lastHunkAt = Object.values(lastHunkActionAtRef.current).reduce(
          (max, v) => Math.max(max, v),
          0
        );
        const lastReviewActionAt = Math.max(
          lastBulkActionAtRef.current,
          lastHunkAt,
          lastFileActionAtRef.current
        );
        const newFileWasLastAction = lastNewFileRemoveAtRef.current >= lastReviewActionAt;
        const isInEditor = !!document.activeElement?.closest('.cm-editor');
        const lastViewConnected = !!lastFocusedEditorRef.current?.dom.isConnected;
        const shouldPreferEditorUndo = isInEditor && lastViewConnected;
        if (newFileWasLastAction && removedStack.length > 0 && !shouldPreferEditorUndo) {
          e.preventDefault();
          e.stopPropagation();
          const snap = removedStack.pop()!;
          const restoredContent: FileChangeWithContent = {
            ...snap.file,
            originalFullContent: '',
            modifiedFullContent: snap.restoreContent,
            contentSource: 'snippet-reconstruction',
          };
          addReviewFile(snap.file, { index: snap.index, content: restoredContent });
          setActiveFilePath(snap.file.filePath);
          scheduleScrollToFile(snap.file.filePath);
          updateEditedContent(snap.file.filePath, snap.restoreContent);
          // Ensure editedContents is set before saveEditedFile reads it.
          void Promise.resolve().then(async () => {
            await saveEditedFile(snap.file.filePath, projectPath);
            if (!useStore.getState().applyError) {
              markRecentReviewWrite(snap.file.filePath);
            }
          });
          return;
        }

        const bulkRecently = now - lastBulkActionAtRef.current < 10_000;
        if (bulkRecently && useStore.getState().reviewUndoStack.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          handleUndoBulk();
          return;
        }

        const recentHunkAction =
          recentHunkUndoActionsRef.current[recentHunkUndoActionsRef.current.length - 1];
        const hunkOutsideEditor =
          recentHunkAction &&
          !isInEditor &&
          now - recentHunkAction.at < 5_000 &&
          (lastEditorInteractionAtRef.current[recentHunkAction.filePath] ?? 0) <=
            recentHunkAction.at &&
          !!editorViewMapRef.current.get(recentHunkAction.filePath)?.dom.isConnected;
        if (hunkOutsideEditor) {
          const action = recentHunkUndoActionsRef.current.pop()!;
          const view = editorViewMapRef.current.get(action.filePath)!;
          const fileStack = hunkDecisionUndoStackRef.current[action.filePath];
          if (fileStack) {
            const stackIndex = fileStack.lastIndexOf(action.originalIndex);
            if (stackIndex !== -1) {
              fileStack.splice(stackIndex, 1);
            }
            if (fileStack.length === 0) {
              delete hunkDecisionUndoStackRef.current[action.filePath];
            }
          }
          e.preventDefault();
          e.stopPropagation();
          undo(view);
          clearHunkDecisionByOriginalIndex(action.filePath, action.originalIndex);
          return;
        }

        // If the last action was a hunk keep/undo (accept/reject) and we're undoing immediately,
        // we must also clear the persisted decision. Otherwise reopening the dialog will replay it.
        if (document.activeElement?.closest('.cm-editor')) {
          const lastView = lastFocusedEditorRef.current;
          const fp = activeFilePathRef.current;
          const stack = fp ? hunkDecisionUndoStackRef.current[fp] : undefined;
          const lastAt = fp ? (lastHunkActionAtRef.current[fp] ?? 0) : 0;
          const hunkRecently = fp ? now - lastAt < 5_000 : false;

          if (fp && stack && stack.length > 0 && hunkRecently && lastView?.dom.isConnected) {
            e.preventDefault();
            e.stopPropagation();
            undo(lastView);
            const originalIndex = stack.pop()!;
            for (let i = recentHunkUndoActionsRef.current.length - 1; i >= 0; i--) {
              const action = recentHunkUndoActionsRef.current[i];
              if (action.filePath === fp && action.originalIndex === originalIndex) {
                recentHunkUndoActionsRef.current.splice(i, 1);
                break;
              }
            }
            clearHunkDecisionByOriginalIndex(fp, originalIndex);
            return;
          }

          // Otherwise, let CM handle its own undo
          return;
        }

        // Otherwise try to undo in the last focused CM editor
        const lastView = lastFocusedEditorRef.current;
        if (lastView?.dom.isConnected) {
          e.preventDefault();
          e.stopPropagation();
          undo(lastView);
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [
    open,
    handleUndoBulk,
    clearHunkDecisionByOriginalIndex,
    addReviewFile,
    updateEditedContent,
    saveEditedFile,
    projectPath,
    scheduleScrollToFile,
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
      handleHunkRejected(fp, idx);
      rejectChunk(view);
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
  ]);

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
    return subject ? `Changes for task #${shortId} — ${subject}` : `Changes for task #${shortId}`;
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
          onClick={() => onOpenChange(false)}
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
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
        activeChangeSet &&
        activeChangeSet.files.length > 0 && (
          <ReviewToolbar
            stats={reviewStats}
            changeStats={changeStats}
            collapseUnchanged={collapseUnchanged}
            applying={applying}
            autoViewed={autoViewed}
            onAutoViewedChange={setAutoViewed}
            onAcceptAll={handleAcceptAll}
            onRejectAll={handleRejectAll}
            onApply={handleApply}
            onCollapseUnchangedChange={setCollapseUnchanged}
            instantApply={REVIEW_INSTANT_APPLY}
            editedCount={editedCount}
            canUndo={reviewUndoStack.length > 0}
            onUndo={handleUndoBulk}
          />
        )}

      {/* Scope info / warnings + confidence badge */}
      {mode === 'task' && activeChangeSet && isTaskChangeSetV2(activeChangeSet) && (
        <ScopeWarningBanner
          warnings={activeChangeSet.warnings}
          confidence={activeChangeSet.scope.confidence}
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
        {changeSetLoading && <ChangesLoadingAnimation />}

        {changeSetError && (
          <div className="flex w-full items-center justify-center text-sm text-red-400">
            {changeSetError}
          </div>
        )}

        {!changeSetLoading && !changeSetError && activeChangeSet && (
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
                    <span>Edit Timeline ({activeFile.timeline.events.length})</span>
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
                hunkDecisions={hunkDecisions}
                fileDecisions={fileDecisions}
                hunkContextHashesByFile={hunkContextHashesByFile}
                collapseUnchanged={collapseUnchanged}
                applying={applying}
                autoViewed={autoViewed}
                discardCounters={discardCounters}
                onHunkAccepted={handleHunkAccepted}
                onHunkRejected={handleHunkRejected}
                onFullyViewed={handleFullyViewed}
                onContentChanged={handleContentChanged}
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

        {!changeSetLoading && !changeSetError && activeChangeSet?.files.length === 0 && (
          <div className="flex w-full items-center justify-center text-sm text-text-muted">
            No file changes detected
          </div>
        )}
      </div>
    </div>
  );
};
