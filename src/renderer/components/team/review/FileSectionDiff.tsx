import React, { useCallback, useEffect, useRef } from 'react';

import { useAppTranslation } from '@features/localization/renderer';

import { CodeMirrorDiffView } from './CodeMirrorDiffView';
import { DiffErrorBoundary } from './DiffErrorBoundary';
import { FileSectionPlaceholder } from './FileSectionPlaceholder';
import {
  getResolvedReviewModifiedContent,
  hasReviewSnippetText,
  isReviewFileMissingOnDisk,
  isReviewTextContentUnavailable,
  shouldRenderCurrentDiskContextPreview,
} from './reviewContentPreview';
import { ReviewDiffContent } from './ReviewDiffContent';
import {
  shouldRenderCodeMirrorReviewDiff,
  shouldRenderSnippetReviewPreview,
} from './reviewDiffSafety';

import type { EditorView } from '@codemirror/view';
import type { ReviewSerializedEditorState } from '@features/change-review-history/contracts';
import type { FileChangeWithContent } from '@shared/types';
import type { EditorSelectionInfo } from '@shared/types/editor';
import type { FileChangeSummary } from '@shared/types/review';

interface FileSectionDiffProps {
  file: FileChangeSummary;
  fileContent: FileChangeWithContent | null;
  draftContent?: string;
  isLoading: boolean;
  applying: boolean;
  collapseUnchanged: boolean;
  onHunkAccepted: (filePath: string, hunkIndex: number) => boolean | void;
  onHunkRejected: (
    filePath: string,
    hunkIndex: number,
    beforeContent: string,
    afterContent: string
  ) => boolean | void;
  onFullyViewed: (filePath: string) => void;
  onContentChanged: (filePath: string, content: string, previousContent?: string) => void;
  serializedState?: ReviewSerializedEditorState;
  onSerializedStateChanged: (filePath: string, state: ReviewSerializedEditorState) => void;
  onSerializedStateRestoreError: (filePath: string, error: unknown) => void;
  onEditorViewReady: (filePath: string, view: EditorView | null) => void;
  discardCounter: number;
  autoViewed: boolean;
  isViewed: boolean;
  onSelectionChange?: (info: EditorSelectionInfo | null) => void;
  globalHunkOffset?: number;
  totalReviewHunks?: number;
}

