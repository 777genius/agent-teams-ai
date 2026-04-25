/**
 * Interaction hook — click, hover, drag on canvas.
 * Delegates hit testing to strategy pattern.
 */

import { useRef, useCallback, useMemo } from 'react';
import type { GraphNode } from '../ports/types';
import { ANIM } from '../constants/canvas-constants';
import { findNodeAt } from '../canvas/hit-detection';

export interface UseGraphInteractionResult {
  hoveredNodeId: React.RefObject<string | null>;
  dragNodeId: React.RefObject<string | null>;
  isDragging: React.RefObject<boolean>;
  handleMouseDown: (wx: number, wy: number, nodes: GraphNode[]) => void;
  handleMouseMove: (wx: number, wy: number, nodes: GraphNode[]) => void;
  handleMouseUp: () => string | null;
  handleDoubleClick: (wx: number, wy: number, nodes: GraphNode[]) => string | null;
}

export interface UseGraphInteractionOptions {
  canDragNode?: (node: GraphNode) => boolean;
}

export function useGraphInteraction(
  onDragNode?: (nodeId: string, x: number, y: number) => void,
  options?: UseGraphInteractionOptions
): UseGraphInteractionResult {
  const hoveredNodeId = useRef<string | null>(null);
  const dragNodeId = useRef<string | null>(null);
  const isDragging = useRef(false);
  const mouseDownPos = useRef<{ x: number; y: number } | null>(null);
  const clickedNodeId = useRef<string | null>(null);
  const canDragNode = options?.canDragNode;

  const handleMouseDown = useCallback(
    (wx: number, wy: number, nodes: GraphNode[]) => {
      mouseDownPos.current = { x: wx, y: wy };
      const hit = findNodeAt(wx, wy, nodes);
      clickedNodeId.current = hit;

      if (hit) {
        // Stable-slot layout keeps lead fixed in the center. Only members can be dragged between slots.
        const hitNode = nodes.find((n) => n.id === hit);
        if (hitNode?.kind === 'member' && (canDragNode?.(hitNode) ?? true)) {
          dragNodeId.current = hit;
        }
      }
    },
    [canDragNode]
  );

  const handleMouseMove = useCallback(
    (wx: number, wy: number, nodes: GraphNode[]) => {
      // Check drag threshold
      if (mouseDownPos.current && dragNodeId.current) {
        const dx = wx - mouseDownPos.current.x;
        const dy = wy - mouseDownPos.current.y;
        if (dx * dx + dy * dy > ANIM.dragThresholdPx * ANIM.dragThresholdPx) {
          isDragging.current = true;
        }
      }

      // Drag node
      if (isDragging.current && dragNodeId.current) {
        onDragNode?.(dragNodeId.current, wx, wy);
        return;
      }

      // Hover detection
      hoveredNodeId.current = findNodeAt(wx, wy, nodes);
    },
    [onDragNode]
  );

  const handleMouseUp = useCallback((): string | null => {
    const wasDragging = isDragging.current;
    const nodeId = clickedNodeId.current;

    isDragging.current = false;
    dragNodeId.current = null;
    mouseDownPos.current = null;
    clickedNodeId.current = null;

    // If not dragging, this was a click
    if (!wasDragging && nodeId) {
      return nodeId;
    }
    return null;
  }, []);

  const handleDoubleClick = useCallback(
    (wx: number, wy: number, nodes: GraphNode[]): string | null => {
      return findNodeAt(wx, wy, nodes);
    },
    []
  );

  return useMemo(
    () => ({
      hoveredNodeId,
      dragNodeId,
      isDragging,
      handleMouseDown,
      handleMouseMove,
      handleMouseUp,
      handleDoubleClick,
    }),
    [handleDoubleClick, handleMouseDown, handleMouseMove, handleMouseUp]
  );
}
