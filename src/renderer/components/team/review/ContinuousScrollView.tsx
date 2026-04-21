import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';

import { useLazyFileContent } from '@renderer/hooks/useLazyFileContent';
import { useVisibleFileSection } from '@renderer/hooks/useVisibleFileSection';
import { useStore } from '@renderer/store';
import { getFileReviewKey } from '@renderer/utils/reviewKey';

import {
  acceptAllChunks,
  getChunks,
  rejectAllChunks,
  replayHunkDecisionsSmart,
} from './CodeMirrorDiffUtils';
import { FileSectionDiff } from './FileSectionDiff';
import { FileSectionHeader } from './FileSectionHeader';
import { FullDiffLoadingBanner } from './FullDiffLoadingBanner';

import type { EditorView } from '@codemirror/view';
import type { FileChangeWithContent, HunkDecision } from '@shared/types';
import type { EditorSelectionInfo } from '@shared/types/editor';
import type { FileChangeSummary } from '@shared/types/review';

interface ContinuousScrollViewProps {
  files: FileChangeSummary[];
  fileContents: Record<string, FileChangeWithContent>;
  fileContentsLoading: Record<string, boolean>;
  globalDiffLoadingState?: {
    totalFilesCount: number;
    readyFilesCount: number;
    loadingFilesCount: number;
    snippetCount: number;
    activeFileName?: string;
  } | null;
  reviewExternalChangesByFile: Record<string, { type: 'change' | 'add' | 'unlink' }>;
  viewedSet: Set<string>;
  editedContents: Record<string, string>;
  hunkDecisions: Record<string, HunkDecision>;
  fileDecisions: Record<string, HunkDecision>;
  hunkContextHashesByFile: Record<string, Record<number, string>>;
  collapseUnchanged: boolean;
  applying: boolean;
  autoViewed: boolean;
  discardCounters: Record<string, number>;
  onHunkAccepted: (filePath: string, hunkIndex: number) => void;
  onHunkRejected: (filePath: string, hunkIndex: number) => void;
  onFullyViewed: (filePath: string) => void;
  onContentChanged: (filePath: string, content: string) => void;
  onDiscard: (filePath: string) => void;
  onSave: (filePath: string) => void;
  onReloadFromDisk: (filePath: string) => void;
  onKeepDraft: (filePath: string) => void;
  onAcceptFile: (filePath: string) => void;
  onRejectFile: (filePath: string) => void;
  onRestoreMissingFile?: (filePath: string, content: string) => void;
  pathChangeLabels?: Record<
    string,
    { kind: 'deleted' } | { kind: 'moved' | 'renamed'; direction: 'from' | 'to'; otherPath: string }
  >;
  /** Controlled collapsed state (persisted by parent). If omitted, component manages it locally. */
  collapsedFiles?: Set<string>;
  onToggleCollapse?: (filePath: string) => void;
  onVisibleFileChange: (filePath: string) => void;
  scrollContainerRef: React.RefObject<HTMLDivElement | null>;
  editorViewMapRef: React.MutableRefObject<Map<string, EditorView>>;
  isProgrammaticScroll: React.RefObject<boolean | null>;
  teamName: string;
  memberName: string | undefined;
  fetchFileContent: (
    teamName: string,
    memberName: string | undefined,
    filePath: string
  ) => Promise<void>;
  onSelectionChange?: (info: EditorSelectionInfo | null) => void;
  globalHunkOffsets?: Record<string, number>;
  totalReviewHunks?: number;
}

