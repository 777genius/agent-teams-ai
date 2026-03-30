/**
 * Render strategy for member and lead nodes.
 * Uses the holographic hexagonal rendering from draw-agents.ts.
 */

import type { GraphNode } from '../ports/types';
import type { NodeRenderStrategy, NodeRenderState } from './types';
import { drawAgents } from '../canvas/draw-agents';
import { NODE, HIT_DETECTION } from '../constants/canvas-constants';

export class MemberStrategy implements NodeRenderStrategy {
  readonly kind = 'member' as const;

  draw(ctx: CanvasRenderingContext2D, node: GraphNode, state: NodeRenderState): void {
    // drawAgents handles both member and lead — we delegate to it
    drawAgents(
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
    const r = NODE.radiusMember + HIT_DETECTION.agentPadding;
    const dx = wx - x;
    const dy = wy - y;
    return dx * dx + dy * dy <= r * r;
  }

  getCollisionRadius(): number {
    return NODE.radiusMember + 20;
  }

  getChargeStrength(): number {
    return -600;
  }
}

export class LeadStrategy implements NodeRenderStrategy {
  readonly kind = 'lead' as const;

  draw(ctx: CanvasRenderingContext2D, node: GraphNode, state: NodeRenderState): void {
    drawAgents(
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
    const r = NODE.radiusLead + HIT_DETECTION.agentPadding;
    const dx = wx - x;
    const dy = wy - y;
    return dx * dx + dy * dy <= r * r;
  }

  getCollisionRadius(): number {
    return NODE.radiusLead + 30;
  }

  getChargeStrength(): number {
    return -1200;
  }
}
