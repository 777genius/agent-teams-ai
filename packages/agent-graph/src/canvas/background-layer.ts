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
  twinkleOffset: number;
  twinkleSpeed: number;
  twinkleAmount: number;
  flickerOffset: number;
  flickerSpeed: number;
  flickerAmount: number;
  haloStrength: number;
}

export function createDepthParticles(w: number, h: number): DepthParticle[] {
  const particles: DepthParticle[] = [];
  for (let i = 0; i < BACKGROUND.starCount; i++) {
    particles.push(createDepthParticle(w, h));
  }
  return particles;
}

function createDepthParticle(w: number, h: number, spawnAbove = false): DepthParticle {
  const depth = Math.random();
  const sizeBias = Math.pow(Math.random(), 2.35);
  const size = 0.34 + sizeBias * 1.18 + (1 - depth) * 0.16;
  const brightness = 0.22 + sizeBias * 0.34 + (1 - depth) * 0.08;

  return {
    x: Math.random() * w,
    y: spawnAbove ? -8 - Math.random() * Math.max(12, h * 0.12) : Math.random() * h,
    size,
    brightness,
    speed: 0.04 + Math.random() * 0.09 + (1 - depth) * 0.04,
    depth,
    twinkleOffset: Math.random() * Math.PI * 2,
    twinkleSpeed: 0.18 + Math.random() * 0.4,
    twinkleAmount: 0.05 + Math.random() * 0.08,
    flickerOffset: Math.random() * Math.PI * 2,
    flickerSpeed: 0.9 + Math.random() * 2.2,
    flickerAmount: 0.015 + Math.random() * 0.04,
    haloStrength: 0.08 + Math.random() * 0.14,
  };
}

export function updateDepthParticles(
  particles: DepthParticle[],
  w: number,
  h: number,
  dt: number
): void {
  for (const p of particles) {
    p.y += p.speed * dt * 20;
    if (p.y > h + 5) {
      Object.assign(p, createDepthParticle(w, h, true));
    }
  }
}

// ─── Shooting Stars ────────────────────────────────────────────────────────

export interface ShootingStar {
  x: number;
  y: number;
  vx: number;
  vy: number;
  travel: number;
  maxTravel: number;
  length: number;
  thickness: number;
  brightness: number;
}

export interface ShootingStarField {
  active: ShootingStar[];
  spawnCooldown: number;
}

export function createShootingStarField(): ShootingStarField {
  return {
    active: [],
    spawnCooldown: randomShootingStarCooldown(),
  };
}

export function updateShootingStarField(
  field: ShootingStarField,
  w: number,
  h: number,
  dt: number
): void {
  field.spawnCooldown -= dt;
  if (field.spawnCooldown <= 0 && field.active.length < 1) {
    field.active.push(createShootingStar(w, h));
    field.spawnCooldown = randomShootingStarCooldown();
  }

  for (let i = field.active.length - 1; i >= 0; i--) {
    const star = field.active[i];
    star.travel += Math.hypot(star.vx, star.vy) * dt;
    star.x += star.vx * dt;
    star.y += star.vy * dt;

    if (star.travel >= star.maxTravel) {
      field.active.splice(i, 1);
    }
  }
}

function createShootingStar(w: number, h: number): ShootingStar {
  const margin = 60;
  const sizeBias = Math.pow(Math.random(), 1.9);
  const sizeScale = 0.68 + sizeBias * 0.92;
  const { x, y, angle } = createShootingStarSpawn(w, h, margin);
  const speed = 58 + sizeScale * 18 + Math.random() * 10;
  const vx = Math.cos(angle) * speed;
  const vy = Math.sin(angle) * speed;
  const maxTravel = speed * computeShootingStarExitTime(x, y, vx, vy, w, h, margin + 28);

  return {
    x,
    y,
    vx,
    vy,
    travel: 0,
    maxTravel,
    length: 14 + sizeScale * (10 + Math.random() * 8),
    thickness: 0.34 + sizeScale * 0.34,
    brightness: 0.14 + sizeScale * 0.09 + Math.random() * 0.03,
  };
}

function randomShootingStarCooldown(): number {
  return 16 + Math.random() * 14;
}

