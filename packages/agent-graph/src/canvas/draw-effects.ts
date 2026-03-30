/**
 * Visual effects: spawn animation, completion shatter, spawn ring.
 * Adapted from agent-flow's draw-effects.ts (Apache 2.0).
 */

import { alphaHex } from '../constants/colors';
import { SPAWN_FX, COMPLETE_FX } from '../constants/canvas-constants';
import { drawHexagon } from './draw-misc';
import { hexWithAlpha } from './render-cache';

// ─── Effect Type ────────────────────────────────────────────────────────────

export interface VisualEffect {
  type: 'spawn' | 'complete' | 'shatter';
  x: number;
  y: number;
  color: string;
  age: number;
  duration: number;
  /** Node radius for scaling the effect */
  nodeRadius?: number;
  particles?: ShatterParticle[];
}

interface ShatterParticle {
  angle: number;
  speed: number;
  size: number;
}

/**
 * Create a spawn effect at position.
 */
export function createSpawnEffect(x: number, y: number, color: string, nodeRadius?: number): VisualEffect {
  return { type: 'spawn', x, y, color, age: 0, duration: 0.8, nodeRadius };
}

/**
 * Create a completion shatter effect at position.
 */
export function createCompleteEffect(x: number, y: number, color: string): VisualEffect {
  const particles: ShatterParticle[] = [];
  for (let i = 0; i < 12; i++) {
    particles.push({
      angle: (Math.PI * 2 * i) / 12 + (Math.random() - 0.5) * 0.3,
      speed: 30 + Math.random() * 60,
      size: 1 + Math.random() * 2,
    });
  }
  return { type: 'shatter', x, y, color, age: 0, duration: 0.8, particles };
}

// ─── Draw Effects ───────────────────────────────────────────────────────────

export function drawEffects(
  ctx: CanvasRenderingContext2D,
  effects: VisualEffect[],
): void {
  for (const fx of effects) {
    const progress = fx.age / fx.duration;
    if (progress >= 1) continue;

    switch (fx.type) {
      case 'spawn':
        drawSpawnEffect(ctx, fx, progress);
        break;
      case 'complete':
        drawCompleteEffect(ctx, fx, progress);
        break;
      case 'shatter':
        drawShatterEffect(ctx, fx, progress);
        break;
    }
  }
}

// ─── Spawn: expanding hex ring + white flash ────────────────────────────────

function drawSpawnEffect(ctx: CanvasRenderingContext2D, fx: VisualEffect, progress: number): void {
  const alpha = SPAWN_FX.maxAlpha * (1 - progress);
  const baseR = fx.nodeRadius ?? SPAWN_FX.ringStart;
  const ringR = baseR + SPAWN_FX.ringExpand * progress;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Expanding hex ring
  drawHexagon(ctx, fx.x, fx.y, ringR);
  ctx.strokeStyle = fx.color;
  ctx.lineWidth = 2 * (1 - progress);
  ctx.stroke();

  // Flash
  if (progress < SPAWN_FX.flashThreshold) {
    const flashProgress = progress / SPAWN_FX.flashThreshold;
    const flashR = SPAWN_FX.flashBaseRadius * (1 - flashProgress) + SPAWN_FX.flashMinRadius;
    ctx.fillStyle = '#ffffff' + alphaHex(SPAWN_FX.flashAlpha * (1 - flashProgress));
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, flashR, 0, Math.PI * 2);
    ctx.fill();
  }

  // Scatter particles
  for (let i = 0; i < SPAWN_FX.particleCount; i++) {
    const angle = (Math.PI * 2 * i) / SPAWN_FX.particleCount;
    const dist = ringR * 0.8 * progress;
    const px = fx.x + Math.cos(angle) * dist;
    const py = fx.y + Math.sin(angle) * dist;
    ctx.fillStyle = fx.color + alphaHex(alpha * 0.6);
    ctx.beginPath();
    ctx.arc(px, py, SPAWN_FX.particleSize * (1 - progress), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ─── Complete: white flash + expanding ring ─────────────────────────────────

function drawCompleteEffect(ctx: CanvasRenderingContext2D, fx: VisualEffect, progress: number): void {
  const alpha = COMPLETE_FX.maxAlpha * (1 - progress);
  const ringR = COMPLETE_FX.ringStart + COMPLETE_FX.ringExpand * progress;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Expanding ring
  ctx.beginPath();
  ctx.arc(fx.x, fx.y, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = fx.color;
  ctx.lineWidth = COMPLETE_FX.lineWidthMax * (1 - progress);
  ctx.stroke();

  // Flash
  if (progress < COMPLETE_FX.flashThreshold) {
    const flashAlpha = COMPLETE_FX.flashAlpha * (1 - progress / COMPLETE_FX.flashThreshold);
    ctx.fillStyle = '#ffffff' + alphaHex(flashAlpha);
    ctx.beginPath();
    ctx.arc(fx.x, fx.y, COMPLETE_FX.flashRadius * (1 - progress), 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ─── Shatter: particles scatter outward ─────────────────────────────────────

function drawShatterEffect(ctx: CanvasRenderingContext2D, fx: VisualEffect, progress: number): void {
  if (!fx.particles) return;

  const alpha = 1 - progress;
  ctx.save();
  ctx.globalAlpha = alpha;

  for (const p of fx.particles) {
    const dist = p.speed * progress;
    const px = fx.x + Math.cos(p.angle) * dist;
    const py = fx.y + Math.sin(p.angle) * dist;
    const size = p.size * (1 - progress * 0.5);

    // Glow
    const grad = ctx.createRadialGradient(px, py, 0, px, py, size * 3);
    grad.addColorStop(0, fx.color + alphaHex(alpha * 0.4));
    grad.addColorStop(1, hexWithAlpha(fx.color, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(px, py, size * 3, 0, Math.PI * 2);
    ctx.fill();

    // Core
    ctx.fillStyle = fx.color;
    ctx.beginPath();
    ctx.arc(px, py, size, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}
