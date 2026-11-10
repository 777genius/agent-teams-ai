import { COLORS } from '../constants/colors';
import { MIN_VISIBLE_OPACITY, TASK_PILL } from '../constants/canvas-constants';
import {
  ACTIVITY_LANE,
  getActivityAnchorTarget,
  getActivityLaneBounds,
  getVisibleActivityWindow,
  isActivityOwner,
  resolveActivityLaneSide,
} from '../layout/activityLane';
import type { GraphActivityItem, GraphNode } from '../ports/types';
import { truncateText } from './draw-misc';
import { drawPillShell } from './draw-pill-shell';
import { hexWithAlpha, measureTextCached } from './render-cache';

export function drawActivityLanes(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  selectedNodeId: string | null,
  hoveredNodeId: string | null,
  focusNodeIds?: ReadonlySet<string> | null,
  zoom = 1
): void {
  if (zoom < 0.16) {
    return;
  }

  const leadNode = nodes.find((node) => node.kind === 'lead' && node.x != null);
  const leadX = leadNode?.x ?? null;

  for (const node of nodes) {
    if (!isActivityOwner(node) || node.x == null || node.y == null) {
      continue;
    }

    const opacity = getLaneOpacity(node, focusNodeIds);
    if (opacity < MIN_VISIBLE_OPACITY) {
      continue;
    }

    const window = getVisibleActivityWindow(node.activityItems);
    const overflowCount = node.activityOverflowCount ?? window.overflowCount;
    if (window.items.length === 0 && overflowCount <= 0) {
      continue;
    }

    const anchor = getActivityAnchorTarget({
      nodeX: node.x,
      nodeY: node.y,
      nodeKind: node.kind,
      leadX,
    });
    const bounds = getActivityLaneBounds(anchor.x, anchor.y);
    const left = bounds.left;
    const top = bounds.top;
    const side = resolveActivityLaneSide({
      nodeKind: node.kind,
      nodeX: node.x,
      leadX,
    });

    ctx.save();
    ctx.globalAlpha = opacity;

    drawLaneHeader(ctx, side, left, top);

    const itemsTop = top + ACTIVITY_LANE.headerHeight;
    for (let index = 0; index < window.items.length; index += 1) {
      const itemTop = itemsTop + index * ACTIVITY_LANE.rowHeight;
      drawActivityPill(ctx, {
        item: window.items[index],
        x: left + ACTIVITY_LANE.width / 2,
        y: itemTop + ACTIVITY_LANE.itemHeight / 2,
        isOwnerSelected: node.id === selectedNodeId,
        isOwnerHovered: node.id === hoveredNodeId,
      });
    }

    if (overflowCount > 0) {
      const overflowTop = itemsTop + window.items.length * ACTIVITY_LANE.rowHeight;
      drawOverflowPill(
        ctx,
        left + ACTIVITY_LANE.width / 2,
        overflowTop + ACTIVITY_LANE.overflowHeight / 2,
        overflowCount
      );
    }

    ctx.restore();
  }
}

function getLaneOpacity(node: GraphNode, focusNodeIds?: ReadonlySet<string> | null): number {
  if (focusNodeIds && !focusNodeIds.has(node.id)) {
    return 0.25;
  }
  return 1;
}

function drawLaneHeader(
  ctx: CanvasRenderingContext2D,
  side: 'left' | 'right',
  left: number,
  top: number
): void {
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = side === 'left' ? 'right' : 'left';
  ctx.textBaseline = 'top';
  ctx.fillStyle = hexWithAlpha(COLORS.holoBright, 0.46);
  ctx.fillText('Activity', side === 'left' ? left + ACTIVITY_LANE.width : left, top);
}

