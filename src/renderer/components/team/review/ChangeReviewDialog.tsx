import { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { goToNextChunk, rejectChunk } from '@codemirror/merge';
import { useDiffNavigation } from '@renderer/hooks/useDiffNavigation';
import { useViewedFiles } from '@renderer/hooks/useViewedFiles';
import { cn } from '@renderer/lib/utils';
import { useStore } from '@renderer/store';
import { ChevronDown, Clock, Loader2, X } from 'lucide-react';

import { CodeMirrorDiffView } from './CodeMirrorDiffView';
import { ConfidenceBadge } from './ConfidenceBadge';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { FileEditTimeline } from './FileEditTimeline';
import { KeyboardShortcutsHelp } from './KeyboardShortcutsHelp';
import { ReviewDiffContent } from './ReviewDiffContent';
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
}

const CONTENT_SOURCE_LABELS: Record<string, string> = {
  'file-history': 'File History',
  'snippet-reconstruction': 'Reconstructed',
  'disk-current': 'Current Disk',
  'git-fallback': 'Git Fallback',
  unavailable: 'Unavailable',
};

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
}: ChangeReviewDialogProps) => {
  const {
    activeChangeSet,
    changeSetLoading,
    changeSetError,
    selectedReviewFilePath,
    fetchAgentChanges,
    fetchTaskChanges,
    selectReviewFile,
    clearChangeReview,
    // Phase 2
    hunkDecisions,
    fileDecisions,
    fileContents,
    fileContentsLoading,
    diffViewMode,
    collapseUnchanged,
    applying,
    applyError,
    setHunkDecision,
    setDiffViewMode,
    setCollapseUnchanged,
    fetchFileContent,
    acceptAll,
    rejectAll,
    applyReview,
    // Editable diff
    editedContents,
    updateEditedContent,
    discardFileEdits,
    saveEditedFile,
  } = useStore();

  const editorViewRef = useRef<EditorView | null>(null);
  const [autoViewed, setAutoViewed] = useState(true);
  const [timelineOpen, setTimelineOpen] = useState(false);
  // Counter to force editor rebuild on discard
  const [discardCounter, setDiscardCounter] = useState(0);

  // Build scope key for viewed storage
  const scopeKey = mode === 'task' ? `task:${taskId ?? ''}` : `agent:${memberName ?? ''}`;

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

  // Editable diff computed values
  const editedCount = Object.keys(editedContents).length;
  const hasCurrentFileEdits = !!(
    selectedReviewFilePath && selectedReviewFilePath in editedContents
  );

  const handleSaveCurrentFile = useCallback(() => {
    if (selectedReviewFilePath) void saveEditedFile(selectedReviewFilePath);
  }, [selectedReviewFilePath, saveEditedFile]);

  const handleDiscardCurrentFile = useCallback(() => {
    if (selectedReviewFilePath) {
      discardFileEdits(selectedReviewFilePath);
      setDiscardCounter((c) => c + 1);
    }
  }, [selectedReviewFilePath, discardFileEdits]);

  const diffNav = useDiffNavigation(
    activeChangeSet?.files ?? [],
    selectedReviewFilePath,
    selectReviewFile,
    editorViewRef,
    open,
    (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'accepted'),
    (filePath, hunkIndex) => setHunkDecision(filePath, hunkIndex, 'rejected'),
    () => onOpenChange(false),
    handleSaveCurrentFile
  );

  // Auto-viewed callback
  const handleFullyViewed = useCallback(() => {
    if (autoViewed && selectedReviewFilePath && !isViewed(selectedReviewFilePath)) {
      markViewed(selectedReviewFilePath);
    }
  }, [autoViewed, selectedReviewFilePath, isViewed, markViewed]);

  // Load data on open
  useEffect(() => {
    if (!open) return;
    if (mode === 'agent' && memberName) {
      void fetchAgentChanges(teamName, memberName);
    } else if (mode === 'task' && taskId) {
      void fetchTaskChanges(teamName, taskId);
    }
    return () => clearChangeReview();
  }, [
    open,
    mode,
    teamName,
    memberName,
    taskId,
    fetchAgentChanges,
    fetchTaskChanges,
    clearChangeReview,
  ]);

  // Escape to close
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [open, onOpenChange]);

  // Cmd+N IPC listener (forwarded from main process)
  useEffect(() => {
    if (!open) return;
    const cleanup = window.electronAPI?.review.onCmdN?.(() => {
      const view = editorViewRef.current;
      if (view) {
        rejectChunk(view);
        requestAnimationFrame(() => goToNextChunk(view));
      }
    });
    return cleanup ?? undefined;
  }, [open]);

  // Lazy-load file content when file selected
  useEffect(() => {
    if (!open || !selectedReviewFilePath) return;
    if (fileContents[selectedReviewFilePath] || fileContentsLoading[selectedReviewFilePath]) return;
    void fetchFileContent(teamName, memberName, selectedReviewFilePath);
  }, [
    open,
    selectedReviewFilePath,
    teamName,
    memberName,
    fileContents,
    fileContentsLoading,
    fetchFileContent,
  ]);

  const selectedFile = useMemo(() => {
    if (!activeChangeSet || !selectedReviewFilePath) return null;
    return activeChangeSet.files.find((f) => f.filePath === selectedReviewFilePath) ?? null;
  }, [activeChangeSet, selectedReviewFilePath]);

  const fileContent = selectedReviewFilePath ? fileContents[selectedReviewFilePath] : null;
  const isFileContentLoading = selectedReviewFilePath
    ? (fileContentsLoading[selectedReviewFilePath] ?? false)
    : false;

  // Compute toolbar stats
  const reviewStats = useMemo(() => {
    if (!activeChangeSet) return { pending: 0, accepted: 0, rejected: 0 };

    let pending = 0;
    let accepted = 0;
    let rejected = 0;

    for (const file of activeChangeSet.files) {
      for (let i = 0; i < file.snippets.length; i++) {
        const key = `${file.filePath}:${i}`;
        const decision: HunkDecision = hunkDecisions[key] ?? 'pending';
        if (decision === 'pending') pending++;
        else if (decision === 'accepted') accepted++;
        else if (decision === 'rejected') rejected++;
      }
    }

    return { pending, accepted, rejected };
  }, [activeChangeSet, hunkDecisions]);

  const changeStats = useMemo(() => {
    if (!activeChangeSet) return { linesAdded: 0, linesRemoved: 0, filesChanged: 0 };
    return {
      linesAdded: activeChangeSet.totalLinesAdded,
      linesRemoved: activeChangeSet.totalLinesRemoved,
      filesChanged: activeChangeSet.totalFiles,
    };
  }, [activeChangeSet]);

  const handleApply = useCallback(() => {
    void applyReview(teamName, taskId, memberName);
  }, [applyReview, teamName, taskId, memberName]);

  const title =
    mode === 'agent'
      ? `Changes by ${memberName ?? 'unknown'}`
      : `Changes for task #${taskId ?? '?'}`;

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex flex-col bg-surface">
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border bg-surface-sidebar px-4 py-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-medium text-text">{title}</h2>
          {activeChangeSet && (
            <>
              <span className="text-xs text-text-muted">
                {activeChangeSet.totalFiles} files, +{activeChangeSet.totalLinesAdded} -
                {activeChangeSet.totalLinesRemoved}
              </span>
              {mode === 'task' && isTaskChangeSetV2(activeChangeSet) && (
                <ConfidenceBadge confidence={activeChangeSet.scope.confidence} />
              )}
              <ViewedProgressBar
                viewed={viewedCount}
                total={viewedTotalCount}
                progress={viewedProgress}
              />
            </>
          )}
        </div>
        <button
          onClick={() => onOpenChange(false)}
          className="rounded p-1 text-text-muted transition-colors hover:bg-surface-raised hover:text-text"
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
            diffViewMode={diffViewMode}
            collapseUnchanged={collapseUnchanged}
            applying={applying}
            autoViewed={autoViewed}
            onAutoViewedChange={setAutoViewed}
            onAcceptAll={acceptAll}
            onRejectAll={rejectAll}
            onApply={handleApply}
            onDiffViewModeChange={setDiffViewMode}
            onCollapseUnchangedChange={setCollapseUnchanged}
            editedCount={editedCount}
            hasCurrentFileEdits={hasCurrentFileEdits}
            saving={applying}
            onSaveCurrentFile={handleSaveCurrentFile}
            onDiscardCurrentFile={handleDiscardCurrentFile}
          />
        )}

      {/* Scope warnings */}
      {mode === 'task' &&
        activeChangeSet &&
        isTaskChangeSetV2(activeChangeSet) &&
        activeChangeSet.warnings.length > 0 && (
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
                selectedFilePath={selectedReviewFilePath}
                onSelectFile={selectReviewFile}
                viewedSet={viewedSet}
                onMarkViewed={markViewed}
                onUnmarkViewed={unmarkViewed}
              />

              {/* Edit Timeline */}
              {selectedFile?.timeline && selectedFile.timeline.events.length > 0 && (
                <div className="border-t border-border">
                  <button
                    onClick={() => setTimelineOpen(!timelineOpen)}
                    className="flex w-full items-center gap-1.5 px-3 py-2 text-xs text-text-secondary hover:text-text"
                  >
                    <Clock className="size-3.5" />
                    <span>Edit Timeline ({selectedFile.timeline.events.length})</span>
                    <ChevronDown
                      className={cn(
                        'ml-auto size-3 transition-transform',
                        timelineOpen && 'rotate-180'
                      )}
                    />
                  </button>
                  {timelineOpen && (
                    <FileEditTimeline
                      timeline={selectedFile.timeline}
                      onEventClick={(idx) => diffNav.goToHunk(idx)}
                      activeSnippetIndex={diffNav.currentHunkIndex}
                    />
                  )}
                </div>
              )}
            </div>

            {/* Diff content */}
            <div className="flex-1 overflow-y-auto">
              {selectedFile ? (
                <div className="flex h-full flex-col">
                  {/* File header with content source badge */}
                  <div className="flex items-center gap-2 border-b border-border px-4 py-2">
                    <span className="text-xs font-medium text-text">
                      {selectedFile.relativePath}
                    </span>
                    {selectedFile.isNewFile && (
                      <span className="rounded bg-green-500/20 px-1.5 py-0.5 text-[10px] text-green-400">
                        NEW
                      </span>
                    )}
                    {fileContent?.contentSource && (
                      <span className="rounded bg-surface-raised px-1.5 py-0.5 text-[10px] text-text-muted">
                        {CONTENT_SOURCE_LABELS[fileContent.contentSource] ??
                          fileContent.contentSource}
                      </span>
                    )}
                    {/* File-level decision indicator */}
                    {fileDecisions[selectedFile.filePath] && (
                      <span
                        className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
                          fileDecisions[selectedFile.filePath] === 'accepted'
                            ? 'bg-green-500/20 text-green-400'
                            : fileDecisions[selectedFile.filePath] === 'rejected'
                              ? 'bg-red-500/20 text-red-400'
                              : 'bg-zinc-500/20 text-zinc-400'
                        }`}
                      >
                        {fileDecisions[selectedFile.filePath]}
                      </span>
                    )}
                  </div>

                  {/* Loading state */}
                  {isFileContentLoading && (
                    <div className="flex flex-1 items-center justify-center gap-2 text-sm text-text-muted">
                      <Loader2 className="size-4 animate-spin" />
                      Loading file content...
                    </div>
                  )}

                  {/* CodeMirror diff view when file content is available */}
                  {!isFileContentLoading &&
                    fileContent &&
                    fileContent.contentSource !== 'unavailable' &&
                    fileContent.modifiedFullContent !== null && (
                      <div className="flex-1 overflow-auto">
                        <DiffErrorBoundary
                          filePath={selectedFile.filePath}
                          oldString={fileContent.originalFullContent ?? ''}
                          newString={fileContent.modifiedFullContent}
                        >
                          <CodeMirrorDiffView
                            key={`${selectedFile.filePath}:${discardCounter}`}
                            original={fileContent.originalFullContent ?? ''}
                            modified={fileContent.modifiedFullContent}
                            fileName={selectedFile.relativePath}
                            readOnly={false}
                            showMergeControls={true}
                            collapseUnchanged={collapseUnchanged}
                            onHunkAccepted={(idx) =>
                              setHunkDecision(selectedFile.filePath, idx, 'accepted')
                            }
                            onHunkRejected={(idx) =>
                              setHunkDecision(selectedFile.filePath, idx, 'rejected')
                            }
                            onFullyViewed={handleFullyViewed}
                            editorViewRef={editorViewRef}
                            onContentChanged={(content) => {
                              updateEditedContent(selectedFile.filePath, content);
                            }}
                          />
                        </DiffErrorBoundary>
                      </div>
                    )}

                  {/* Fallback: Phase 1 snippet view when content unavailable */}
                  {!isFileContentLoading &&
                    (!fileContent || fileContent.contentSource === 'unavailable') && (
                      <div className="flex-1 overflow-auto">
                        <ReviewDiffContent file={selectedFile} />
                      </div>
                    )}
                </div>
              ) : (
                <div className="flex h-full items-center justify-center text-sm text-text-muted">
                  Select a file to view changes
                </div>
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
