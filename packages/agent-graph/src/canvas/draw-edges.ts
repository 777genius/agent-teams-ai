/**
 * Edge drawing with tapered bezier curves and gradients.
 * Adapted from agent-flow's draw-edges.ts (Apache 2.0).
 */

import type { GraphNode, GraphEdge, GraphEdgeType } from '../ports/types';
import { COLORS } from '../constants/colors';
import { BEAM, MIN_VISIBLE_OPACITY } from '../constants/canvas-constants';

// ─── Edge Type → Color/Width Mapping ────────────────────────────────────────

const EDGE_STYLES: Record<GraphEdgeType, { color: string; startW: number; endW: number; dash?: number[] }> = {
  'parent-child': { color: COLORS.edgeParentChild, ...BEAM.parentChild },
  ownership: { color: COLORS.edgeOwnership, ...BEAM.ownership },
  blocking: { color: COLORS.edgeBlocking, ...BEAM.blocking, dash: [8, 4] },
  related: { color: COLORS.edgeRelated, ...BEAM.related, dash: [4, 4] },
  message: { color: COLORS.edgeMessage, ...BEAM.message },
};

// ─── Bezier Utilities ───────────────────────────────────────────────────────

export interface ControlPoints {
  cp1x: number;
  cp1y: number;
  cp2x: number;
  cp2y: number;
}

export function computeControlPoints(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
): ControlPoints {
  const dx = x2 - x1;
  const dy = y2 - y1;
  const nx = -dy * BEAM.curvature;
  const ny = dx * BEAM.curvature;
  return {
    cp1x: x1 + dx * BEAM.cp1 + nx,
    cp1y: y1 + dy * BEAM.cp1 + ny,
    cp2x: x1 + dx * BEAM.cp2 + nx,
    cp2y: y1 + dy * BEAM.cp2 + ny,
  };
}

/**
 * Evaluate a cubic bezier at parameter t.
 */
export function bezierPoint(
  x1: number,
  y1: number,
  cp: ControlPoints,
  x2: number,
  y2: number,
  t: number,
): { x: number; y: number } {
  const u = 1 - t;
  const uu = u * u;
  const uuu = uu * u;
  const tt = t * t;
  const ttt = tt * t;
  return {
    x: uuu * x1 + 3 * uu * t * cp.cp1x + 3 * u * tt * cp.cp2x + ttt * x2,
    y: uuu * y1 + 3 * uu * t * cp.cp1y + 3 * u * tt * cp.cp2y + ttt * y2,
  };
}

// ─── Draw All Edges ─────────────────────────────────────────────────────────

export function drawEdges(
  ctx: CanvasRenderingContext2D,
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  _time: number,
  hasActiveParticles: Set<string>,
  focusEdgeIds?: ReadonlySet<string> | null,
): void {
  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    if (source.x == null || source.y == null || target.x == null || target.y == null) continue;

    const style = EDGE_STYLES[edge.type] ?? EDGE_STYLES['parent-child'];
    const isActive = hasActiveParticles.has(edge.id);
    // Pulse alpha when particles are travelling: base 0.3 + 0.2 * sin wave
    const alpha = isActive
      ? BEAM.activeAlpha + 0.2 * Math.sin(_time * 6)
      : BEAM.idleAlpha;
    const focusAlpha = focusEdgeIds && !focusEdgeIds.has(edge.id) ? 0.1 : 1;

    if (alpha * focusAlpha < MIN_VISIBLE_OPACITY) continue;

    const cp = computeControlPoints(source.x, source.y, target.x, target.y);

    ctx.save();
    ctx.globalAlpha = alpha * focusAlpha;

    // Subtle glow pass when edge has active particles
    if (isActive) {
      ctx.shadowColor = edge.color ?? style.color;
      ctx.shadowBlur = 12;
    }

    // Draw tapered bezier
    drawTaperedBezier(
      ctx,
      source.x,
      source.y,
      cp,
      target.x,
      target.y,
      style.startW,
      style.endW,
      edge.color ?? style.color,
      style.dash,
    );

    // Arrow for blocking edges
    if (edge.type === 'blocking') {
      drawArrowHead(ctx, cp, target.x, target.y, style.color, alpha);
    }

    ctx.restore();
  }
}

// ─── Tapered Bezier ─────────────────────────────────────────────────────────

function drawTaperedBezier(
  ctx: CanvasRenderingContext2D,
  x1: number,
  y1: number,
  cp: ControlPoints,
  x2: number,
  y2: number,
  startW: number,
  endW: number,
  color: string,
  dash?: number[],
): void {
  if (dash) {
    // Dashed edges use stroke, not fill polygon
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.bezierCurveTo(cp.cp1x, cp.cp1y, cp.cp2x, cp.cp2y, x2, y2);
    ctx.strokeStyle = color;
    ctx.lineWidth = (startW + endW) / 2;
    ctx.setLineDash(dash);
    ctx.stroke();
    ctx.setLineDash([]);
    return;
  }

  // Build polygon outline for tapered width
  const segments = BEAM.segments;
  const leftPoints: { x: number; y: number }[] = [];
  const rightPoints: { x: number; y: number }[] = [];

  for (let i = 0; i <= segments; i++) {
    const t = i / segments;
    const pos = bezierPoint(x1, y1, cp, x2, y2, t);
    const w = startW + (endW - startW) * t;

    // Normal perpendicular
    const dt = 0.01;
    const tNext = Math.min(1, t + dt);
    const posNext = bezierPoint(x1, y1, cp, x2, y2, tNext);
    const dx = posNext.x - pos.x;
    const dy = posNext.y - pos.y;
    const len = Math.sqrt(dx * dx + dy * dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;

    leftPoints.push({ x: pos.x + nx * w * 0.5, y: pos.y + ny * w * 0.5 });
    rightPoints.push({ x: pos.x - nx * w * 0.5, y: pos.y - ny * w * 0.5 });
  }

  ctx.beginPath();
  ctx.moveTo(leftPoints[0].x, leftPoints[0].y);
  for (let i = 1; i < leftPoints.length; i++) {
    ctx.lineTo(leftPoints[i].x, leftPoints[i].y);
  }
  for (let i = rightPoints.length - 1; i >= 0; i--) {
    ctx.lineTo(rightPoints[i].x, rightPoints[i].y);
  }
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}

// ─── Arrow Head ─────────────────────────────────────────────────────────────

function drawArrowHead(
  ctx: CanvasRenderingContext2D,
  cp: ControlPoints,
  x2: number,
  y2: number,
  color: string,
  alpha: number,
): void {
  // Compute direction at t=1
  const dx = x2 - cp.cp2x;
  const dy = y2 - cp.cp2y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / len;
  const uy = dy / len;
  const arrowSize = 8;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.moveTo(x2, y2);
  ctx.lineTo(x2 - ux * arrowSize - uy * arrowSize * 0.5, y2 - uy * arrowSize + ux * arrowSize * 0.5);
  ctx.lineTo(x2 - ux * arrowSize + uy * arrowSize * 0.5, y2 - uy * arrowSize - ux * arrowSize * 0.5);
  ctx.closePath();
  ctx.fill();
  ctx.restore();
}
