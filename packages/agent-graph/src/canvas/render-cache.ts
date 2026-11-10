/**
 * Pre-rendered sprite cache for Canvas 2D glow effects.
 * Adapted from agent-flow (Apache 2.0).
 */

const glowCache = new Map<string, HTMLCanvasElement>();
const textCache = new Map<string, number>();
const TEXT_CACHE_LIMIT = 2000;

// ─── Color resolution: named colors → hex ───────────────────────────────────

let _resolverCtx: CanvasRenderingContext2D | null = null;
const _hexCache = new Map<string, string>();

/**
 * Ensure a color string is in #rrggbb hex format.
 * Resolves CSS named colors (purple → #800080), shorthand (#abc → #aabbcc).
 */
function ensureHex(color: string): string {
  if (color.startsWith('#') && color.length === 7) return color;

  let hex = _hexCache.get(color);
  if (hex) return hex;

  if (color.startsWith('#') && color.length === 4) {
    hex = `#${color[1]}${color[1]}${color[2]}${color[2]}${color[3]}${color[3]}`;
  } else {
    // Resolve named/rgb/hsl colors via canvas
    _resolverCtx ??= document.createElement('canvas').getContext('2d')!;
    _resolverCtx.fillStyle = '#000000';
    _resolverCtx.fillStyle = color;
    hex = _resolverCtx.fillStyle; // always returns #rrggbb
  }

  _hexCache.set(color, hex);
  return hex;
}

/** Build a hex color with alpha: "#rrggbbaa" — cached for repeated calls */
const _hexAlphaCache = new Map<string, string>();
function hexWithAlpha(color: string, alpha: number): string {
  // Quantize alpha to 1/255 steps for cache hit rate
  const a = Math.round(Math.max(0, Math.min(1, alpha)) * 255);
  const key = `${color}|${a}`;
  let result = _hexAlphaCache.get(key);
  if (result) return result;
  result = ensureHex(color) + alphaHex(a / 255);
  _hexAlphaCache.set(key, result);
  if (_hexAlphaCache.size > 500) _hexAlphaCache.clear(); // prevent unbounded growth
  return result;
}

// Reuse alpha hex LUT from colors.ts (DRY — single source)
import { alphaHex } from '../constants/colors';

// ─── Glow Sprite Cache ──────────────────────────────────────────────────────

/**
 * Get or create a pre-rendered radial gradient glow sprite.
 */
export function getGlowSprite(
  color: string,
  radius: number,
  innerAlpha: number,
  outerAlpha: number,
): HTMLCanvasElement {
  const hex = ensureHex(color);
  const key = `${hex}|${radius}|${innerAlpha}|${outerAlpha}`;
  let canvas = glowCache.get(key);
  if (canvas) return canvas;

  const size = Math.ceil(radius * 2);
  canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;

  const grad = ctx.createRadialGradient(cx, cx, 0, cx, cx, radius);
  grad.addColorStop(0, hexWithAlpha(hex, innerAlpha));
  grad.addColorStop(1, hexWithAlpha(hex, outerAlpha));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  glowCache.set(key, canvas);
  return canvas;
}

/**
 * Get or create a pre-rendered agent glow sprite (inner + outer radius).
 */
export function getAgentGlowSprite(
  color: string,
  innerRadius: number,
  outerRadius: number,
): HTMLCanvasElement {
  const hex = ensureHex(color);
  const key = `agent|${hex}|${innerRadius}|${outerRadius}`;
  let canvas = glowCache.get(key);
  if (canvas) return canvas;

  const size = Math.ceil(outerRadius * 2);
  canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const cx = size / 2;

  const grad = ctx.createRadialGradient(cx, cx, innerRadius, cx, cx, outerRadius);
  grad.addColorStop(0, hexWithAlpha(hex, 0.25));
  grad.addColorStop(0.5, hexWithAlpha(hex, 0.08));
  grad.addColorStop(1, hexWithAlpha(hex, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(0, 0, size, size);

  glowCache.set(key, canvas);
  return canvas;
}

/**
 * Cached text width measurement.
 */
export function measureTextCached(ctx: CanvasRenderingContext2D, font: string, text: string): number {
  const key = `${font}|${text}`;
  let w = textCache.get(key);
  if (w !== undefined) return w;

  if (textCache.size > TEXT_CACHE_LIMIT) textCache.clear();

  const prevFont = ctx.font;
  ctx.font = font;
  w = ctx.measureText(text).width;
  ctx.font = prevFont;
  textCache.set(key, w);
  return w;
}

/** Exported for use by draw functions that need hex+alpha colors */
export { ensureHex, hexWithAlpha };
