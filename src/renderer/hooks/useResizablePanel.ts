/**
 * useResizablePanel - Reusable hook for mouse-based panel resizing.
 *
 * Supports both:
 * - horizontal resizing for left/right side panels
 * - vertical resizing for top/bottom stacked panels
 */

import { useCallback, useEffect, useRef, useState } from 'react';

const DEFAULT_MIN_WIDTH = 280;
const DEFAULT_MAX_WIDTH = 500;
const DEFAULT_MIN_HEIGHT = 120;
const DEFAULT_MAX_HEIGHT = 520;

interface HorizontalResizeOptions {
  width: number;
  onWidthChange: (width: number) => void;
  minWidth?: number;
  maxWidth?: number;
  side: 'left' | 'right';
}

interface VerticalResizeOptions {
  height: number;
  onHeightChange: (height: number) => void;
  minHeight?: number;
  maxHeight?: number;
  side: 'top' | 'bottom';
}

type UseResizablePanelOptions = HorizontalResizeOptions | VerticalResizeOptions;

interface ResizeHandleProps {
  onMouseDown: (e: React.MouseEvent) => void;
}

interface UseResizablePanelReturn {
  isResizing: boolean;
  handleProps: ResizeHandleProps;
}

function isVerticalOptions(options: UseResizablePanelOptions): options is VerticalResizeOptions {
  return options.side === 'top' || options.side === 'bottom';
}

export function useResizablePanel(options: UseResizablePanelOptions): UseResizablePanelReturn {
  const [isResizing, setIsResizing] = useState(false);
  const originRef = useRef(0);
  const isVertical = isVerticalOptions(options);

  const onSizeChangeRef = useRef<(size: number) => void>(
    isVertical ? options.onHeightChange : options.onWidthChange
  );
  const minSizeRef = useRef(
    isVertical ? (options.minHeight ?? DEFAULT_MIN_HEIGHT) : (options.minWidth ?? DEFAULT_MIN_WIDTH)
  );
  const maxSizeRef = useRef(
    isVertical ? (options.maxHeight ?? DEFAULT_MAX_HEIGHT) : (options.maxWidth ?? DEFAULT_MAX_WIDTH)
  );
  const sideRef = useRef(options.side);

  useEffect(() => {
    sideRef.current = options.side;
    if (isVerticalOptions(options)) {
      onSizeChangeRef.current = options.onHeightChange;
      minSizeRef.current = options.minHeight ?? DEFAULT_MIN_HEIGHT;
      maxSizeRef.current = options.maxHeight ?? DEFAULT_MAX_HEIGHT;
    } else {
      onSizeChangeRef.current = options.onWidthChange;
      minSizeRef.current = options.minWidth ?? DEFAULT_MIN_WIDTH;
      maxSizeRef.current = options.maxWidth ?? DEFAULT_MAX_WIDTH;
    }
  }, [options]);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizing) return;

      let newSize: number;
      switch (sideRef.current) {
        case 'left':
          newSize = e.clientX - originRef.current;
          break;
        case 'right':
          newSize = window.innerWidth - e.clientX;
          break;
        case 'top':
          newSize = e.clientY - originRef.current;
          break;
        case 'bottom':
          newSize = window.innerHeight - e.clientY;
          break;
      }

      if (newSize >= minSizeRef.current && newSize <= maxSizeRef.current) {
        onSizeChangeRef.current(newSize);
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
      document.body.style.cursor = isVertical ? 'row-resize' : 'col-resize';
      document.body.style.userSelect = 'none';
    }

    return () => {
      document.removeEventListener('mousemove', handleMouseMove);
      document.removeEventListener('mouseup', handleMouseUp);
      document.body.style.cursor = '';
      document.body.style.userSelect = '';
    };
  }, [isResizing, handleMouseMove, handleMouseUp, isVertical]);

  const onMouseDown = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();

      if (isVerticalOptions(options)) {
        if (options.side === 'top') {
          originRef.current = e.clientY - options.height;
        }
      } else if (options.side === 'left') {
        originRef.current = e.clientX - options.width;
      }

      setIsResizing(true);
    },
    [options]
  );

  return {
    isResizing,
    handleProps: { onMouseDown },
  };
}
