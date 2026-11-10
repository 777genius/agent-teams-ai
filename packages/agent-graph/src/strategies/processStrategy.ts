/**
 * Render strategy for process nodes.
 */

import type { GraphNode } from '../ports/types';
import type { NodeRenderStrategy, NodeRenderState } from './types';
import { drawProcesses } from '../canvas/draw-processes';
import { NODE, HIT_DETECTION } from '../constants/canvas-constants';

export class ProcessStrategy implements NodeRenderStrategy {
  readonly kind = 'process' as const;

  draw(ctx: CanvasRenderingContext2D, node: GraphNode, state: NodeRenderState): void {
    drawProcesses(
      ctx,
      [node],
      state.time,
      state.isSelected ? node.id : null,
      state.isHovered ? node.id : null,
    );
  }

  hitTest(node: GraphNode, wx: number, wy: number): boolean {
    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = NODE.radiusProcess + HIT_DETECTION.agentPadding;
    const dx = wx - x;
    const dy = wy - y;
    return dx * dx + dy * dy <= r * r;
  }

  getCollisionRadius(): number {
    return NODE.radiusProcess + 10;
  }

  getChargeStrength(): number {
    return -200;
  }
}
