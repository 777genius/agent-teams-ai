import { COLORS } from '../constants/colors';
import { HANDOFF_CARD, NODE, TASK_PILL, MIN_VISIBLE_OPACITY } from '../constants/canvas-constants';
import type { CameraTransform } from '../hooks/useGraphCamera';
import { getHandoffAnchorTarget } from '../layout/launchAnchor';
import type { GraphNode } from '../ports/types';
import type { TransientHandoffCard } from '../ui/transientHandoffs';
import { truncateText } from './draw-misc';
import { hexWithAlpha, measureTextCached } from './render-cache';

export function drawHandoffCards(
  ctx: CanvasRenderingContext2D,
  params: {
    cards: TransientHandoffCard[];
    nodeMap: Map<string, GraphNode>;
    time: number;
    camera: CameraTransform;
    viewport: { width: number; height: number };
  }
): void {
  const { cards, nodeMap, time, camera, viewport } = params;
  if (cards.length === 0) return;

  const stackIndexByDestination = new Map<string, number>();
  let drawnCount = 0;

  for (const card of cards) {
    if (drawnCount >= HANDOFF_CARD.maxVisible) break;
    const destinationNode = nodeMap.get(card.destinationNodeId);
    if (!destinationNode || destinationNode.x == null || destinationNode.y == null) continue;

    const alpha = getCardAlpha(card, time);
    if (alpha <= MIN_VISIBLE_OPACITY) continue;

    const previewLines = buildPreviewLines(ctx, card.preview);
    const height = HANDOFF_CARD.baseHeight + previewLines.length * HANDOFF_CARD.previewLineHeight;
    const stackIndex = stackIndexByDestination.get(card.destinationNodeId) ?? 0;
    stackIndexByDestination.set(card.destinationNodeId, stackIndex + 1);

    const position = getCardPosition({
      node: destinationNode,
      camera,
      viewport,
      height,
      stackIndex,
    });
    if (!position) continue;

    drawCard({
      ctx,
      card,
      previewLines,
      alpha,
      x: position.x,
      y: position.y,
      width: HANDOFF_CARD.width,
      height,
    });
    drawnCount += 1;
  }
}

function getCardAlpha(card: TransientHandoffCard, time: number): number {
  const fadeIn = Math.min(1, (time - card.activatedAt) / HANDOFF_CARD.fadeInSeconds);
  const fadeOutRemaining = card.expiresAt - time;
  const fadeOut = fadeOutRemaining <= HANDOFF_CARD.fadeOutSeconds
    ? Math.max(0, fadeOutRemaining / HANDOFF_CARD.fadeOutSeconds)
    : 1;
  return Math.max(0, Math.min(1, fadeIn * fadeOut));
}

function getCardPosition(params: {
  node: GraphNode;
  camera: CameraTransform;
  viewport: { width: number; height: number };
  height: number;
  stackIndex: number;
}): { x: number; y: number } | null {
  const { node, camera, viewport, height, stackIndex } = params;
  const anchor = getCardAnchorPosition(node, camera.zoom);
  const screenX = anchor.x * camera.zoom + camera.x;
  const screenY = anchor.y * camera.zoom + camera.y;

  const visibleMargin = 80;
  if (
    screenX < -visibleMargin ||
    screenX > viewport.width + visibleMargin ||
    screenY < -visibleMargin ||
    screenY > viewport.height + visibleMargin
  ) {
    return null;
  }

  const stackOffset = stackIndex * (height + HANDOFF_CARD.stackGap);
  let x = screenX - HANDOFF_CARD.width / 2;
  let y = screenY - height / 2 - stackOffset;

  if (x + HANDOFF_CARD.width > viewport.width - HANDOFF_CARD.viewportPadding) {
    x = viewport.width - HANDOFF_CARD.width - HANDOFF_CARD.viewportPadding;
  }
  if (x < HANDOFF_CARD.viewportPadding) {
    x = HANDOFF_CARD.viewportPadding;
  }

  if (y < HANDOFF_CARD.viewportPadding) {
    y = HANDOFF_CARD.viewportPadding;
  }
  if (y + height > viewport.height - HANDOFF_CARD.viewportPadding) {
    y = Math.max(HANDOFF_CARD.viewportPadding, viewport.height - height - HANDOFF_CARD.viewportPadding);
  }

  return { x, y };
}