function drawActivityPill(
  ctx: CanvasRenderingContext2D,
  params: {
    item: GraphActivityItem;
    x: number;
    y: number;
    isOwnerSelected: boolean;
    isOwnerHovered: boolean;
  }
): void {
  const { item, x, y, isOwnerSelected, isOwnerHovered } = params;
  const accent = getActivityAccentColor(item.kind);
  const badgeText = getActivityBadgeText(item.kind);

  ctx.save();
  ctx.translate(x, y);

  drawPillShell(ctx, {
    width: ACTIVITY_LANE.width,
    height: ACTIVITY_LANE.itemHeight,
    radius: TASK_PILL.borderRadius,
    fillStyle: isOwnerSelected
      ? COLORS.cardBgSelected
      : isOwnerHovered
        ? 'rgba(15, 20, 40, 0.72)'
        : COLORS.cardBg,
    borderColor: hexWithAlpha(accent, isOwnerSelected ? 0.76 : 0.46),
    borderWidth: isOwnerSelected ? 1.7 : 1,
    shadowColor: hexWithAlpha(accent, 0.22),
    shadowBlur: isOwnerSelected ? 10 : 6,
    accentColor: hexWithAlpha(accent, 0.72),
  });

  ctx.font = 'bold 7px monospace';
  const badgeWidth = Math.max(30, Math.ceil(measureTextCached(ctx, ctx.font, badgeText) + 14));
  ctx.fillStyle = hexWithAlpha(accent, 0.16);
  ctx.beginPath();
  ctx.roundRect(
    ACTIVITY_LANE.width / 2 - badgeWidth - 8,
    -ACTIVITY_LANE.itemHeight / 2 + 4,
    badgeWidth,
    11,
    5
  );
  ctx.fill();

  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexWithAlpha(accent, 0.96);
  ctx.fillText(
    badgeText,
    ACTIVITY_LANE.width / 2 - badgeWidth / 2 - 8,
    -ACTIVITY_LANE.itemHeight / 2 + 9.5
  );

  ctx.textAlign = 'left';
  ctx.font = 'bold 8px monospace';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = COLORS.textPrimary;
  const title = truncateText(ctx, item.title, ACTIVITY_LANE.width - badgeWidth - 26, ctx.font);
  ctx.fillText(title, -ACTIVITY_LANE.width / 2 + 10, -3.5);

  const preview = item.preview?.trim();
  if (preview) {
    ctx.font = '7px monospace';
    ctx.fillStyle = COLORS.textDim;
    const previewText = truncateText(ctx, preview, ACTIVITY_LANE.width - 18, ctx.font);
    ctx.fillText(previewText, -ACTIVITY_LANE.width / 2 + 10, 6.5);
  } else if (item.authorLabel) {
    ctx.font = '7px monospace';
    ctx.fillStyle = COLORS.textDim;
    const authorText = truncateText(ctx, item.authorLabel, ACTIVITY_LANE.width - 18, ctx.font);
    ctx.fillText(authorText, -ACTIVITY_LANE.width / 2 + 10, 6.5);
  }

  ctx.restore();
}

function drawOverflowPill(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  overflowCount: number
): void {
  const width = TASK_PILL.width;
  const height = ACTIVITY_LANE.overflowHeight;
  ctx.save();
  ctx.translate(x, y);

  drawPillShell(ctx, {
    width,
    height,
    radius: 6,
    fillStyle: 'rgba(10, 15, 30, 0.42)',
    borderColor: hexWithAlpha(COLORS.holoBright, 0.22),
    borderWidth: 1,
  });

  ctx.font = 'bold 7px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexWithAlpha(COLORS.holoBright, 0.66);
  ctx.fillText(`+${overflowCount} more`, 0, 0.5);

  ctx.restore();
}

function getActivityAccentColor(kind: GraphActivityItem['kind']): string {
  switch (kind) {
    case 'task_comment':
      return COLORS.particleTaskComment;
    case 'task_assign':
      return COLORS.particleTaskAssign;
    case 'review_request':
      return COLORS.particleReviewRequest;
    case 'review_response':
      return COLORS.particleReviewResponse;
    case 'inbox_message':
    default:
      return COLORS.particleInboxMessage;
  }
}

function getActivityBadgeText(kind: GraphActivityItem['kind']): string {
  switch (kind) {
    case 'task_comment':
      return 'COMMENT';
    case 'task_assign':
      return 'TASK';
    case 'review_request':
      return 'REV';
    case 'review_response':
      return 'DONE';
    case 'inbox_message':
    default:
      return 'MSG';
  }
}
