import React, { useCallback, useEffect, useRef } from 'react';

import { CodeMirrorDiffView } from './CodeMirrorDiffView';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { FileSectionPlaceholder } from './FileSectionPlaceholder';
import { ReviewDiffContent } from './ReviewDiffContent';

import type { EditorView } from '@codemirror/view';
import type { FileChangeWithContent } from '@shared/types';
import type { EditorSelectionInfo } from '@shared/types/editor';
import type { FileChangeSummary } from '@shared/types/review';

interface FileSectionDiffProps {
  file: FileChangeSummary;
  fileContent: FileChangeWithContent | null;
  isLoading: boolean;
  collapseUnchanged: boolean;
  onHunkAccepted: (filePath: string, hunkIndex: number) => void;
  onHunkRejected: (filePath: string, hunkIndex: number) => void;
  onFullyViewed: (filePath: string) => void;
  onContentChanged: (filePath: string, content: string) => void;
  onEditorViewReady: (filePath: string, view: EditorView | null) => void;
  discardCounter: number;
  autoViewed: boolean;
  isViewed: boolean;
  onSelectionChange?: (info: EditorSelectionInfo | null) => void;
}

export const FileSectionDiff = ({
  file,
  fileContent,
  isLoading,
  collapseUnchanged,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  onContentChanged,
  onEditorViewReady,
  discardCounter,
  autoViewed,
  isViewed,
  onSelectionChange,
}: FileSectionDiffProps): React.ReactElement => {
  const localEditorViewRef = useRef<EditorView | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);

  // Notify parent whenever CodeMirrorDiffView creates or destroys its EditorView.
  // This fires on every editor lifecycle event: initial mount, key-change remount,
  // and internal recreation (e.g. when `modified` prop changes after Save).
  const handleViewChange = useCallback(
    (view: EditorView | null) => {
      localEditorViewRef.current = view;
      onEditorViewReady(file.filePath, view);
    },
    [file.filePath, onEditorViewReady]
  );

  // Auto-viewed sentinel observer
  useEffect(() => {
    if (!sentinelRef.current || !autoViewed || isViewed) return;

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            onFullyViewed(file.filePath);
          }
        }
      },
      { threshold: 0.85 }
    );

    observer.observe(sentinelRef.current);
    return () => observer.disconnect();
  }, [autoViewed, isViewed, file.filePath, onFullyViewed]);

  // Loading state
  if (isLoading) {
    return <FileSectionPlaceholder fileName={file.relativePath} />;
  }

  // Resolve modified content: prefer full content, fall back to write-type snippet
  // Only write-new/write-update snippets contain the full file — edit snippets are partial
  const resolvedModified =
    fileContent?.modifiedFullContent ??
    (() => {
      const writeSnippets = file.snippets.filter(
        (s) => !s.isError && (s.type === 'write-new' || s.type === 'write-update')
      );
      if (writeSnippets.length === 0) return null;
      // Take the last write (most recent full-file content)
      return writeSnippets[writeSnippets.length - 1].newString;
    })();

  const resolvedOriginal = fileContent?.originalFullContent ?? null;
  const isMissingOnDisk = fileContent ? fileContent.modifiedFullContent == null : false;

  // Show CodeMirror only when we have a trustworthy original baseline:
  // - new files: original is legitimately empty
  // - otherwise: original must be known (non-null). If original is unknown, do not
  //   pretend it's empty — fall back to snippet-level diff.
  const canRenderCodeMirror =
    resolvedModified !== null && (file.isNewFile || resolvedOriginal !== null);

  if (!canRenderCodeMirror) {
    return (
      <div className="overflow-auto">
        <ReviewDiffContent file={file} />
        <div ref={sentinelRef} className="h-1 shrink-0" />
      </div>
    );
  }

  const originalForDiff = file.isNewFile ? '' : (resolvedOriginal ?? '');

  return (
    <div className="overflow-auto">
      {isMissingOnDisk && (
        <div
          className="border-b border-border bg-red-500/10 px-4 py-2 text-xs"
          style={{ color: 'var(--diff-removed-text)' }}
        >
          File is missing on disk. This diff may be only a preview from agent logs. Use{' '}
          <span className="font-medium">Restore</span> to create the file on disk.
        </div>
      )}
      <DiffErrorBoundary
        filePath={file.filePath}
        oldString={originalForDiff}
        newString={resolvedModified}
      >
        <CodeMirrorDiffView
          key={`${file.filePath}:${discardCounter}`}
          original={originalForDiff}
          modified={resolvedModified}
          fileName={file.relativePath}
          readOnly={false}
          showMergeControls={!isMissingOnDisk}
          collapseUnchanged={collapseUnchanged}
          usePortionCollapse={true}
          onHunkAccepted={(idx) => onHunkAccepted(file.filePath, idx)}
          onHunkRejected={(idx) => onHunkRejected(file.filePath, idx)}
          onContentChanged={(content) => onContentChanged(file.filePath, content)}
          editorViewRef={localEditorViewRef}
          onViewChange={handleViewChange}
          onSelectionChange={
            onSelectionChange
              ? (info) => onSelectionChange(info ? { ...info, filePath: file.filePath } : null)
              : undefined
          }
        />
      </DiffErrorBoundary>
      <div ref={sentinelRef} className="h-1 shrink-0" />
    </div>
  );
};
