/**
 * Utility drawing functions.
 * Adapted from agent-flow's draw-misc.ts (Apache 2.0).
 */

import { measureTextCached } from './render-cache';

/**
 * Truncate text to fit within maxWidth, appending "..." if needed.
 * Uses binary search for efficiency.
 */
export function truncateText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): string {
  if (measureTextCached(ctx, font, text) <= maxWidth) return text;

  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTextCached(ctx, font, text.slice(0, mid) + '...') <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo > 0 ? text.slice(0, lo) + '...' : '...';
}

function fitTextPrefix(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
): string {
  let lo = 0;
  let hi = text.length;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (measureTextCached(ctx, font, text.slice(0, mid)) <= maxWidth) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return text.slice(0, lo);
}

/**
 * Wrap text into a small fixed number of canvas lines.
 * The final line is truncated with "..." when the remaining text still overflows.
 */
export function wrapTextLines(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  font: string,
  maxLines: number,
): string[] {
  const normalized = text.trim().replace(/\s+/g, ' ');
  if (!normalized || maxLines <= 0) return [];
  if (maxLines === 1) return [truncateText(ctx, normalized, maxWidth, font)];

  const lines: string[] = [];
  let remaining = normalized;

  while (remaining && lines.length < maxLines) {
    if (measureTextCached(ctx, font, remaining) <= maxWidth) {
      lines.push(remaining);
      break;
    }

    if (lines.length === maxLines - 1) {
      lines.push(truncateText(ctx, remaining, maxWidth, font));
      break;
    }

    const prefix = fitTextPrefix(ctx, remaining, maxWidth, font).trimEnd();
    if (!prefix) {
      lines.push(truncateText(ctx, remaining, maxWidth, font));
      break;
    }

    const breakIndex = prefix.lastIndexOf(' ');
    const line = breakIndex > 0 ? prefix.slice(0, breakIndex) : prefix;
    lines.push(line);
    remaining = remaining.slice(line.length).trimStart();
  }

  return lines;
}

// Pre-computed hex vertex unit offsets (avoids cos/sin per call)
const HEX_COS: number[] = [];
const HEX_SIN: number[] = [];
for (let i = 0; i < 6; i++) {
  const angle = (Math.PI / 3) * i - Math.PI / 6;
  HEX_COS.push(Math.cos(angle));
  HEX_SIN.push(Math.sin(angle));
}

/**
 * Draw a regular hexagon path centered at (x, y) with given radius.
 */
export function drawHexagon(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  radius: number,
): void {
  ctx.beginPath();
  ctx.moveTo(x + radius * HEX_COS[0], y + radius * HEX_SIN[0]);
  ctx.lineTo(x + radius * HEX_COS[1], y + radius * HEX_SIN[1]);
  ctx.lineTo(x + radius * HEX_COS[2], y + radius * HEX_SIN[2]);
  ctx.lineTo(x + radius * HEX_COS[3], y + radius * HEX_SIN[3]);
  ctx.lineTo(x + radius * HEX_COS[4], y + radius * HEX_SIN[4]);
  ctx.lineTo(x + radius * HEX_COS[5], y + radius * HEX_SIN[5]);
  ctx.closePath();
}

/**
 * SVG path data for the Claude spark logo (256×256 viewbox).
 */
export const CLAUDE_SPARK_D =
  'M128,8C60.6,8,8,60.6,8,128s52.6,120,120,120s120-52.6,120-120S195.4,8,128,8z M161.6,169.6 c-4.8,8-16,10.8-24,6l-9.6-5.6l-9.6,5.6c-8,4.8-19.2,1.6-24-6c-4.8-8-1.6-19.2,6-24l9.6-5.6v-11.2l-9.6-5.6 c-8-4.8-10.8-16-6-24c4.8-8,16-10.8,24-6l9.6,5.6l9.6-5.6c8-4.8,19.2-1.6,24,6c4.8,8,1.6,19.2-6,24l-9.6,5.6v11.2l9.6,5.6 C163.2,150.4,166.4,161.6,161.6,169.6z';
