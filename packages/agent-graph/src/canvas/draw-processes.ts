/**
 * Process node rendering — small circles for running processes.
 * NEW — not from agent-flow.
 */

import type { GraphNode } from '../ports/types';
import { COLORS } from '../constants/colors';
import { NODE } from '../constants/canvas-constants';
import { hexWithAlpha, getGlowSprite } from './render-cache';

/**
 * Draw all process nodes as small circles.
 */
export function drawProcesses(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
  focusNodeIds?: ReadonlySet<string> | null,
  zoom = 1
): void {
  const simplify = zoom < 0.2;
  for (const node of nodes) {
    if (node.kind !== 'process') continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = NODE.radiusProcess;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    const focusOpacity = focusNodeIds && !focusNodeIds.has(node.id) ? 0.25 : 1;

    ctx.save();
    ctx.globalAlpha = 0.8 * focusOpacity;

    const procColor = node.color ?? COLORS.tool_calling;
    if (!simplify) {
      // Glow — use cached sprite instead of createRadialGradient per frame
      const glowSprite = getGlowSprite(procColor, r * 2, 0.19, 0);
      ctx.drawImage(glowSprite, x - r * 2, y - r * 2);
    }

    // Body
    ctx.beginPath();
    ctx.arc(x, y, r, 0, Math.PI * 2);
    ctx.fillStyle = isSelected ? COLORS.cardBgSelected : COLORS.cardBg;
    ctx.fill();
    ctx.strokeStyle = hexWithAlpha(procColor, 0.38);
    ctx.lineWidth = isSelected ? 2 : 1;
    ctx.stroke();

    if (!simplify) {
      // Spinning ring for active processes
      const spinAngle = time * 2;
      ctx.beginPath();
      ctx.arc(x, y, r + 3, spinAngle, spinAngle + Math.PI * 0.8);
      ctx.strokeStyle = hexWithAlpha(procColor, 0.38);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!simplify) {
      // Label
      ctx.font = '7px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'top';
      ctx.fillStyle = COLORS.textDim;
      const label = node.label.length > 12 ? node.label.slice(0, 12) + '...' : node.label;
      ctx.fillText(label, x, y + r + 4);
    }

    ctx.restore();
  }
}
