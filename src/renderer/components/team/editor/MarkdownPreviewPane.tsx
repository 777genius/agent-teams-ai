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
  const internalRef = React.useRef<HTMLDivElement | null>(null);
  const setRef = React.useCallback(
    (el: HTMLDivElement | null) => {
      internalRef.current = el;
      if (scrollRef && 'current' in scrollRef) {
        // Forward ref — the mutable cast is the standard pattern for forwarding refs
        const mutableRef = scrollRef as React.MutableRefObject<HTMLDivElement | null>;
        mutableRef.current = el;
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
