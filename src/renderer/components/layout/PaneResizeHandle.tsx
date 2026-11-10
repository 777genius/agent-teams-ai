/**
 * PaneResizeHandle - Draggable divider between adjacent panes.
 * Uses the same mouse-event pattern as Sidebar.tsx for resize.
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import { useStore } from '@renderer/store';
import { useShallow } from 'zustand/react/shallow';

interface PaneResizeHandleProps {
  leftPaneId: string;
  rightPaneId: string;
}

export const PaneResizeHandle = ({ leftPaneId }: PaneResizeHandleProps): React.JSX.Element => {
  const [isResizing, setIsResizing] = useState(false);
  const resizePanes = useStore((s) => s.resizePanes);
  const paneLayout = useStore(useShallow((s) => s.paneLayout));
  const isResizingRef = useRef(false);

  const handleMouseMove = useCallback(
    (e: MouseEvent) => {
      if (!isResizingRef.current) return;

      // Calculate the new width fraction based on mouse position relative to container
      const container = document.getElementById('pane-container');
      if (!container) return;

      const containerRect = container.getBoundingClientRect();
      const relativeX = e.clientX - containerRect.left;
      const newFraction = relativeX / containerRect.width;

      // Calculate the cumulative width of all panes before the left pane
      const leftPaneIndex = paneLayout.panes.findIndex((p) => p.id === leftPaneId);
      if (leftPaneIndex === -1) return;

      let cumulativeWidth = 0;
      for (let i = 0; i < leftPaneIndex; i++) {
        cumulativeWidth += paneLayout.panes[i].widthFraction;
      }

      const leftPaneNewWidth = newFraction - cumulativeWidth;
      resizePanes(leftPaneId, leftPaneNewWidth);
    },
    [leftPaneId, paneLayout.panes, resizePanes]
  );

  const handleMouseUp = useCallback(() => {
    isResizingRef.current = false;
    setIsResizing(false);
  }, []);

  useEffect(() => {
    isResizingRef.current = isResizing;
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

  const handleMouseDown = (e: React.MouseEvent): void => {
    e.preventDefault();
    setIsResizing(true);
  };

  return (
    // eslint-disable-next-line jsx-a11y/no-static-element-interactions -- resize handle requires mouse interaction
    <div
      className={`flex w-1 shrink-0 cursor-col-resize items-center justify-center transition-colors hover:bg-blue-500/50 ${
        isResizing ? 'bg-blue-500/50' : ''
      }`}
      style={{
        backgroundColor: isResizing ? undefined : 'var(--color-border)',
      }}
      onMouseDown={handleMouseDown}
    />
  );
};