function createShootingStarSpawn(
  w: number,
  h: number,
  margin: number
): { x: number; y: number; angle: number } {
  const edgeOffset = Math.random() * Math.max(24, Math.min(w, h) * 0.06);
  const variant = Math.floor(Math.random() * 4);

  switch (variant) {
    case 0:
      return {
        x: w + margin + edgeOffset,
        y: h * (0.06 + Math.random() * 0.22),
        angle: Math.PI - (0.3 + Math.random() * 0.12),
      };
    case 1:
      return {
        x: -margin - edgeOffset,
        y: h * (0.06 + Math.random() * 0.22),
        angle: 0.3 + Math.random() * 0.12,
      };
    case 2:
      return {
        x: w * (0.08 + Math.random() * 0.34),
        y: -margin - edgeOffset,
        angle: 0.96 + Math.random() * 0.18,
      };
    default:
      return {
        x: w * (0.58 + Math.random() * 0.34),
        y: -margin - edgeOffset,
        angle: Math.PI - (0.96 + Math.random() * 0.18),
      };
  }
}

function computeShootingStarExitTime(
  x: number,
  y: number,
  vx: number,
  vy: number,
  w: number,
  h: number,
  margin: number
): number {
  const exitTimes: number[] = [];

  if (vx > 0.001) {
    exitTimes.push((w + margin - x) / vx);
  } else if (vx < -0.001) {
    exitTimes.push((-margin - x) / vx);
  }

  if (vy > 0.001) {
    exitTimes.push((h + margin - y) / vy);
  } else if (vy < -0.001) {
    exitTimes.push((-margin - y) / vy);
  }

  const positiveExitTimes = exitTimes.filter((time) => time > 0);
  return Math.max(positiveExitTimes.length > 0 ? Math.min(...positiveExitTimes) : 0.001, 0.001);
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
  shootingStars: ShootingStarField,
  camera: { x: number; y: number; zoom: number },
  time: number,
  options?: { showHexGrid?: boolean; showStarField?: boolean }
): void {
  const showStars = options?.showStarField ?? true;
  const showHex = options?.showHexGrid ?? true;

  // Deep void background
  ctx.fillStyle = COLORS.void;
  ctx.fillRect(0, 0, w, h);

  // Depth star field
  if (showStars) {
    const centerX = w * 0.5;
    const centerY = h * 0.5;

    for (const p of particles) {
      const parallax = 1.06 - p.depth * 0.5;
      const sx = p.x + camera.x * parallax * 0.068;
      const sy = p.y + camera.y * parallax * 0.068;
      const positionScale = getStarPositionScale(camera.zoom, p.depth);
      const starX = projectZoomedWrappedCoord(sx, w, centerX, positionScale);
      const starY = projectZoomedWrappedCoord(sy, h, centerY, positionScale);
      const primaryTwinkle = Math.sin(time * p.twinkleSpeed + p.twinkleOffset) * p.twinkleAmount;
      const secondaryTwinkle = Math.sin(time * p.flickerSpeed + p.flickerOffset) * p.flickerAmount;
      const twinkle = clamp(1 + primaryTwinkle + secondaryTwinkle, 0.82, 1.22);
      const zoomScale = getStarZoomScale(camera.zoom, p.depth);
      const alpha = p.brightness * twinkle * (0.98 + (zoomScale - 1) * 0.35) * 0.52;
      drawDepthParticle(ctx, starX, starY, p, alpha, zoomScale, twinkle);
    }
  }

  // Hex grid
  if (showHex) {
    drawHexGrid(ctx, w, h, camera, time);
  }

  if (showStars) {
    for (const shootingStar of shootingStars.active) {
      drawShootingStar(ctx, shootingStar);
    }
  }
}