function getCardAnchorPosition(node: GraphNode, zoom: number): { x: number; y: number } {
  switch (node.kind) {
    case 'lead':
    case 'member':
      return getHandoffAnchorTarget({
        nodeX: node.x ?? 0,
        nodeY: node.y ?? 0,
        nodeKind: node.kind,
      });
    case 'task':
      return {
        x: (node.x ?? 0) + TASK_PILL.width * 0.5 + HANDOFF_CARD.anchorGap / zoom,
        y: (node.y ?? 0) - (TASK_PILL.height * 0.5 + HANDOFF_CARD.anchorGap / zoom),
      };
    case 'process':
      return {
        x: (node.x ?? 0) + NODE.radiusProcess + HANDOFF_CARD.anchorGap / zoom,
        y: (node.y ?? 0) - (NODE.radiusProcess + HANDOFF_CARD.anchorGap / zoom),
      };
    case 'crossteam':
      return {
        x: (node.x ?? 0) + NODE.radiusCrossTeam + HANDOFF_CARD.anchorGap / zoom,
        y: (node.y ?? 0) - (NODE.radiusCrossTeam + HANDOFF_CARD.anchorGap / zoom),
      };
  }
}

function drawCard(params: {
  ctx: CanvasRenderingContext2D;
  card: TransientHandoffCard;
  previewLines: string[];
  alpha: number;
  x: number;
  y: number;
  width: number;
  height: number;
}): void {
  const { ctx, card, previewLines, alpha, x, y, width, height } = params;
  const accent = card.color || COLORS.particleInboxMessage;
  const radius = 10;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.shadowColor = hexWithAlpha(accent, 0.22 * alpha);
  ctx.shadowBlur = 12;
  ctx.fillStyle = hexWithAlpha('#08111f', 0.92);
  ctx.strokeStyle = hexWithAlpha(accent, 0.38);
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.roundRect(x, y, width, height, radius);
  ctx.fill();
  ctx.stroke();

  ctx.shadowBlur = 0;
  ctx.fillStyle = hexWithAlpha(accent, 0.14);
  ctx.beginPath();
  ctx.roundRect(x + 8, y + 8, 54, 16, 6);
  ctx.fill();

  ctx.fillStyle = hexWithAlpha(accent, 0.92);
  ctx.font = 'bold 8px monospace';
  ctx.textAlign = 'left';
  ctx.fillText(getKindLabel(card.kind), x + 16, y + 19);

  if (card.count > 1) {
    const countText = `+${card.count - 1}`;
    ctx.font = 'bold 8px monospace';
    const countWidth = measureTextCached(ctx, ctx.font, countText) + 14;
    ctx.fillStyle = hexWithAlpha(COLORS.holoBright, 0.16);
    ctx.beginPath();
    ctx.roundRect(x + width - countWidth - 10, y + 8, countWidth, 16, 6);
    ctx.fill();
    ctx.fillStyle = COLORS.holoBright;
    ctx.textAlign = 'center';
    ctx.fillText(countText, x + width - countWidth / 2 - 10, y + 19);
  }

  ctx.textAlign = 'left';
  ctx.font = 'bold 10px monospace';
  ctx.fillStyle = COLORS.textPrimary;
  const route = truncateText(
    ctx,
    `${card.sourceLabel} -> ${card.destinationLabel}`,
    width - 20,
    ctx.font
  );
  ctx.fillText(route, x + 10, y + 36);

  if (previewLines.length > 0) {
    ctx.font = '8px monospace';
    ctx.fillStyle = hexWithAlpha(COLORS.holoBright, 0.86);
    for (let index = 0; index < previewLines.length; index += 1) {
      ctx.fillText(
        previewLines[index],
        x + 10,
        y + 50 + index * HANDOFF_CARD.previewLineHeight
      );
    }
  }
  ctx.restore();
}

function buildPreviewLines(ctx: CanvasRenderingContext2D, preview: string | undefined): string[] {
  if (!preview) return [];
  ctx.font = '8px monospace';
  let remaining = preview.replace(/\s+/g, ' ').trim();
  if (remaining.length === 0) return [];
  const lines: string[] = [];
  for (let index = 0; index < HANDOFF_CARD.previewMaxLines && remaining.length > 0; index += 1) {
    if (index === HANDOFF_CARD.previewMaxLines - 1) {
      lines.push(truncateText(ctx, remaining, HANDOFF_CARD.previewMaxWidth, ctx.font));
      break;
    }

    const words = remaining.split(' ');
    let line = '';
    let consumedWords = 0;
    for (const word of words) {
      const candidate = line.length > 0 ? `${line} ${word}` : word;
      if (measureTextCached(ctx, ctx.font, candidate) <= HANDOFF_CARD.previewMaxWidth) {
        line = candidate;
        consumedWords += 1;
        continue;
      }
      break;
    }

    if (consumedWords === 0) {
      lines.push(truncateText(ctx, words[0] ?? remaining, HANDOFF_CARD.previewMaxWidth, ctx.font));
      break;
    }

    lines.push(line);
    remaining = words.slice(consumedWords).join(' ').trim();
  }

  return lines;
}

function getKindLabel(kind: TransientHandoffCard['kind']): string {
  switch (kind) {
    case 'task_comment':
      return 'COMMENT';
    case 'task_assign':
      return 'TASK';
    case 'review_request':
      return 'REVIEW';
    case 'review_response':
      return 'REPLY';
    case 'inbox_message':
      return 'MESSAGE';
  }
}
