/**
 * Particle animation along edges.
 * Adapted from agent-flow's draw-particles.ts (Apache 2.0).
 */

import type { GraphNode, GraphEdge, GraphParticle } from '../ports/types';
import { COLORS } from '../constants/colors';
import { PARTICLE_DRAW, BEAM } from '../constants/canvas-constants';
import { bezierPoint, computeControlPoints, type ControlPoints } from './draw-edges';
import { getGlowSprite, hexWithAlpha } from './render-cache';

/**
 * Build a lookup from edge.id → edge for fast particle→edge resolution.
 */
export function buildEdgeMap(edges: GraphEdge[]): Map<string, GraphEdge> {
  const map = new Map<string, GraphEdge>();
  for (const e of edges) map.set(e.id, e);
  return map;
}

/**
 * Draw all active particles along their edges.
 */
export function drawParticles(
  ctx: CanvasRenderingContext2D,
  particles: GraphParticle[],
  edgeMap: Map<string, GraphEdge>,
  nodeMap: Map<string, GraphNode>,
  time: number,
  focusEdgeIds?: ReadonlySet<string> | null,
): void {
  for (const p of particles) {
    if (focusEdgeIds && !focusEdgeIds.has(p.edgeId)) continue;
    const edge = edgeMap.get(p.edgeId);
    if (!edge) continue;

    const source = nodeMap.get(edge.source);
    const target = nodeMap.get(edge.target);
    if (!source || !target) continue;
    if (source.x == null || source.y == null || target.x == null || target.y == null) continue;

    // Reverse: swap source/target for particles going in opposite direction
    const from = p.reverse ? target : source;
    const to = p.reverse ? source : target;

    const cp = computeControlPoints(from.x!, from.y!, to.x!, to.y!);
    const color = p.color || COLORS.message;
    const baseSize = (p.size ?? 1) * 3;
    // Differentiate visual by particle kind
    const size = p.kind === 'spawn' ? baseSize * 1.5
      : p.kind === 'task_comment' ? baseSize * 1.15
      : p.kind === 'review_request' || p.kind === 'review_response' ? baseSize * 1.2
      : baseSize;

    // Wobble offset for organic look
    const phaseOffset = p.id.charCodeAt(Math.min(5, p.id.length - 1)) * 0.1;
    const wobbleAmp = BEAM.wobble.amp;

    drawParticleTrail(ctx, from, to, cp, p.progress, color, size, wobbleAmp, phaseOffset, time, p.kind);
    drawParticleCore(ctx, from, to, cp, p.progress, color, size, wobbleAmp, phaseOffset, time, p.kind);

    // Label
    if (p.label && p.progress > PARTICLE_DRAW.labelMinT && p.progress < PARTICLE_DRAW.labelMaxT) {
      const pos = getWobbledPosition(from, to, cp, p.progress, wobbleAmp, phaseOffset, time);
      ctx.font = `${PARTICLE_DRAW.labelFontSize}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillStyle = hexWithAlpha(color, 0.56);
      ctx.fillText(p.label, pos.x, pos.y + PARTICLE_DRAW.labelYOffset);
    }
  }
}

// ─── Private Helpers ────────────────────────────────────────────────────────

function getWobbledPosition(
  source: GraphNode,
  target: GraphNode,
  cp: ControlPoints,
  t: number,
  wobbleAmp: number,
  phaseOffset: number,
  time: number,
): { x: number; y: number } {
  const pos = bezierPoint(source.x!, source.y!, cp, target.x!, target.y!, t);

  // Perpendicular wobble
  const dt = 0.01;
  const tNext = Math.min(1, t + dt);
  const posNext = bezierPoint(source.x!, source.y!, cp, target.x!, target.y!, tNext);
  const dx = posNext.x - pos.x;
  const dy = posNext.y - pos.y;
  const len = Math.sqrt(dx * dx + dy * dy) || 1;
  const nx = -dy / len;
  const ny = dx / len;

  const wobble = Math.sin(t * BEAM.wobble.freq + time * BEAM.wobble.timeFreq + phaseOffset) * wobbleAmp;
  return {
    x: pos.x + nx * wobble,
    y: pos.y + ny * wobble,
  };
}

function drawParticleTrail(
  ctx: CanvasRenderingContext2D,
  source: GraphNode,
  target: GraphNode,
  cp: ControlPoints,
  progress: number,
  color: string,
  size: number,
  wobbleAmp: number,
  phaseOffset: number,
  time: number,
  kind: GraphParticle['kind'],
): void {
  const trailSegments = kind === 'task_comment' ? 4 : 6;
  const trailStep = BEAM.wobble.trailOffset / trailSegments;

  for (let i = trailSegments; i >= 1; i--) {
    const t = Math.max(0, progress - trailStep * i);
    const pos = getWobbledPosition(source, target, cp, t, wobbleAmp, phaseOffset, time);
    const alpha = (1 - i / trailSegments) * 0.3;
    const trailSize = size * (1 - i / trailSegments) * 0.5;

    if (kind === 'task_comment') {
      ctx.strokeStyle = hexWithAlpha(color, alpha);
      ctx.lineWidth = Math.max(0.8, trailSize * 0.45);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, trailSize * 1.15, 0, Math.PI * 2);
      ctx.stroke();
    } else {
      ctx.fillStyle = hexWithAlpha(color, alpha);
      ctx.beginPath();
      ctx.arc(pos.x, pos.y, trailSize, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

function drawParticleCore(
  ctx: CanvasRenderingContext2D,
  source: GraphNode,
  target: GraphNode,
  cp: ControlPoints,
  progress: number,
  color: string,
  size: number,
  wobbleAmp: number,
  phaseOffset: number,
  time: number,
  kind: GraphParticle['kind'],
): void {
  const pos = getWobbledPosition(source, target, cp, progress, wobbleAmp, phaseOffset, time);

  // Glow sprite
  const glowR = PARTICLE_DRAW.glowRadius;
  const sprite = getGlowSprite(color, glowR, kind === 'task_comment' ? 0.28 : 0.4, 0);
  ctx.drawImage(sprite, pos.x - glowR, pos.y - glowR);

  if (kind === 'task_comment') {
    drawCommentBubble(ctx, pos.x, pos.y, size, color);
    return;
  }

  // Core dot
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, size, 0, Math.PI * 2);
  ctx.fill();

  // Highlight
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(pos.x, pos.y, size * PARTICLE_DRAW.coreHighlightScale, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Draw a speech-bubble icon for comment particles.
 * Rounded rect body + small triangular tail at bottom-left.
 */
function drawCommentBubble(
  ctx: CanvasRenderingContext2D,
  cx: number,
  cy: number,
  size: number,
  color: string,
): void {
  const w = size * 2.4;
  const h = size * 1.8;
  const r = size * 0.4; // corner radius
  const x = cx - w / 2;
  const y = cy - h / 2;

  // Bubble body
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
  ctx.fill();

  // Tail (small triangle at bottom-left)
  const tailX = x + w * 0.25;
  const tailY = y + h;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY - 1);
  ctx.lineTo(tailX - size * 0.4, tailY + size * 0.5);
  ctx.lineTo(tailX + size * 0.4, tailY - 1);
  ctx.closePath();
  ctx.fill();

  // Inner dots (three small dots to suggest text)
  ctx.fillStyle = '#ffffff';
  const dotR = size * 0.18;
  const dotY = cy - size * 0.05;
  const gap = size * 0.5;
  for (let i = -1; i <= 1; i++) {
    ctx.beginPath();
    ctx.arc(cx + i * gap, dotY, dotR, 0, Math.PI * 2);
    ctx.fill();
  }
}