function drawDepthParticle(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  particle: DepthParticle,
  alpha: number,
  zoomScale: number,
  twinkle: number
): void {
  const size = Math.max(0.68, particle.size * zoomScale * (0.985 + (twinkle - 1) * 0.22));
  const coreRadius = Math.max(0.48, size * (0.48 + (twinkle - 1) * 0.08));
  const coreAlpha = clamp(Math.min(1, alpha * 1.08 + 0.04), 0.16, 0.72);

  if (size > 0.8) {
    const glowRadius = size * (1.45 + particle.haloStrength * 0.8);
    const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
    glow.addColorStop(0, COLORS.holoHot + alphaHex(coreAlpha * particle.haloStrength * 0.72));
    glow.addColorStop(0.42, COLORS.holoBright + alphaHex(coreAlpha * particle.haloStrength * 0.34));
    glow.addColorStop(1, COLORS.holoBright + alphaHex(0));
    ctx.fillStyle = glow;
    ctx.beginPath();
    ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.fillStyle = COLORS.holoBright + alphaHex(coreAlpha * 0.12);
  ctx.beginPath();
  ctx.arc(x, y, coreRadius * 1.7, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.holoHot + alphaHex(coreAlpha);
  ctx.beginPath();
  ctx.arc(x, y, coreRadius, 0, Math.PI * 2);
  ctx.fill();
}

function drawShootingStar(ctx: CanvasRenderingContext2D, shootingStar: ShootingStar): void {
  const progress = clamp01(shootingStar.travel / Math.max(shootingStar.maxTravel, 0.001));
  const fadeIn = clamp01(progress / 0.06);
  const alpha = shootingStar.brightness * fadeIn;
  if (alpha <= 0) return;

  const speed = Math.hypot(shootingStar.vx, shootingStar.vy) || 1;
  const dirX = shootingStar.vx / speed;
  const dirY = shootingStar.vy / speed;
  const tailX = shootingStar.x - dirX * shootingStar.length;
  const tailY = shootingStar.y - dirY * shootingStar.length;

  const trailGradient = ctx.createLinearGradient(shootingStar.x, shootingStar.y, tailX, tailY);
  trailGradient.addColorStop(0, COLORS.holoHot + alphaHex(alpha));
  trailGradient.addColorStop(0.24, COLORS.holoBright + alphaHex(alpha * 0.28));
  trailGradient.addColorStop(1, COLORS.holoBright + alphaHex(0));

  ctx.save();
  ctx.globalCompositeOperation = 'screen';
  ctx.lineCap = 'round';
  ctx.strokeStyle = COLORS.holoBright + alphaHex(alpha * 0.1);
  ctx.lineWidth = shootingStar.thickness * 2.1;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(shootingStar.x, shootingStar.y);
  ctx.stroke();

  ctx.strokeStyle = trailGradient;
  ctx.lineWidth = shootingStar.thickness;
  ctx.beginPath();
  ctx.moveTo(tailX, tailY);
  ctx.lineTo(shootingStar.x, shootingStar.y);
  ctx.stroke();

  const glowRadius = shootingStar.thickness * 3.4;
  const headGlow = ctx.createRadialGradient(
    shootingStar.x,
    shootingStar.y,
    0,
    shootingStar.x,
    shootingStar.y,
    glowRadius
  );
  headGlow.addColorStop(0, COLORS.holoHot + alphaHex(alpha * 0.34));
  headGlow.addColorStop(0.4, COLORS.holoBright + alphaHex(alpha * 0.12));
  headGlow.addColorStop(1, COLORS.holoBright + alphaHex(0));
  ctx.fillStyle = headGlow;
  ctx.beginPath();
  ctx.arc(shootingStar.x, shootingStar.y, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = COLORS.holoHot + alphaHex(Math.min(1, alpha * 1.3 + 0.06));
  ctx.beginPath();
  ctx.arc(
    shootingStar.x,
    shootingStar.y,
    Math.max(0.52, shootingStar.thickness * 0.7),
    0,
    Math.PI * 2
  );
  ctx.fill();
  ctx.restore();
}

function clamp01(value: number): number {
  return Math.max(0, Math.min(1, value));
}

function getStarZoomScale(zoom: number, depth: number): number {
  const zoomDelta = clamp(zoom, 0.45, 2.2) - 1;
  const influence = 0.03 + (1 - depth) * 0.03;
  return clamp(1 + zoomDelta * influence, 0.96, 1.07);
}

function getStarPositionScale(zoom: number, depth: number): number {
  const zoomDelta = clamp(zoom, 0.45, 2.2) - 1;
  const influence = 0.075 + (1 - depth) * 0.075;
  return clamp(1 + zoomDelta * influence, 0.86, 1.18);
}

function projectZoomedWrappedCoord(
  value: number,
  size: number,
  center: number,
  scale: number
): number {
  const repeatSize = size / Math.max(scale, 0.0001);
  const repeatOffset = center - repeatSize * 0.5;
  const normalized = wrapCoord(value - repeatOffset, repeatSize) + repeatOffset;
  return wrapCoord(center + (normalized - center) * scale, size);
}

function wrapCoord(value: number, size: number): number {
  return ((value % size) + size) % size;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
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
  time: number
): void {
  const lodScale =
    camera.zoom < 0.24
      ? 0
      : camera.zoom < 0.34
        ? 4
        : camera.zoom < 0.46
          ? 3
          : camera.zoom < 0.62
            ? 2
            : 1;
  if (lodScale === 0) return;

  const zoomFade = clamp((camera.zoom - 0.22) / 0.4, 0, 1);
  const size = BACKGROUND.hexSize * lodScale;
  const pulse =
    BACKGROUND.hexAlpha * zoomFade * (0.5 + 0.5 * Math.sin(time * BACKGROUND.hexPulseSpeed));

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
