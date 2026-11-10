/**
 * Right-side panel for markdown split/preview mode.
 *
 * In split mode: renders a drag-resizable handle + MarkdownPreviewPane.
 * In preview mode: renders MarkdownPreviewPane at full width (no handle).
 *
 * CodeMirrorEditor is NOT rendered here — it stays in ProjectEditorOverlay
 * and is controlled via CSS display/width.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';

import { useMarkdownScrollSync } from '@renderer/hooks/useMarkdownScrollSync';

import { MarkdownPreviewPane } from './MarkdownPreviewPane';

// =============================================================================
// Types
// =============================================================================

interface MarkdownSplitViewProps {
  content: string;
  mode: 'split' | 'preview';
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  /** Key that changes when the EditorView changes (e.g. activeTabId) — triggers scroll re-attach */
  viewKey?: string | null;
  /** Base directory for resolving relative image/link URLs */
  baseDir?: string;
}

// =============================================================================
// Constants
// =============================================================================

const MIN_RATIO = 0.2;
const MAX_RATIO = 0.8;
const HANDLE_WIDTH = 4; // px

// =============================================================================
// Component
// =============================================================================

export const MarkdownSplitView = React.memo(function MarkdownSplitView({
  content,
  mode,
  splitRatio,
  onSplitRatioChange,
  viewKey,
  baseDir,
}: MarkdownSplitViewProps): React.ReactElement {
  const [isResizing, setIsResizing] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // Scroll sync auto-manages its own listener lifecycle via viewKey
  const scrollSync = useMarkdownScrollSync(mode === 'split', viewKey);

  // --- Resize drag logic ---

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      const parent = containerRef.current?.parentElement;
      if (!parent) return;

      const parentRect = parent.getBoundingClientRect();
      const relativeX = e.clientX - parentRect.left;
      const newRatio = Math.min(MAX_RATIO, Math.max(MIN_RATIO, relativeX / parentRect.width));
      onSplitRatioChange(newRatio);
    },
    [onSplitRatioChange]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (!isResizing) return;

    document.addEventListener('mousemove', handleMouseMove);
    document.addEventListener('mouseup', handleMouseUp);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const handleMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    setIsResizing(true);
  };

  // --- Preview width ---

  const previewWidth =
    mode === 'preview' ? '100%' : `calc(${(1 - splitRatio) * 100}% - ${HANDLE_WIDTH}px)`;

  return (
    <div ref={containerRef} className="flex h-full" style={{ width: previewWidth }}>
      {/* Resize handle — only in split mode */}
      {mode === 'split' && (
        // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- resize handle
        <div
          className={`shrink-0 cursor-col-resize border-x border-border transition-colors ${
            isResizing ? 'bg-blue-500/50' : 'hover:bg-blue-500/30'
          }`}
          style={{ width: HANDLE_WIDTH }}
          onMouseDown={handleMouseDown}
        />
      )}
      {/* Preview pane */}
      <div className="flex-1 overflow-hidden bg-surface">
        <MarkdownPreviewPane
          content={content}
          scrollRef={scrollSync.previewScrollRef}
          onScroll={scrollSync.handlePreviewScroll}
          baseDir={baseDir}
        />
      </div>
    </div>
  );
});