export const FileSectionDiff = ({
  file,
  fileContent,
  draftContent,
  isLoading,
  applying,
  collapseUnchanged,
  onHunkAccepted,
  onHunkRejected,
  onFullyViewed,
  onContentChanged,
  serializedState,
  onSerializedStateChanged,
  onSerializedStateRestoreError,
  onEditorViewReady,
  discardCounter,
  autoViewed,
  isViewed,
  onSelectionChange,
  globalHunkOffset = 0,
  totalReviewHunks,
}: FileSectionDiffProps): React.ReactElement => {
  const { t } = useAppTranslation('team');
  const localEditorViewRef = useRef<EditorView | null>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const hasSnippetText = hasReviewSnippetText(file);
  const canRenderSnippetPreview = hasSnippetText && shouldRenderSnippetReviewPreview(file.snippets);
  const baselineModified = getResolvedReviewModifiedContent(file, fileContent);
  // Keep the live editor uncontrolled while it is mounted, but seed a recreated editor
  // (for example after collapse/expand) from the latest draft instead of the disk baseline.
  const initialModifiedRef = useRef<{
    baseline: string | null;
    discardCounter: number;
    value: string | null;
  }>({
    baseline: null,
    discardCounter: -1,
    value: null,
  });
  if (
    initialModifiedRef.current.baseline !== baselineModified ||
    initialModifiedRef.current.discardCounter !== discardCounter
  ) {
    initialModifiedRef.current = {
      baseline: baselineModified,
      discardCounter,
      value: draftContent ?? baselineModified,
    };
  }
  const resolvedModified = initialModifiedRef.current.value;
  const hasDraft = draftContent !== undefined;

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
    if (!hasSnippetText) {
      return <FileSectionPlaceholder fileName={file.relativePath} />;
    }

    return (
      <div className="overflow-auto">
        {canRenderSnippetPreview ? (
          <ReviewDiffContent file={file} />
        ) : (
          <OversizedDiffNotice message="Diff preview skipped because the change is too large to render safely." />
        )}
        <div ref={sentinelRef} className="h-1 shrink-0" />
      </div>
    );
  }

  // Resolve modified content: prefer full content, fall back to write-type snippet
  // Only write-new/write-update snippets contain the full file - edit snippets are partial
  const resolvedOriginal = fileContent?.originalFullContent ?? null;
  const isNewFile = fileContent?.isNewFile ?? file.isNewFile;
  const isMissingOnDisk = isReviewFileMissingOnDisk(fileContent);
  const isContentUnavailable = isReviewTextContentUnavailable(file, fileContent);
  const hasLedgerManualAction = file.snippets.some(
    (snippet) =>
      !!snippet.ledger &&
      (snippet.ledger.relation?.kind === 'rename' ||
        (!!snippet.ledger.beforeState?.unavailableReason &&
          snippet.ledger.originalFullContent == null) ||
        (!!snippet.ledger.afterState?.unavailableReason &&
          snippet.ledger.modifiedFullContent == null))
  );

  // Show CodeMirror only when we have a trustworthy original baseline:
  // - new files: original is legitimately empty
  // - otherwise: original must be known (non-null). If original is unknown, do not
  //   pretend it's empty; fall back to snippet-level diff.
  const canRenderCodeMirror = resolvedModified !== null && (isNewFile || resolvedOriginal !== null);
  const originalForDiff = isNewFile ? '' : (resolvedOriginal ?? '');
  const canRenderCodeMirrorSafely =
    canRenderCodeMirror &&
    shouldRenderCodeMirrorReviewDiff(originalForDiff, resolvedModified ?? '');
  const canRenderCurrentDiskContext =
    resolvedModified !== null &&
    shouldRenderCurrentDiskContextPreview(file, fileContent) &&
    shouldRenderCodeMirrorReviewDiff(resolvedModified, resolvedModified);
  const currentDiskContextContent = canRenderCurrentDiskContext ? resolvedModified : null;

  if (!canRenderCodeMirrorSafely) {
    return (
      <div className="overflow-auto">
        <OversizedDiffNotice
          message={
            canRenderCurrentDiskContext
              ? 'No original baseline is available; showing current disk content for context only. Reject is disabled for this file.'
              : hasLedgerManualAction || isContentUnavailable
                ? 'No text diff is available for this ledger change. Binary, large, or metadata-only content requires manual review.'
                : canRenderCodeMirror && !canRenderSnippetPreview
                  ? 'Full diff skipped because it is large enough to risk a renderer out-of-memory crash.'
                  : canRenderCodeMirror
                    ? 'Large diff opened in safe preview mode to avoid a renderer out-of-memory crash.'
                    : hasSnippetText
                      ? 'Diff preview skipped because the available change data is too large to render safely.'
                      : file.snippets.length > 0
                        ? 'This file change was captured as metadata only; no text diff data is available.'
                        : 'No text diff data is available for this file.'
          }
        />
        {canRenderSnippetPreview ? (
          <ReviewDiffContent file={file} />
        ) : currentDiskContextContent != null ? (
          <DiffErrorBoundary
            filePath={file.filePath}
            oldString={currentDiskContextContent}
            newString={currentDiskContextContent}
          >
            <CodeMirrorDiffView
              key={`${file.filePath}:${discardCounter}:current-disk-context`}
              original={currentDiskContextContent}
              modified={currentDiskContextContent}
              fileName={file.relativePath}
              readOnly={true}
              showMergeControls={false}
              collapseUnchanged={false}
              usePortionCollapse={true}
              onHunkAccepted={(idx) => onHunkAccepted(file.filePath, idx)}
              onHunkRejected={(idx, before, after) =>
                onHunkRejected(file.filePath, idx, before, after)
              }
              onContentChanged={(content, previousContent) =>
                onContentChanged(file.filePath, content, previousContent)
              }
              editorViewRef={localEditorViewRef}
              onViewChange={handleViewChange}
              onSelectionChange={
                onSelectionChange
                  ? (info) => onSelectionChange(info ? { ...info, filePath: file.filePath } : null)
                  : undefined
              }
              globalHunkOffset={globalHunkOffset}
              totalReviewHunks={totalReviewHunks}
            />
          </DiffErrorBoundary>
        ) : null}
        <div ref={sentinelRef} className="h-1 shrink-0" />
      </div>
    );
  }

  return (
    <div className="overflow-auto">
      {isMissingOnDisk && (
        <div
          className="border-b border-border bg-red-500/10 px-4 py-2 text-xs"
          style={{ color: 'var(--diff-removed-text)' }}
        >
          {t('review.fileMissingPrefix')} <span className="font-medium">{t('review.restore')}</span>{' '}
          {t('review.fileMissingSuffix')}
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
          readOnly={hasLedgerManualAction || applying}
          showMergeControls={!isMissingOnDisk && !hasLedgerManualAction && !hasDraft && !applying}
          collapseUnchanged={collapseUnchanged}
          usePortionCollapse={true}
          onHunkAccepted={(idx) => onHunkAccepted(file.filePath, idx)}
          onHunkRejected={(idx, before, after) => onHunkRejected(file.filePath, idx, before, after)}
          onContentChanged={(content, previousContent) =>
            onContentChanged(file.filePath, content, previousContent)
          }
          serializedState={serializedState}
          onSerializedStateChanged={(state) => onSerializedStateChanged(file.filePath, state)}
          onSerializedStateRestoreError={(error) =>
            onSerializedStateRestoreError(file.filePath, error)
          }
          editorViewRef={localEditorViewRef}
          onViewChange={handleViewChange}
          onSelectionChange={
            onSelectionChange
              ? (info) => onSelectionChange(info ? { ...info, filePath: file.filePath } : null)
              : undefined
          }
          globalHunkOffset={globalHunkOffset}
          totalReviewHunks={totalReviewHunks}
        />
      </DiffErrorBoundary>
      <div ref={sentinelRef} className="h-1 shrink-0" />
    </div>
  );
};

const OversizedDiffNotice = ({ message }: { message: string }): React.ReactElement => {
  return (
    <div className="border-b border-border bg-amber-500/10 px-4 py-3 text-xs text-amber-300">
      {message}
    </div>
  );
};