export const ContinuousScrollView = ({
  files,
  fileContents,
  fileContentsLoading,
  globalDiffLoadingState,
  reviewExternalChangesByFile,
  viewedSet,
  editedContents,
  hunkDecisions,
  fileDecisions,
  hunkContextHashesByFile,
  collapseUnchanged,
  applying,
  autoViewed,
  discardCounters,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  onContentChanged,
  onDiscard,
  onSave,
  onReloadFromDisk,
  onKeepDraft,
  onAcceptFile,
  onRejectFile,
  onRestoreMissingFile,
  pathChangeLabels,
  collapsedFiles: collapsedFilesProp,
  onToggleCollapse: onToggleCollapseProp,
  onVisibleFileChange,
  scrollContainerRef,
  editorViewMapRef,
  isProgrammaticScroll,
  teamName,
  memberName,
  fetchFileContent,
  onSelectionChange,
  globalHunkOffsets,
  totalReviewHunks,
}: ContinuousScrollViewProps): React.ReactElement => {
  const setFileChunkCount = useStore((s) => s.setFileChunkCount);
  const [localCollapsedFiles, setLocalCollapsedFiles] = useState<Set<string>>(() => new Set());
  const collapsedFiles = collapsedFilesProp ?? localCollapsedFiles;

  const handleToggleCollapse = useCallback(
    (filePath: string) => {
      if (onToggleCollapseProp) {
        onToggleCollapseProp(filePath);
        return;
      }
      setLocalCollapsedFiles((prev) => {
        const next = new Set(prev);
        if (next.has(filePath)) {
          next.delete(filePath);
        } else {
          next.add(filePath);
        }
        return next;
      });
    },
    [onToggleCollapseProp]
  );

  const filePaths = useMemo(() => files.map((f) => f.filePath), [files]);

  const { registerFileSectionRef } = useVisibleFileSection({
    onVisibleFileChange,
    scrollContainerRef,
    isProgrammaticScroll,
  });

  const { registerLazyRef } = useLazyFileContent({
    teamName,
    memberName,
    filePaths,
    scrollContainerRef,
    fileContents,
    fileContentsLoading,
    fetchFileContent,
    enabled: true,
  });

  // Combined ref callback: registers element in both scroll-spy and lazy-load observers
  const combinedRef = useCallback(
    (filePath: string) => {
      const sectionRef = registerFileSectionRef(filePath);
      const lazyRef = registerLazyRef(filePath);

      return (element: HTMLElement | null) => {
        sectionRef(element);
        lazyRef(element);
      };
    },
    [registerFileSectionRef, registerLazyRef]
  );

  // Refs to avoid stale closures — decisions change frequently
  const fileDecisionsRef = useRef(fileDecisions);
  const hunkDecisionsRef = useRef(hunkDecisions);
  const hunkHashesRef = useRef(hunkContextHashesByFile);
  useEffect(() => {
    fileDecisionsRef.current = fileDecisions;
    hunkDecisionsRef.current = hunkDecisions;
    hunkHashesRef.current = hunkContextHashesByFile;
  });

  // Track which views have already had decisions replayed to prevent
  // cascading re-replays on every render (useEffect in FileSectionDiff has no deps).
  // When a view is destroyed/recreated (discard, lazy remount), the identity changes
  // and replay runs once for the new instance.
  const replayedViewsRef = useRef(new Set<EditorView>());

  const handleEditorViewReady = useCallback(
    (filePath: string, view: EditorView | null) => {
      if (view) {
        const file = files.find((candidate) => candidate.filePath === filePath);
        const reviewKey = file ? getFileReviewKey(file) : filePath;
        // Skip if this exact view instance was already processed
        if (editorViewMapRef.current.get(filePath) === view && replayedViewsRef.current.has(view)) {
          return;
        }
        editorViewMapRef.current.set(filePath, view);
        replayedViewsRef.current.add(view);

        // Store the actual CM chunk count (may differ from snippet count)
        const chunks = getChunks(view.state);
        if (chunks) {
          setFileChunkCount(filePath, chunks.chunks.length);
        }

        const fileDecision =
          fileDecisionsRef.current[reviewKey] ?? fileDecisionsRef.current[filePath];
        if (fileDecision === 'accepted' || fileDecision === 'rejected') {
          // Sync file-level "Accept All" / "Reject All" decisions
          requestAnimationFrame(() => {
            if (fileDecision === 'accepted') {
              acceptAllChunks(view);
            } else {
              rejectAllChunks(view);
            }
          });
        } else {
          // Replay individual per-hunk decisions persisted from previous session
          requestAnimationFrame(() => {
            replayHunkDecisionsSmart(
              view,
              reviewKey,
              hunkDecisionsRef.current,
              hunkHashesRef.current[reviewKey] ?? hunkHashesRef.current[filePath]
            );
          });
        }
      } else {
        editorViewMapRef.current.delete(filePath);
        // Don't clean replayedViewsRef — stale entries are harmless (WeakSet-like behavior
        // is not needed since view instances are unique and old ones get GC'd)
      }
    },
    [editorViewMapRef, files, setFileChunkCount]
  );

  if (files.length === 0) {
    return (
      <div className="flex h-full items-center justify-center text-sm text-text-muted">
        No file changes detected
      </div>
    );
  }

  return (
    <div ref={scrollContainerRef} className="flex-1 overflow-y-auto">
      {globalDiffLoadingState ? (
        <FullDiffLoadingBanner
          totalFilesCount={globalDiffLoadingState.totalFilesCount}
          readyFilesCount={globalDiffLoadingState.readyFilesCount}
          loadingFilesCount={globalDiffLoadingState.loadingFilesCount}
          snippetCount={globalDiffLoadingState.snippetCount}
          activeFileName={globalDiffLoadingState.activeFileName}
        />
      ) : null}
      {files.map((file) => {
        const filePath = file.filePath;
        const reviewKey = getFileReviewKey(file);
        const content = fileContents[filePath] ?? null;
        const hasContent = filePath in fileContents;
        const hasEdits = filePath in editedContents;
        const isViewed = viewedSet.has(filePath);
        const decision = fileDecisions[reviewKey] ?? fileDecisions[filePath];

        const isCollapsed = collapsedFiles.has(filePath);

        return (
          <div key={filePath} ref={combinedRef(filePath)} className="border-b border-border">
            <FileSectionHeader
              file={file}
              fileContent={content}
              fileDecision={decision}
              externalChange={reviewExternalChangesByFile[filePath]}
              pathChangeLabel={pathChangeLabels?.[filePath]}
              hasEdits={hasEdits}
              applying={applying}
              isCollapsed={isCollapsed}
              onToggleCollapse={handleToggleCollapse}
              onDiscard={onDiscard}
              onSave={onSave}
              onReloadFromDisk={onReloadFromDisk}
              onKeepDraft={onKeepDraft}
              onAcceptFile={onAcceptFile}
              onRejectFile={onRejectFile}
              onRestoreMissingFile={onRestoreMissingFile}
            />

            {!isCollapsed && (
              <FileSectionDiff
                file={file}
                fileContent={content}
                isLoading={!hasContent}
                collapseUnchanged={collapseUnchanged}
                onHunkAccepted={onHunkAccepted}
                onHunkRejected={onHunkRejected}
                onFullyViewed={onFullyViewed}
                onContentChanged={onContentChanged}
                onEditorViewReady={handleEditorViewReady}
                discardCounter={discardCounters[filePath] ?? 0}
                autoViewed={autoViewed}
                isViewed={isViewed}
                onSelectionChange={onSelectionChange}
                globalHunkOffset={globalHunkOffsets?.[filePath] ?? 0}
                totalReviewHunks={totalReviewHunks}
              />
            )}
          </div>
        );
      })}
    </div>
  );
};
