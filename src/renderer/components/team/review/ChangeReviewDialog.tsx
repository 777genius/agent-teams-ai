import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { goToNextChunk, rejectChunk } from '@codemirror/merge';
import { isElectronMode } from '@renderer/api';
import { useContinuousScrollNav } from '@renderer/hooks/useContinuousScrollNav';
import { isLastChunkInFile, useDiffNavigation } from '@renderer/hooks/useDiffNavigation';
import { useViewedFiles } from '@renderer/hooks/useViewedFiles';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { getFileHunkCount, REVIEW_INSTANT_APPLY } from '@renderer/store/slices/changeReviewSlice';
import { ChevronDown, Clock, X } from 'lucide-react';

import { acceptAllChunks, rejectAllChunks } from './CodeMirrorDiffUtils';
import { ContinuousScrollView } from './ContinuousScrollView';
import { FileEditTimeline } from './FileEditTimeline';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { ReviewFileTree } from './ReviewFileTree';
import { ReviewToolbar } from './ReviewToolbar';
import { ScopeWarningBanner } from './ScopeWarningBanner';
import { ViewedProgressBar } from './ViewedProgressBar';

import type { EditorView } from '@codemirror/view';
import type { HunkDecision, TaskChangeSetV2 } from '@shared/types';

