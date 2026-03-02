/**
 * Scrollable markdown preview pane for the editor split view.
 *
 * Wraps MarkdownViewer in a scrollable container with ref access
 * for external scroll synchronization (code ↔ preview).
 */

import React from 'react';

import { MarkdownViewer } from '@renderer/components/chat/viewers/MarkdownViewer';

// =============================================================================
// Types
// =============================================================================

interface MarkdownPreviewPaneProps {
  content: string;
  className?: string;
  scrollRef?: React.RefObject<HTMLDivElement | null>;
  onScroll?: () => void;
  /** Base directory for resolving relative image/link URLs */
  baseDir?: string;
}

// =============================================================================
// Component
// =============================================================================

export const MarkdownPreviewPane = React.memo(function MarkdownPreviewPane({
  content,
  className = '',
  scrollRef,
  onScroll,
  baseDir,
}: MarkdownPreviewPaneProps): React.ReactElement {
  // Callback ref to wire scrollRef (RefObject<T | null>) to the div
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      if (scrollRef && 'current' in scrollRef) {
        (scrollRef as React.MutableRefObject<HTMLDivElement | null>).current = el;
      }
    },
    [scrollRef]
  );

  return (
    <div ref={setRef} className={`h-full overflow-y-auto ${className}`} onScroll={onScroll}>
      <div className="p-4">
        <MarkdownViewer content={content} bare maxHeight="" baseDir={baseDir} />
      </div>
    </div>
  );
});
