/**
 * PaneSplitDropZone - Half-pane drop zones for creating new panes via tab drag.
 * Covers the left or right half of the pane. When a tab is dragged over a half,
 * a semi-transparent accent overlay highlights the target area.
 */

import { useDroppable } from '@dnd-kit/core';

interface PaneSplitDropZoneProps {
  paneId: string;
  side: 'left' | 'right';
  isActive: boolean;
}

export const PaneSplitDropZone = ({
  paneId,
  side,
  isActive,
}: PaneSplitDropZoneProps): React.JSX.Element => {
  const { setNodeRef, isOver } = useDroppable({
    id: `split-${side}-${paneId}`,
    data: {
      type: 'split-zone',
      paneId,
      side,
    },
  });

  return (
    <div
      ref={setNodeRef}
      className="absolute top-0 z-30"
      style={{
        [side]: 0,
        width: '50%',
        height: '100%',
        pointerEvents: isActive ? 'auto' : 'none',
      }}
    >
      {/* Semi-transparent overlay highlight when hovering */}
      {isOver && (
        <div
          className="absolute inset-0"
          style={{
            backgroundColor: 'var(--color-accent, #6366f1)',
            opacity: 0.12,
            borderLeft: side === 'right' ? '2px solid var(--color-accent, #6366f1)' : 'none',
            borderRight: side === 'left' ? '2px solid var(--color-accent, #6366f1)' : 'none',
          }}
        />
      )}
    </div>
  );
};