interface ChangeReviewDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  teamName: string;
  mode: 'agent' | 'task';
  memberName?: string;
  taskId?: string;
  initialFilePath?: string;
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
    setCollapseUnchanged,
    fetchFileContent,
    acceptAllFile,
    rejectAllFile,
    applyReview,
    applySingleFileDecision,
    editedContents,
    updateEditedContent,
    discardFileEdits,
    saveEditedFile,
    loadDecisionsFromDisk,
    persistDecisions,
    clearDecisionsFromDisk,
    resetAllReviewState,
    fileChunkCounts,
    pushReviewUndoSnapshot,
    undoBulkReview,
    reviewUndoStack,
  } = useStore();

  // Active file from scroll-spy (replaces selectedReviewFilePath for continuous scroll)
  const [activeFilePath, setActiveFilePath] = useState<string | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  const [discardCounters, setDiscardCounters] = useState<Record<string, number>>({});

  // EditorView map for all visible file editors
  const editorViewMapRef = useRef(new Map<string, EditorView>());
  const scrollContainerRef = useRef<HTMLDivElement>(null);

  // Proxy ref for useDiffNavigation (points to active file's editor)
  const activeEditorViewRef = useRef<EditorView | null>(null);
  const activeFilePathRef = useRef<string | null>(null);

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

  // Build scope key for viewed storage
  const scopeKey = mode === 'task' ? `task:${taskId ?? ''}` : `agent:${memberName ?? ''}`;

  // Build scope key for decision persistence (filesystem-safe: use `-` instead of `:`)
  const decisionScopeKey = mode === 'task' ? `task-${taskId ?? ''}` : `agent-${memberName ?? ''}`;

  // File paths for viewed tracking
  const allFilePaths = useMemo(
    () => (activeChangeSet?.files ?? []).map((f) => f.filePath),
    [activeChangeSet]
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
    if (!activeChangeSet) return;
    pushReviewUndoSnapshot();
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
    for (const file of activeChangeSet.files) {
      rejectAllFile(file.filePath);
    }
    requestAnimationFrame(() => {
      for (const view of editorViewMapRef.current.values()) {
        rejectAllChunks(view);
      }
    });
  }, [activeChangeSet, rejectAllFile, pushReviewUndoSnapshot]);

  // Per-file callbacks for ContinuousScrollView
  const handleHunkAccepted = useCallback(
    (filePath: string, hunkIndex: number) => {
      setHunkDecision(filePath, hunkIndex, 'accepted');
    },
    [setHunkDecision]
  );

  const handleHunkRejected = useCallback(
    (filePath: string, hunkIndex: number) => {
      setHunkDecision(filePath, hunkIndex, 'rejected');
      if (REVIEW_INSTANT_APPLY) {
        void applySingleFileDecision(teamName, filePath, taskId, memberName);
      }
    },
    [setHunkDecision, applySingleFileDecision, teamName, taskId, memberName]
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
    (filePath: string) => {
      void saveEditedFile(filePath);
    },
    [saveEditedFile]
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

  // Save active file (for Cmd+Enter keyboard shortcut)
  const handleSaveActiveFile = useCallback(() => {
    if (activeFilePath) void saveEditedFile(activeFilePath);
  }, [activeFilePath, saveEditedFile]);

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
    activeChangeSet?.files ?? [],
    activeFilePath,
    scrollToFile,
    activeEditorViewRef,
    open,
    handleHunkAccepted,
    handleHunkRejected,
    () => onOpenChange(false),
    handleSaveActiveFile,
    continuousOptions
  );

  // Load data on open
  useEffect(() => {
    if (!open) return;

    // Load persisted decisions from disk
    void loadDecisionsFromDisk(teamName, decisionScopeKey);

    // Fetch changeSet
    if (mode === 'agent' && memberName) {
      void fetchAgentChanges(teamName, memberName);
    } else if (mode === 'task' && taskId) {
      void fetchTaskChanges(teamName, taskId);
    }

    // On close — clear only volatile cache, keep decisions in store
    return () => clearChangeReviewCache();
  }, [
    open,
    mode,
    teamName,
    memberName,
    taskId,
    decisionScopeKey,
    fetchAgentChanges,
    fetchTaskChanges,
    clearChangeReviewCache,
    loadDecisionsFromDisk,
  ]);

  // Persist decisions to disk on change (debounced via store action).
  // When decisions go from non-empty to empty (e.g. undo to clean state),
  // clear the persisted file so stale decisions don't reload on reopen.
  const hasDecisions =
    Object.keys(hunkDecisions).length > 0 || Object.keys(fileDecisions).length > 0;
  const hadDecisionsRef = useRef(false);
  useEffect(() => {
    if (!open) return;
    if (hasDecisions) {
      hadDecisionsRef.current = true;
      persistDecisions(teamName, decisionScopeKey);
    } else if (hadDecisionsRef.current) {
      hadDecisionsRef.current = false;
      void clearDecisionsFromDisk(teamName, decisionScopeKey);
    }
  }, [
    open,
    hasDecisions,
    hunkDecisions,
    fileDecisions,
    teamName,
    decisionScopeKey,
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

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  // Cmd+Z for undo bulk review (when not inside a CM editor)
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent): void => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'z' && !e.shiftKey) {
        // Don't intercept if focus is inside a CM editor — let CM handle its own undo
        if (document.activeElement?.closest('.cm-editor')) return;

        if (useStore.getState().reviewUndoStack.length > 0) {
          e.preventDefault();
          e.stopPropagation();
          handleUndoBulk();
        }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [open, handleUndoBulk]);

  // Cmd+N IPC listener (forwarded from main process)
  useEffect(() => {
    if (!open) return;
    const cleanup = window.electronAPI?.review.onCmdN?.(() => {
      const fp = activeFilePathRef.current;
      const view = fp ? editorViewMapRef.current.get(fp) : null;
      if (view) {
        rejectChunk(view);
        requestAnimationFrame(() => {
          if (isLastChunkInFile(view)) {
            diffNav.goToNextFile();
          } else {
            goToNextChunk(view);
          }
        });
      }
    });
    return cleanup ?? undefined;
  }, [open, diffNav]);

  // Compute toolbar stats using actual CM chunk count (not snippet count)
  const reviewStats = useMemo(() => {
    if (!activeChangeSet) return { pending: 0, accepted: 0, rejected: 0 };

    let pending = 0;
    let accepted = 0;
    let rejected = 0;

    for (const file of activeChangeSet.files) {
      // File-level decision takes priority (set by Accept All / Reject All)
      const fileDec = fileDecisions[file.filePath];
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
        const key = `${file.filePath}:${i}`;
        const decision: HunkDecision = hunkDecisions[key] ?? 'pending';
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
      void clearDecisionsFromDisk(teamName, decisionScopeKey);
      resetAllReviewState();
    }
  }, [
    applyReview,
    teamName,
    taskId,
    memberName,
    clearDecisionsFromDisk,
    decisionScopeKey,
    resetAllReviewState,
  ]);

  // Active file for timeline (derived from scroll-spy)
  const activeFile = useMemo(() => {
    if (!activeChangeSet || !activeFilePath) return null;
    return activeChangeSet.files.find((f) => f.filePath === activeFilePath) ?? null;
  }, [activeChangeSet, activeFilePath]);

  const title =
    mode === 'agent'
      ? `Changes by ${memberName ?? 'unknown'}`
      : `Changes for task #${taskId ?? '?'}`;

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
        {changeSetLoading && (
          <div className="flex w-full items-center justify-center text-sm text-text-muted">
            Loading changes...
          </div>
        )}

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

            {/* Continuous scroll diff content */}
            <ContinuousScrollView
              files={activeChangeSet.files}
              fileContents={fileContents}
              fileContentsLoading={fileContentsLoading}
              viewedSet={viewedSet}
              editedContents={editedContents}
              hunkDecisions={hunkDecisions}
              fileDecisions={fileDecisions}
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
              onVisibleFileChange={handleVisibleFileChange}
              scrollContainerRef={scrollContainerRef}
              editorViewMapRef={editorViewMapRef}
              isProgrammaticScroll={isProgrammaticScroll}
              teamName={teamName}
              memberName={memberName}
              fetchFileContent={fetchFileContent}
            />
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
