/**
 * Background rendering: depth star field + hex grid.
 * Adapted from agent-flow's background-layer.ts (Apache 2.0).
 */

import { COLORS, alphaHex } from '../constants/colors';
import { BACKGROUND } from '../constants/canvas-constants';

// ─── Depth Particle (star) ──────────────────────────────────────────────────

export interface DepthParticle {
  x: number;
  y: number;
  size: number;
  brightness: number;
  speed: number;
  depth: number;
}

export function createDepthParticles(w: number, h: number): DepthParticle[] {
  const particles: DepthParticle[] = [];
  for (let i = 0; i < BACKGROUND.starCount; i++) {
    particles.push({
      x: Math.random() * w,
      y: Math.random() * h,
      size: 0.3 + Math.random() * 1.2,
      brightness: 0.15 + Math.random() * 0.4,
      speed: 0.05 + Math.random() * 0.15,
      depth: Math.random(),
    });
  }
  return particles;
}

export function updateDepthParticles(
  particles: DepthParticle[],
  w: number,
  h: number,
  dt: number,
): void {
  for (const p of particles) {
    p.y += p.speed * dt * 20;
    if (p.y > h + 5) {
      p.y = -5;
      p.x = Math.random() * w;
    }
  }
}

// ─── Background Drawing ─────────────────────────────────────────────────────

/**
 * Draw the space background: void fill + depth stars + optional hex grid.
 */
export function drawBackground(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  particles: DepthParticle[],
  camera: { x: number; y: number; zoom: number },
  time: number,
  options?: { showHexGrid?: boolean; showStarField?: boolean },
): void {
  const showStars = options?.showStarField ?? true;
  const showHex = options?.showHexGrid ?? true;

  // Deep void background
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, w, h);

  // Depth star field
  if (showStars) {
    for (const p of particles) {
      const parallax = 1 - p.depth * 0.3;
      const sx = p.x + camera.x * parallax * 0.02;
      const sy = p.y + camera.y * parallax * 0.02;
      const twinkle = 0.7 + 0.3 * Math.sin(time * 2 + p.x * 0.01);
      const alpha = p.brightness * twinkle;

      ctx.fillStyle = COLORS.holoBright + alphaHex(alpha);
      ctx.beginPath();
      ctx.arc(
        ((sx % w) + w) % w,
        ((sy % h) + h) % h,
        p.size,
        0,
        Math.PI * 2,
      );
      ctx.fill();
    }
  }

  // Hex grid
  if (showHex) {
    drawHexGrid(ctx, w, h, camera, time);
  }
}

// ─── Hex Grid ───────────────────────────────────────────────────────────────

// Pre-computed hex vertex offsets
const HEX_OFFSETS: [number, number][] = [];
for (let i = 0; i < 6; i++) {
  const angle = (Math.PI / 3) * i - Math.PI / 6;
  HEX_OFFSETS.push([Math.cos(angle), Math.sin(angle)]);
}

function drawHexGrid(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  camera: { x: number; y: number; zoom: number },
  time: number,
): void {
  const size = BACKGROUND.hexSize;
  const pulse = BACKGROUND.hexAlpha * (0.5 + 0.5 * Math.sin(time * BACKGROUND.hexPulseSpeed));

  // Visible region in world space (expanded a bit for edge cells)
  const worldX0 = -camera.x / camera.zoom - size * 2;
  const worldY0 = -camera.y / camera.zoom - size * 2;
  const worldX1 = (w - camera.x) / camera.zoom + size * 2;
  const worldY1 = (h - camera.y) / camera.zoom + size * 2;

  const rowH = size * 1.5;
  const colW = size * Math.sqrt(3);

  const rowStart = Math.floor(worldY0 / rowH);
  const rowEnd = Math.ceil(worldY1 / rowH);
  const colStart = Math.floor(worldX0 / colW);
  const colEnd = Math.ceil(worldX1 / colW);

  ctx.save();
  ctx.translate(camera.x, camera.y);
  ctx.scale(camera.zoom, camera.zoom);

  ctx.strokeStyle = COLORS.hexGrid + alphaHex(pulse);
  ctx.lineWidth = 0.5 / camera.zoom;

  ctx.beginPath();
  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      const cx = col * colW + (row % 2 === 0 ? 0 : colW / 2);
      const cy = row * rowH;

      for (let i = 0; i < 6; i++) {
        const [ox, oy] = HEX_OFFSETS[i];
        const px = cx + ox * size;
        const py = cy + oy * size;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
    }
  }
  ctx.stroke();

  ctx.restore();
}
