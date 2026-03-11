/**
 * useResizablePanel - Reusable hook for mouse-based panel resizing.
 *
 * Extracted from the resize pattern in Sidebar.tsx.
 * Handles mousedown/mousemove/mouseup on document, cursor and userSelect overrides.
 *
 * @param options.width       Current panel width (controlled)
 * @param options.onWidthChange  Callback when width changes during drag
 * @param options.minWidth    Minimum allowed width (default 280)
 * @param options.maxWidth    Maximum allowed width (default 500)
 * @param options.side        Which side the panel is on:
 *                            'left'  → panel is on the left, resize handle on right edge
 *                            'right' → panel is on the right, resize handle on left edge
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_MIN_WIDTH = 280;
const DEFAULT_MAX_WIDTH = 500;

interface UseResizablePanelOptions {
  width: number;
  onWidthChange: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  side: 'left' | 'right';
}

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
}

interface UseResizablePanelReturn {
  isResizing: boolean;
  handleProps: ResizeHandleProps;
}

export function useResizablePanel({
  width,
  onWidthChange,
  minWidth = DEFAULT_MIN_WIDTH,
  maxWidth = DEFAULT_MAX_WIDTH,
  side,
}: UseResizablePanelOptions): UseResizablePanelReturn {
  const [isResizing, setIsResizing] = useState(false);

  // Store the panel's left offset for 'left' side panels.
  // Updated on resize start so the formula stays correct if layout shifts.
  const panelLeftRef = useRef(0);

  // Keep callbacks in refs to avoid stale closures in mousemove listener
  const onWidthChangeRef = useRef(onWidthChange);
  onWidthChangeRef.current = onWidthChange;

  const minWidthRef = useRef(minWidth);
  minWidthRef.current = minWidth;

  const maxWidthRef = useRef(maxWidth);
  maxWidthRef.current = maxWidth;

  const sideRef = useRef(side);
  sideRef.current = side;

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      let newWidth: number;
      if (sideRef.current === 'left') {
        // Panel on the left: width = cursor position - panel left edge
        newWidth = e.clientX - panelLeftRef.current;
      } else {
        // Panel on the right: width = viewport width - cursor position
        newWidth = window.innerWidth - e.clientX;
      }

      if (newWidth >= minWidthRef.current && newWidth <= maxWidthRef.current) {
        onWidthChangeRef.current(newWidth);
      }
    },
    [isResizing]
  );

  const handleMouseUp = useCallback(() => {
    setIsResizing(false);
  }, []);

  useEffect(() => {
    if (isResizing) {
      document.addEventListener('mousemove', handleMouseMove);
      document.addEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      if (side === 'left') {
        // Calculate the left edge of the panel from cursor position minus current width
        panelLeftRef.current = e.clientX - width;
      }

      setIsResizing(true);
    },
    [side, width]
  );

  return {
    isResizing,
    handleProps: { onMouseDown },
  };
}
