/**
 * Hit detection — determine what the user clicked/hovered in world space.
 * Adapted from agent-flow's hit-detection.ts (Apache 2.0).
 */

import type { GraphEdge, GraphNode } from '../ports/types';
import { BEAM, NODE, TASK_PILL, HIT_DETECTION } from '../constants/canvas-constants';
import { bezierPoint, computeControlPoints } from './draw-edges';

/**
 * Find the node at the given world-space coordinates.
 * Returns node ID or null.
 * Priority: lead > member > task > process.
 */
export function findNodeAt(
  worldX: number,
  worldY: number,
  nodes: GraphNode[],
): string | null {
  // Check in reverse priority order, return last match (highest priority wins)
  let hit: string | null = null;

  for (const node of nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    switch (node.kind) {
      case 'lead':
      case 'member': {
        const r = (node.kind === 'lead' ? NODE.radiusLead : NODE.radiusMember) + HIT_DETECTION.agentPadding;
        const dx = worldX - x;
        const dy = worldY - y;
        if (dx * dx + dy * dy <= r * r) {
          hit = node.id;
          // Lead has highest priority, return immediately
          if (node.kind === 'lead') return hit;
        }
        break;
      }
      case 'task': {
        const halfW = TASK_PILL.width / 2 + HIT_DETECTION.taskPadding;
        const halfH = TASK_PILL.height / 2 + HIT_DETECTION.taskPadding;
        if (
          worldX >= x - halfW &&
          worldX <= x + halfW &&
          worldY >= y - halfH &&
          worldY <= y + halfH
        ) {
          hit = node.id;
        }
        break;
      }
      case 'process':
      case 'crossteam': {
        const r = (node.kind === 'crossteam' ? NODE.radiusCrossTeam : NODE.radiusProcess) + HIT_DETECTION.agentPadding;
        const dx = worldX - x;
        const dy = worldY - y;
        if (dx * dx + dy * dy <= r * r) {
          // Only override if no member/lead already hit
          if (!hit) hit = node.id;
        }
        break;
      }
    }
  }

  return hit;
}

const EDGE_HIT_PRIORITY: Record<GraphEdge['type'], number> = {
  blocking: 5,
  related: 4,
  message: 3,
  ownership: 2,
  'parent-child': 1,
};

function getEdgeHitRadius(edgeType: GraphEdge['type']): number {
  switch (edgeType) {
    case 'parent-child':
      return Math.max(BEAM.parentChild.startW, BEAM.parentChild.endW) * 0.5 + HIT_DETECTION.edgePadding;
    case 'ownership':
      return Math.max(BEAM.ownership.startW, BEAM.ownership.endW) * 0.5 + HIT_DETECTION.edgePadding;
    case 'blocking':
      return Math.max(BEAM.blocking.startW, BEAM.blocking.endW) * 0.5 + HIT_DETECTION.edgePadding;
    case 'related':
      return Math.max(BEAM.related.startW, BEAM.related.endW) * 0.5 + HIT_DETECTION.edgePadding;
    case 'message':
      return Math.max(BEAM.message.startW, BEAM.message.endW) * 0.5 + HIT_DETECTION.edgePadding;
  }
}

function distanceToSegmentSquared(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const dx = x2 - x1;
  const dy = y2 - y1;
  if (dx === 0 && dy === 0) {
    const ddx = px - x1;
    const ddy = py - y1;
    return ddx * ddx + ddy * ddy;
  }

  const t = Math.max(0, Math.min(1, ((px - x1) * dx + (py - y1) * dy) / (dx * dx + dy * dy)));
  const lx = x1 + dx * t;
  const ly = y1 + dy * t;
  const ddx = px - lx;
  const ddy = py - ly;
  return ddx * ddx + ddy * ddy;
}

function distanceToBezierSquared(
  px: number,
  py: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number
): number {
  const cp = computeControlPoints(x1, y1, x2, y2);
  let previous = { x: x1, y: y1 };
  let best = Number.POSITIVE_INFINITY;

  for (let segment = 1; segment <= 20; segment += 1) {
    const next = bezierPoint(x1, y1, cp, x2, y2, segment / 20);
    best = Math.min(best, distanceToSegmentSquared(px, py, previous.x, previous.y, next.x, next.y));
    previous = next;
  }

  return best;
}

function getBezierBounds(
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  padding: number
): { left: number; top: number; right: number; bottom: number } {
  const cp = computeControlPoints(x1, y1, x2, y2);
  const left = Math.min(x1, x2, cp.cp1x, cp.cp2x) - padding;
  const right = Math.max(x1, x2, cp.cp1x, cp.cp2x) + padding;
  const top = Math.min(y1, y2, cp.cp1y, cp.cp2y) - padding;
  const bottom = Math.max(y1, y2, cp.cp1y, cp.cp2y) + padding;
  return { left, top, right, bottom };
}

function boundsIntersect(
  left: number,
  top: number,
  right: number,
  bottom: number,
  other: { left: number; top: number; right: number; bottom: number }
): boolean {
  return left <= other.right && right >= other.left && top <= other.bottom && bottom >= other.top;
}

export function collectInteractiveEdgesInViewport(
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
  bounds: { left: number; top: number; right: number; bottom: number },
): GraphEdge[] {
  const candidates: GraphEdge[] = [];

  for (const edge of edges) {
    if (edge.type !== 'blocking') {
      continue;
    }

    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    if (source.x == null || source.y == null || target.x == null || target.y == null) continue;

    const edgeBounds = getBezierBounds(
      source.x,
      source.y,
      target.x,
      target.y,
      getEdgeHitRadius(edge.type) + 24
    );
    if (!boundsIntersect(edgeBounds.left, edgeBounds.top, edgeBounds.right, edgeBounds.bottom, bounds)) {
      continue;
    }

    candidates.push(edge);
  }

  return candidates;
}

export function findEdgeAt(
  worldX: number,
  worldY: number,
  edges: GraphEdge[],
  nodeMap: Map<string, GraphNode>,
): string | null {
  let bestHit: { id: string; distanceSquared: number; priority: number } | null = null;

  for (const edge of edges) {
    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    if (source.x == null || source.y == null || target.x == null || target.y == null) continue;

    const radius = getEdgeHitRadius(edge.type);
    const bounds = getBezierBounds(source.x, source.y, target.x, target.y, radius);
    if (
      worldX < bounds.left ||
      worldX > bounds.right ||
      worldY < bounds.top ||
      worldY > bounds.bottom
    ) {
      continue;
    }
    const distanceSquared = distanceToBezierSquared(
      worldX,
      worldY,
      source.x,
      source.y,
      target.x,
      target.y
    );
    if (distanceSquared > radius * radius) {
      continue;
    }

    const priority = EDGE_HIT_PRIORITY[edge.type];
    if (
      !bestHit ||
      distanceSquared < bestHit.distanceSquared ||
      (distanceSquared === bestHit.distanceSquared && priority > bestHit.priority)
    ) {
      bestHit = { id: edge.id, distanceSquared, priority };
    }
  }

  return bestHit?.id ?? null;
}

export function getEdgeMidpoint(
  edge: GraphEdge,
  nodeMap: Map<string, GraphNode>
): { x: number; y: number } | null {
  const source = nodeMap.get(edge.source);
  const target = nodeMap.get(edge.target);
  if (!source || !target) return null;
  if (source.x == null || source.y == null || target.x == null || target.y == null) return null;

  const cp = computeControlPoints(source.x, source.y, target.x, target.y);
  return bezierPoint(source.x, source.y, cp, target.x, target.y, 0.5);
}
