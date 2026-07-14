/**
 * Task pill-shaped node rendering.
 * NEW — not from agent-flow. Custom renderer for our task nodes.
 */

import { ANIM, KANBAN_ZONE, MIN_VISIBLE_OPACITY, TASK_PILL } from '../constants/canvas-constants';
import { COLORS, getReviewStateColor, getTaskStatusColor } from '../constants/colors';

import { wrapTextLines } from './draw-misc';
import { drawPillShell } from './draw-pill-shell';
import { hexWithAlpha } from './render-cache';
import { shouldRenderTaskAtZoom } from './semantic-zoom';

import type { KanbanZoneInfo } from '../layout/kanbanLayout';
import type { GraphNode } from '../ports/types';

const KANBAN_HEADER_FONT = '600 10px monospace';
const KANBAN_HEADER_ALPHA = 0.92;
const KANBAN_HEADER_LETTER_SPACING = 2;

/**
 * Draw all task nodes as pill-shaped cards.
 */
export function drawTasks(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
  focusNodeIds?: ReadonlySet<string> | null,
  zoom = 1
): void {
  for (const node of nodes) {
    if (node.kind !== 'task') continue;

    const opacity = getTaskOpacity(node, focusNodeIds);
    if (opacity < MIN_VISIBLE_OPACITY) continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    if (!shouldRenderTaskAtZoom(zoom, isSelected || isHovered, node.taskZoomVisibility)) continue;

    ctx.save();
    ctx.globalAlpha = opacity;

    drawTaskPill(ctx, x, y, node, time, isSelected, isHovered);

    ctx.restore();
  }
}

// ─── Private ────────────────────────────────────────────────────────────────

function getTaskOpacity(node: GraphNode, focusNodeIds?: ReadonlySet<string> | null): number {
  if (node.taskStatus === 'deleted') return 0;
  if (focusNodeIds && !focusNodeIds.has(node.id)) return 0.25;
  return 1;
}

function drawTaskPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  node: GraphNode,
  time: number,
  isSelected: boolean,
  isHovered: boolean
): void {
  const w = TASK_PILL.width;
  const h = TASK_PILL.height;
  const r = TASK_PILL.borderRadius;
  const halfW = w / 2;
  const halfH = h / 2;

  const statusColor = getTaskStatusColor(node.taskStatus);
  const reviewColor = getReviewStateColor(node.reviewState);

  ctx.save();
  ctx.translate(x, y);

  if (node.isOverflowStack) {
    drawOverflowStack(ctx, halfW, r, node, time, isSelected, isHovered);
    ctx.restore();
    return;
  }

  // Pulse only for active work — completed + approved = static
  const needsAttention =
    (node.taskStatus === 'in_progress' && node.reviewState !== 'approved') ||
    node.reviewState === 'review' ||
    node.reviewState === 'needsFix' ||
    node.needsClarification != null;
  const isFinished = node.taskStatus === 'completed' || node.reviewState === 'approved';
  const breathe =
    needsAttention && !isFinished
      ? 1 + ANIM.breathe.activeAmp * Math.sin(time * ANIM.breathe.activeSpeed)
      : 1;
  const scale = breathe;

  ctx.scale(scale, scale);

  // Shadow — stronger for attention tasks, red for blocked
  ctx.shadowColor = node.isBlocked
    ? hexWithAlpha(COLORS.edgeBlocking, 0.3)
    : hexWithAlpha(statusColor, 0.25);
  ctx.shadowBlur = needsAttention || node.isBlocked ? 12 : 4;

  // Background fill
  drawPillShell(ctx, {
    width: w,
    height: h,
    radius: r,
    fillStyle: isSelected
      ? COLORS.cardBgSelected
      : isHovered
        ? 'rgba(15, 20, 40, 0.7)'
        : COLORS.cardBg,
    borderColor: node.isBlocked
      ? hexWithAlpha(COLORS.edgeBlocking, isSelected ? 0.9 : 0.7)
      : hexWithAlpha(statusColor, isSelected ? 0.8 : 0.5),
    borderWidth: node.isBlocked ? (isSelected ? 2.5 : 1.8) : isSelected ? 2 : 1,
    shadowColor: node.isBlocked
      ? hexWithAlpha(COLORS.edgeBlocking, 0.3)
      : hexWithAlpha(statusColor, 0.25),
    shadowBlur: needsAttention || node.isBlocked ? 12 : 4,
    accentColor: node.isBlocked ? hexWithAlpha(COLORS.edgeBlocking, 0.6) : undefined,
  });

  // Review state overlay border — pulsing for review/needsFix, STATIC for approved
  if (reviewColor !== 'transparent') {
    ctx.beginPath();
    ctx.roundRect(-halfW - 1, -halfH - 1, w + 2, h + 2, r + 1);
    const reviewAlpha = node.reviewState === 'approved' ? 0.6 : 0.5 + 0.3 * Math.sin(time * 3);
    ctx.strokeStyle = hexWithAlpha(reviewColor, reviewAlpha);
    ctx.lineWidth = 1.5;
    ctx.stroke();
  }

  // Clarification warning indicator
  if (node.needsClarification) {
    const pulseAlpha = 0.4 + 0.4 * Math.sin(time * 4);
    ctx.beginPath();
    ctx.roundRect(-halfW - 2, -halfH - 2, w + 4, h + 4, r + 2);
    ctx.strokeStyle = hexWithAlpha(COLORS.error, pulseAlpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  if (node.hasLiveTaskLogs) {
    drawLiveTaskLogIndicator(ctx, -halfW + 8, -halfH + 8, time);
  }

  // Subject (main title - up to two lines)
  let subjectLineCount = 0;
  if (node.sublabel) {
    ctx.font = `bold ${TASK_PILL.idFontSize}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.textPrimary;
    const textX = -halfW + 10;
    const hasReviewChip =
      node.reviewState !== 'approved' &&
      (node.reviewMode === 'manual' || (node.reviewMode === 'assigned' && !!node.reviewerName));
    const maxW = hasReviewChip ? w - 88 : w - 24;
    const subjectLines = wrapTextLines(ctx, node.sublabel, maxW, ctx.font, 2);
    subjectLineCount = subjectLines.length;
    const titleStartY = subjectLines.length > 1 ? -16 : -12;
    const titleLineHeight = TASK_PILL.idFontSize + 1.5;
    subjectLines.forEach((line, index) => {
      ctx.fillText(line, textX, titleStartY + index * titleLineHeight);
    });
  }

  // Display ID (secondary — small)
  const displayId = node.displayId ?? node.label;
  ctx.font = `${TASK_PILL.subjectFontSize}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(displayId, -halfW + 10, subjectLineCount > 1 ? 23 : 12);

  drawTaskProgressRail(ctx, halfW, halfH, node, time, statusColor);

  // Approved badge: checkmark at right side
  if (node.reviewState === 'approved') {
    ctx.font = 'bold 13px sans-serif';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.reviewApproved;
    ctx.fillText('\u2713', halfW - 8, 0); // ✓
  }

  if (
    node.reviewState !== 'approved' &&
    (node.reviewMode === 'manual' || (node.reviewMode === 'assigned' && node.reviewerName))
  ) {
    drawReviewChip(ctx, halfW, -halfH, node);
  }

  // Comment count badge — on the bottom-right border edge, 1.5x bigger
  if (node.totalCommentCount && node.totalCommentCount > 0) {
    const badgeX = halfW - 36;
    const badgeY = halfH - 30;

    // Speech bubble background
    const bw = 20;
    const bh = 15;
    ctx.fillStyle = hexWithAlpha('#aaeeff', 0.85);
    ctx.beginPath();
    ctx.roundRect(badgeX - bw / 2, badgeY - bh / 2, bw, bh, 3);
    ctx.fill();
    // Tail pointing up-left
    ctx.beginPath();
    ctx.moveTo(badgeX - 5, badgeY + bh / 2);
    ctx.lineTo(badgeX - 9, badgeY + bh / 2 + 5);
    ctx.lineTo(badgeX - 1, badgeY + bh / 2);
    ctx.closePath();
    ctx.fill();

    // Total count inside bubble
    ctx.font = 'bold 10px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#0a0f1e';
    ctx.fillText(String(node.totalCommentCount), badgeX, badgeY + 0.5);

    // Unread count badge (blue circle, top-right of bubble)
    if (node.unreadCommentCount && node.unreadCommentCount > 0) {
      const dotX = badgeX + bw / 2 + 1;
      const dotY = badgeY - bh / 2 - 1;
      ctx.fillStyle = '#3b82f6';
      ctx.beginPath();
      ctx.arc(dotX, dotY, 7, 0, Math.PI * 2);
      ctx.fill();
      ctx.font = 'bold 8px monospace';
      ctx.fillStyle = '#ffffff';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(node.unreadCommentCount), dotX, dotY + 0.5);
    }
  }

  ctx.restore();
}

function drawTaskProgressRail(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  node: GraphNode,
  time: number,
  statusColor: string
): void {
  const railWidth = halfW * 2 - 20;
  const railHeight = 2;
  const x = -halfW + 10;
  const y = halfH - 7;

  ctx.beginPath();
  ctx.roundRect(x, y, railWidth, railHeight, 1);
  ctx.fillStyle = 'rgba(92, 112, 142, 0.22)';
  ctx.fill();

  if (node.taskStatus === 'completed') {
    ctx.beginPath();
    ctx.roundRect(x, y, railWidth, railHeight, 1);
    ctx.fillStyle = hexWithAlpha(statusColor, 0.85);
    ctx.fill();
    return;
  }
  if (node.taskStatus !== 'in_progress') return;

  const segmentWidth = railWidth * 0.34;
  const travel = railWidth - segmentWidth;
  const progress = (time * 0.28) % 1;
  ctx.beginPath();
  ctx.roundRect(x + travel * progress, y, segmentWidth, railHeight, 1);
  ctx.fillStyle = hexWithAlpha(statusColor, 0.92);
  ctx.fill();
}

function drawLiveTaskLogIndicator(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  time: number,
  compact = false
): void {
  const coreRadius = compact ? 2.5 : 3.4;
  const glowRadius = compact ? 7 : 10;
  const pulse = 0.55 + 0.25 * Math.sin(time * 6);
  const color = COLORS.reviewApproved;

  const glow = ctx.createRadialGradient(x, y, 0, x, y, glowRadius);
  glow.addColorStop(0, hexWithAlpha(color, 0.35 + pulse * 0.28));
  glow.addColorStop(1, hexWithAlpha(color, 0));

  ctx.save();
  ctx.fillStyle = glow;
  ctx.beginPath();
  ctx.arc(x, y, glowRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = hexWithAlpha(color, 0.95);
  ctx.beginPath();
  ctx.arc(x, y, coreRadius, 0, Math.PI * 2);
  ctx.fill();

  ctx.strokeStyle = hexWithAlpha(color, pulse);
  ctx.lineWidth = compact ? 0.8 : 1;
  ctx.beginPath();
  ctx.arc(x, y, coreRadius + (compact ? 1.2 : 1.8), 0, Math.PI * 2);
  ctx.stroke();
  ctx.restore();
}

function drawOverflowStack(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  r: number,
  node: GraphNode,
  time: number,
  isSelected: boolean,
  isHovered: boolean
): void {
  const footerHeight = KANBAN_ZONE.overflowHeight;

  drawPillShell(ctx, {
    width: TASK_PILL.width,
    height: footerHeight,
    radius: Math.min(r, footerHeight / 2),
    fillStyle: isSelected
      ? COLORS.cardBgSelected
      : isHovered
        ? 'rgba(12, 20, 40, 0.78)'
        : 'rgba(8, 14, 28, 0.64)',
    borderColor: node.isBlocked
      ? hexWithAlpha(COLORS.edgeBlocking, isSelected ? 0.85 : 0.65)
      : isSelected
        ? hexWithAlpha(COLORS.holoBright, 0.45)
        : 'rgba(255, 255, 255, 0.10)',
    borderWidth: node.isBlocked ? (isSelected ? 2.4 : 1.5) : isSelected ? 1.5 : 1,
    accentColor: node.isBlocked ? hexWithAlpha(COLORS.edgeBlocking, 0.6) : undefined,
  });

  ctx.font = '600 11px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = '#cbd5e1';
  ctx.fillText(node.label, 0, 0.5);

  if (node.hasLiveTaskLogs) {
    drawLiveTaskLogIndicator(ctx, -halfW + 16, 0, time, true);
  }
}

function drawReviewChip(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  node: GraphNode
): void {
  const chipText = node.reviewMode === 'manual' ? 'REV' : (node.reviewerName ?? 'REV');
  const chipColor = node.reviewMode === 'manual' ? '#8b5cf6' : (node.reviewerColor ?? '#38bdf8');
  const chipX = halfW - 44;
  const chipY = halfH + 10;
  const chipW = 34;
  const chipH = 12;

  ctx.beginPath();
  ctx.roundRect(chipX, chipY, chipW, chipH, 6);
  ctx.fillStyle = hexWithAlpha(chipColor, 0.2);
  ctx.fill();
  ctx.strokeStyle = hexWithAlpha(chipColor, 0.55);
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexWithAlpha(chipColor, 0.95);
  ctx.fillText(
    chipText.length > 8 ? `${chipText.slice(0, 7)}…` : chipText,
    chipX + chipW / 2,
    chipY + chipH / 2 + 0.5
  );

  if (node.changePresence === 'has_changes') {
    ctx.beginPath();
    ctx.arc(chipX + chipW + 4, chipY + chipH / 2, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = '#38bdf8';
    ctx.fill();
  }
}

function measureSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  letterSpacing: number
): number {
  const chars = Array.from(text);
  const glyphWidth = chars.reduce((width, char) => width + ctx.measureText(char).width, 0);
  return glyphWidth + Math.max(0, chars.length - 1) * letterSpacing;
}

function drawCenteredSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number
): void {
  const chars = Array.from(text);
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let cursorX = x - measureSpacedText(ctx, text, letterSpacing) / 2;
  for (const char of chars) {
    ctx.fillText(char, cursorX, y);
    cursorX += ctx.measureText(char).width + letterSpacing;
  }
  ctx.textAlign = previousAlign;
}

function drawLeftSpacedText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  letterSpacing: number
): void {
  const chars = Array.from(text);
  const previousAlign = ctx.textAlign;
  ctx.textAlign = 'left';
  let cursorX = x;
  for (const char of chars) {
    ctx.fillText(char, cursorX, y);
    cursorX += ctx.measureText(char).width + letterSpacing;
  }
  ctx.textAlign = previousAlign;
}

/**
 * Draw kanban column headers above task columns.
 */
export function drawColumnHeaders(
  ctx: CanvasRenderingContext2D,
  zones: KanbanZoneInfo[],
  zoom = 1
): void {
  if (zoom < 0.22) return;
  for (const zone of zones) {
    // Section header for unassigned tasks — larger, centered above all columns
    if (zone.ownerId === '__unassigned__') {
      ctx.font = KANBAN_HEADER_FONT;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillStyle = hexWithAlpha(COLORS.taskPending, KANBAN_HEADER_ALPHA);
      const labelY = (zone.headers[0]?.y ?? zone.ownerY + 60) + 10;
      drawCenteredSpacedText(ctx, 'Unassigned', zone.ownerX, labelY, KANBAN_HEADER_LETTER_SPACING);

      continue;
    }

    for (const header of zone.headers) {
      ctx.font = KANBAN_HEADER_FONT;
      ctx.textAlign = 'left';
      ctx.textBaseline = 'top';
      ctx.fillStyle = hexWithAlpha(header.color, KANBAN_HEADER_ALPHA);
      drawLeftSpacedText(
        ctx,
        header.label,
        header.x - TASK_PILL.width / 2 + 4,
        header.y + 10,
        KANBAN_HEADER_LETTER_SPACING
      );
    }

    if (zone.emptyPlaceholder && zoom >= 0.35) {
      drawEmptyTaskPlaceholder(ctx, zone.emptyPlaceholder);
    }
  }
}

function drawEmptyTaskPlaceholder(
  ctx: CanvasRenderingContext2D,
  placeholder: NonNullable<KanbanZoneInfo['emptyPlaceholder']>
): void {
  const w = TASK_PILL.width;
  const h = 42;

  ctx.save();
  ctx.translate(placeholder.x, placeholder.y);
  drawPillShell(ctx, {
    width: w,
    height: h,
    radius: TASK_PILL.borderRadius,
    fillStyle: 'rgba(22, 30, 52, 0.46)',
    borderColor: hexWithAlpha(placeholder.color, 0.36),
    borderWidth: 1,
    shadowColor: 'rgba(15, 23, 42, 0.22)',
    shadowBlur: 10,
  });
  ctx.font = '600 11px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexWithAlpha(placeholder.color, 0.88);
  ctx.fillText(placeholder.label, 0, 0);
  ctx.restore();
}
