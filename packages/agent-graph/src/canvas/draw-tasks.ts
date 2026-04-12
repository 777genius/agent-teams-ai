/**
 * Task pill-shaped node rendering.
 * NEW — not from agent-flow. Custom renderer for our task nodes.
 */

import type { GraphNode } from '../ports/types';
import { COLORS, getTaskStatusColor, getReviewStateColor } from '../constants/colors';
import { TASK_PILL, MIN_VISIBLE_OPACITY, ANIM } from '../constants/canvas-constants';
import { truncateText } from './draw-misc';
import { hexWithAlpha } from './render-cache';
import type { KanbanZoneInfo } from '../layout/kanbanLayout';

/**
 * Draw all task nodes as pill-shaped cards.
 */
export function drawTasks(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
  focusNodeIds?: ReadonlySet<string> | null
): void {
  for (const node of nodes) {
    if (node.kind !== 'task') continue;

    const opacity = getTaskOpacity(node, focusNodeIds);
    if (opacity < MIN_VISIBLE_OPACITY) continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;

    ctx.save();
    ctx.globalAlpha = opacity;

    drawTaskPill(ctx, x, y, node, time, isSelected, isHovered);

    ctx.restore();
  }
}

// ─── Private ────────────────────────────────────────────────────────────────

function getTaskOpacity(
  node: GraphNode,
  focusNodeIds?: ReadonlySet<string> | null
): number {
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
    drawOverflowStack(ctx, halfW, halfH, r, node, isSelected, isHovered);
    ctx.restore();
    return;
  }

  // Pulse only for active work — completed + approved = static
  const needsAttention =
    (node.taskStatus === 'in_progress' && node.reviewState !== 'approved') ||
    node.reviewState === 'review' ||
    node.reviewState === 'needsFix' ||
    (node.needsClarification != null);
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
  ctx.beginPath();
  ctx.roundRect(-halfW, -halfH, w, h, r);
  ctx.fillStyle = isSelected
    ? COLORS.cardBgSelected
    : isHovered
      ? 'rgba(15, 20, 40, 0.7)'
      : COLORS.cardBg;
  ctx.fill();
  ctx.shadowBlur = 0;

  // Border — red for blocked tasks
  ctx.beginPath();
  ctx.roundRect(-halfW, -halfH, w, h, r);
  if (node.isBlocked) {
    ctx.strokeStyle = hexWithAlpha(COLORS.edgeBlocking, isSelected ? 0.9 : 0.7);
    ctx.lineWidth = isSelected ? 2.5 : 1.8;
  } else {
    ctx.strokeStyle = hexWithAlpha(statusColor, isSelected ? 0.8 : 0.5);
    ctx.lineWidth = isSelected ? 2 : 1;
  }
  ctx.stroke();

  // Blocked indicator — red left stripe
  if (node.isBlocked) {
    ctx.fillStyle = hexWithAlpha(COLORS.edgeBlocking, 0.6);
    ctx.beginPath();
    ctx.roundRect(-halfW, -halfH, 4, h, [r, 0, 0, r]);
    ctx.fill();
  }

  // Review state overlay border — pulsing for review/needsFix, STATIC for approved
  if (reviewColor !== 'transparent') {
    ctx.beginPath();
    ctx.roundRect(-halfW - 1, -halfH - 1, w + 2, h + 2, r + 1);
    const reviewAlpha =
      node.reviewState === 'approved'
        ? 0.6
        : 0.5 + 0.3 * Math.sin(time * 3);
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

  // Subject (main title — large)
  if (node.sublabel) {
    ctx.font = `bold ${TASK_PILL.idFontSize}px sans-serif`;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = COLORS.textPrimary;
    const textX = -halfW + 10;
    const hasReviewChip =
      node.reviewState !== 'approved' &&
      (node.reviewMode === 'manual' || (node.reviewMode === 'assigned' && !!node.reviewerName));
    const maxW = hasReviewChip ? w - 64 : w - 18;
    const subject = truncateText(ctx, node.sublabel, maxW, ctx.font);
    ctx.fillText(subject, textX, -4);
  }

  // Display ID (secondary — small)
  const displayId = node.displayId ?? node.label;
  ctx.font = `${TASK_PILL.subjectFontSize}px monospace`;
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText(displayId, -halfW + 10, 8);

  // Approved badge: checkmark at right side
  if (node.reviewState === 'approved') {
    ctx.font = 'bold 11px sans-serif';
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
    const badgeX = halfW - 6;
    const badgeY = halfH;

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

function drawOverflowStack(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  r: number,
  node: GraphNode,
  isSelected: boolean,
  isHovered: boolean
): void {
  for (const [offset, alpha] of [
    [6, 0.18],
    [3, 0.28],
  ] as const) {
    ctx.beginPath();
    ctx.roundRect(-halfW + offset, -halfH - offset, TASK_PILL.width, TASK_PILL.height, r);
    ctx.fillStyle = hexWithAlpha('#334155', alpha);
    ctx.fill();
  }

  ctx.beginPath();
  ctx.roundRect(-halfW, -halfH, TASK_PILL.width, TASK_PILL.height, r);
  ctx.fillStyle = isSelected
    ? COLORS.cardBgSelected
    : isHovered
      ? 'rgba(15, 20, 40, 0.78)'
      : COLORS.cardBg;
  ctx.fill();
  ctx.strokeStyle = hexWithAlpha(COLORS.taskPending, isSelected ? 0.85 : 0.55);
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.stroke();

  ctx.font = 'bold 12px sans-serif';
  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.textPrimary;
  ctx.fillText(node.label, -halfW + 12, -2);

  ctx.font = '7px monospace';
  ctx.fillStyle = COLORS.textDim;
  ctx.fillText('more tasks', -halfW + 12, 10);
}

function drawReviewChip(
  ctx: CanvasRenderingContext2D,
  halfW: number,
  halfH: number,
  node: GraphNode
): void {
  const chipText = node.reviewMode === 'manual' ? 'REV' : node.reviewerName ?? 'REV';
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

/**
 * Draw kanban column headers above task columns.
 */
export function drawColumnHeaders(
  ctx: CanvasRenderingContext2D,
  zones: KanbanZoneInfo[]
): void {
  for (const zone of zones) {
    // Section header for unassigned tasks — larger, centered above all columns
    if (zone.ownerId === '__unassigned__') {
      ctx.font = 'bold 10px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = hexWithAlpha(COLORS.taskPending, 0.5);
      const labelY = (zone.headers[0]?.y ?? zone.ownerY + 60) - 16;
      ctx.fillText('Unassigned', zone.ownerX, labelY);

      // Overflow badge
      for (const header of zone.headers) {
        if (header.overflowCount > 0) {
          ctx.font = '7px monospace';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'top';
          ctx.fillStyle = hexWithAlpha(header.color, 0.45);
          ctx.fillText(`+${header.overflowCount} more`, header.x, header.overflowY + 4);
        }
      }
      continue;
    }

    for (const header of zone.headers) {
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'bottom';
      ctx.fillStyle = hexWithAlpha(header.color, 0.6);
      ctx.fillText(header.label, header.x, header.y - 2);

      // Overflow badge: "+N more"
      if (header.overflowCount > 0) {
        const badgeText = `+${header.overflowCount} more`;
        ctx.font = '7px monospace';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        ctx.fillStyle = hexWithAlpha(header.color, 0.45);
        ctx.fillText(badgeText, header.x, header.overflowY + 4);
      }
    }
  }
}
