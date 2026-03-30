/**
 * Strategy interfaces for per-kind node rendering, hit testing, and layout.
 * Open-Closed principle: new node kinds add new strategies, no changes to GraphCanvas.
 */

import type { GraphNode, GraphNodeKind } from '../ports/types';

/**
 * Rendering state passed to strategy draw methods (animation context).
 */
export interface NodeRenderState {
  isSelected: boolean;
  isHovered: boolean;
  time: number;
  cameraZoom: number;
}

/**
 * Strategy for rendering a specific node kind.
 * Liskov: all strategies are interchangeable via the registry.
 */
export interface NodeRenderStrategy {
  readonly kind: GraphNodeKind;

  /**
   * Draw the node on the canvas.
   */
  draw(
    ctx: CanvasRenderingContext2D,
    node: GraphNode,
    state: NodeRenderState,
  ): void;

  /**
   * Test whether the world-space point (wx, wy) is inside this node.
   */
  hitTest(node: GraphNode, wx: number, wy: number): boolean;

  /**
   * Get collision radius for d3-force collide simulation.
   */
  getCollisionRadius(): number;

  /**
   * Get charge strength for d3-force many-body simulation.
   */
  getChargeStrength(): number;
}
