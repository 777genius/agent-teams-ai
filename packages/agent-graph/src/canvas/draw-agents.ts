/**
 * Agent (member/lead) node drawing with holographic effects.
 * Adapted from agent-flow's draw-agents.ts (Apache 2.0).
 * Uses our GraphNode port type instead of agent-flow's Agent type.
 */

import {
  AGENT_DRAW,
  ANIM,
  CONTEXT_RING,
  MIN_VISIBLE_OPACITY,
  NODE,
} from '../constants/canvas-constants';
import { alphaHex, COLORS, getStateColor } from '../constants/colors';

import { drawHexagon } from './draw-misc';
import {
  getGraphNodeCardSize,
  getGraphNodeOverviewSize,
  type GraphNodeVisualSize,
} from './node-geometry';
import { getAgentGlowSprite, hexWithAlpha } from './render-cache';
import { getGraphSemanticZoomLevel, shouldRenderOverviewHierarchyNode } from './semantic-zoom';

import type { GraphNode } from '../ports/types';

/**
 * Draw all member/lead nodes on the canvas.
 */
export function drawAgents(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
  focusNodeIds?: ReadonlySet<string> | null,
  zoom = 1
): void {
  const simplify = zoom < 0.19;
  for (const node of nodes) {
    if (node.kind !== 'member' && node.kind !== 'lead') continue;
    const cardSize = getGraphNodeCardSize(node);
    const opacity =
      (cardSize ? getHierarchyCardOpacity(node) : getNodeOpacity(node)) *
      getFocusOpacity(node.id, focusNodeIds);
    if (opacity < MIN_VISIBLE_OPACITY) continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = node.kind === 'lead' ? NODE.radiusLead : NODE.radiusMember;
    const color = node.color ?? getStateColor(node.state);
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;
    const hasErrorException = node.exceptionTone === 'error';

    ctx.save();
    ctx.globalAlpha = opacity;

    if (cardSize) {
      const semanticLevel = getGraphSemanticZoomLevel(zoom);
      if (
        semanticLevel === 'overview' &&
        !shouldRenderOverviewHierarchyNode(node, zoom, isSelected || isHovered)
      ) {
        ctx.restore();
        continue;
      }
      drawHierarchyCard(ctx, node, x, y, cardSize, color, time, isSelected, isHovered, zoom);
      ctx.restore();
      continue;
    }

    if (simplify) {
      if (hasErrorException) {
        drawExceptionGlow(ctx, x, y, r, time, true);
      }
      drawHexagon(ctx, x, y, r);
      ctx.fillStyle = isSelected ? 'rgba(100, 200, 255, 0.15)' : COLORS.nodeInterior;
      ctx.fill();
      drawHexagon(ctx, x, y, r);
      ctx.strokeStyle = hexWithAlpha(color, isHovered ? 0.8 : 0.5);
      ctx.lineWidth = isSelected ? 2 : 1;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, Math.max(3, r * 0.16), 0, Math.PI * 2);
      ctx.fillStyle = hexWithAlpha(color, 0.8);
      ctx.fill();
    } else {
      // Depth shadow
      drawDepthShadow(ctx, x, y, r);

      // Outer glow
      drawGlow(ctx, x, y, r, color);
      if (hasErrorException) {
        drawExceptionGlow(ctx, x, y, r, time);
      }

      // Hexagonal body with interior fill
      drawHexBody(ctx, x, y, r, color, node.state, time, isSelected, isHovered);

      // Avatar: robohash image or fallback letter
      drawAvatar(ctx, x, y, r, node.label, color, node.kind === 'lead', node.avatarUrl);

      // Breathing animation + launch-stage effects
      drawBreathing(ctx, x, y, r, node.state, time, node.spawnStatus);
      drawLaunchStage(ctx, x, y, r, node.launchVisualState, time);
    }

    // Pending approval indicator: pulsing amber ring
    if (!simplify && node.pendingApproval) {
      const pulseAlpha = 0.3 + 0.35 * Math.sin(time * 7);
      const ringR = r + 5;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexWithAlpha('#f59e0b', pulseAlpha);
      ctx.lineWidth = 2;
      ctx.stroke();

      // Subtle amber glow
      const glowR = r + 12;
      const grad = ctx.createRadialGradient(x, y, r, x, y, glowR);
      grad.addColorStop(0, hexWithAlpha('#f59e0b', pulseAlpha * 0.25));
      grad.addColorStop(1, 'transparent');
      ctx.beginPath();
      ctx.arc(x, y, glowR, 0, Math.PI * 2);
      ctx.fillStyle = grad;
      ctx.fill();
    }

    // Working indicator: subtle spinning arc when member has active task
    if (
      !simplify &&
      node.currentTaskId &&
      (node.state === 'active' || node.state === 'thinking' || node.state === 'tool_calling')
    ) {
      const ringR = r + 4;
      const rotation = time * 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ringR, rotation, rotation + Math.PI * 0.8);
      ctx.strokeStyle = hexWithAlpha(color, 0.4);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    if (!simplify && node.activeTool) {
      drawToolCard(ctx, x, y, r, node.activeTool, time);
    }

    if (!simplify && node.exceptionTone) {
      drawExceptionPip(ctx, x, y, r, node.exceptionTone);
    }

    if (!simplify) {
      // Name + role label (single line: "jack · developer")
      const labelText = node.role ? `${node.label} · ${node.role}` : node.label;
      drawLabel(
        ctx,
        x,
        y,
        r,
        labelText,
        node.runtimeLabel,
        node.launchStatusLabel,
        node.launchVisualState
      );
    }

    // TODO: Context ring disabled — LeadContextUsage.percent is unreliable
    // (jumps due to cache_read variance, contextWindow mismatch with actual model).
    // Re-enable when we have stable context window data from modelUsage.
    // if (node.kind === 'lead' && node.contextUsage != null) {
    //   drawContextRing(ctx, x, y, r, node.contextUsage, time);
    // }

    // Selection ring
    if (isSelected) {
      drawSelectionRing(ctx, x, y, r, color);
    }

    ctx.restore();
  }
}

/**
 * Draw cross-team ghost nodes — semi-transparent dashed hexagons.
 */
export function drawCrossTeamNodes(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
  focusNodeIds?: ReadonlySet<string> | null
): void {
  for (const node of nodes) {
    if (node.kind !== 'crossteam') continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = NODE.radiusCrossTeam;
    const color = node.color ?? '#cc88ff';
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;

    ctx.save();
    ctx.globalAlpha = (isHovered ? 0.7 : 0.5) * getFocusOpacity(node.id, focusNodeIds);

    // Subtle glow
    const glowR = r + AGENT_DRAW.glowPadding;
    const sprite = getAgentGlowSprite(color, r, glowR);
    ctx.drawImage(sprite, x - glowR, y - glowR);

    // Dashed hexagon body
    drawHexagon(ctx, x, y, r);
    ctx.fillStyle = 'rgba(10, 15, 40, 0.4)';
    ctx.fill();

    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = hexWithAlpha(color, 0.6);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    ctx.setLineDash([]);

    // Link icon (two arrows ↔) in center
    ctx.font = 'bold 12px sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = hexWithAlpha(color, 0.8);
    ctx.fillText('\u{2194}', x, y); // ↔

    // Label below
    ctx.globalAlpha = 0.7;
    ctx.font = '8px monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'top';
    ctx.fillStyle = hexWithAlpha(color, 0.7);
    ctx.fillText(node.label, x, y + r + 6);

    // Selection ring
    if (isSelected) {
      drawSelectionRing(ctx, x, y, r, color);
    }

    ctx.restore();
  }
}

// ─── Private Helpers ────────────────────────────────────────────────────────

function getNodeOpacity(node: GraphNode): number {
  if (node.state === 'terminated' || node.state === 'complete') return 0.3;
  if (node.spawnStatus === 'spawning') return 0.85;
  if (node.spawnStatus === 'waiting') return 0.7;
  if (node.spawnStatus === 'offline') return 0;
  return 1;
}

function getFocusOpacity(nodeId: string, focusNodeIds?: ReadonlySet<string> | null): number {
  return focusNodeIds && !focusNodeIds.has(nodeId) ? 0.25 : 1;
}

function getHierarchyCardOpacity(node: GraphNode): number {
  if (node.spawnStatus === 'offline') return 0.72;
  if (node.state === 'terminated' || node.state === 'complete') return 0.72;
  return 1;
}

function drawHierarchyCard(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  size: GraphNodeVisualSize,
  color: string,
  time: number,
  isSelected: boolean,
  isHovered: boolean,
  zoom: number
): void {
  const semanticLevel = getGraphSemanticZoomLevel(zoom);
  if (semanticLevel === 'overview') {
    drawHierarchyOverviewBadge(ctx, node, x, y, color, isSelected, isHovered, zoom);
    return;
  }

  const left = x - size.width / 2;
  const top = y - size.height / 2;
  const radius = node.visualVariant === 'organization' ? 12 : 10;
  const isActive =
    node.state === 'active' || node.state === 'thinking' || node.state === 'tool_calling';
  const showTitle = true;
  const showMetadata = true;

  ctx.save();
  ctx.shadowColor = hexWithAlpha(color, isSelected ? 0.32 : isHovered ? 0.2 : 0.1);
  ctx.shadowBlur = isSelected ? 18 : isHovered ? 13 : 9;
  ctx.beginPath();
  ctx.roundRect(left, top, size.width, size.height, radius);
  const background = ctx.createLinearGradient(left, top, left + size.width, top + size.height);
  background.addColorStop(0, 'rgba(10, 21, 39, 0.98)');
  background.addColorStop(1, 'rgba(7, 14, 29, 0.98)');
  ctx.fillStyle = background;
  ctx.fill();
  ctx.shadowBlur = 0;

  ctx.strokeStyle = hexWithAlpha(color, isSelected ? 0.9 : isHovered ? 0.68 : 0.38);
  ctx.lineWidth = isSelected ? 2 : 1.2;
  ctx.stroke();

  ctx.beginPath();
  ctx.roundRect(left + 7, top + 10, 4, size.height - 20, 2);
  ctx.fillStyle = hexWithAlpha(color, isActive ? 0.95 : 0.66);
  ctx.fill();

  if (isActive && zoom >= 0.3) {
    const pulse = 0.16 + 0.08 * Math.sin(time * 3.2);
    ctx.beginPath();
    ctx.roundRect(left + 1, top + 1, size.width - 2, size.height - 2, radius - 1);
    ctx.strokeStyle = hexWithAlpha(color, pulse);
    ctx.lineWidth = 3;
    ctx.stroke();
  }

  const iconSize = node.visualVariant === 'organization' ? 34 : 30;
  const iconX = left + 14;
  const iconY = y - iconSize / 2;
  ctx.beginPath();
  ctx.roundRect(iconX, iconY, iconSize, iconSize, 8);
  ctx.fillStyle = hexWithAlpha(color, 0.1);
  ctx.fill();
  ctx.strokeStyle = hexWithAlpha(color, 0.34);
  ctx.lineWidth = 1;
  ctx.stroke();
  drawHierarchyCardIcon(ctx, node.visualVariant, iconX, iconY, iconSize, color);

  const statusColor = node.state === 'active' ? '#34d399' : getStateColor(node.state);
  ctx.beginPath();
  ctx.arc(left + size.width - 15, top + 14, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = statusColor;
  ctx.fill();
  ctx.strokeStyle = 'rgba(4, 10, 20, 0.9)';
  ctx.lineWidth = 1.5;
  ctx.stroke();

  if (showTitle) {
    const textX = iconX + iconSize + 14;
    const maxTextWidth = size.width - (textX - left) - 24;
    ctx.textAlign = 'left';
    ctx.textBaseline = 'middle';
    ctx.font =
      node.visualVariant === 'organization' ? '600 15px sans-serif' : '600 14px sans-serif';
    ctx.fillStyle = 'rgba(228, 240, 255, 0.96)';
    ctx.fillText(
      truncateCardText(ctx, node.label, maxTextWidth),
      textX,
      y - (showMetadata ? 8 : 0)
    );

    if (showMetadata) {
      const metadata = getHierarchyCardMetadata(node, semanticLevel);
      if (metadata) {
        ctx.font = '11px sans-serif';
        ctx.fillStyle = 'rgba(142, 166, 197, 0.78)';
        ctx.fillText(truncateCardText(ctx, metadata, maxTextWidth), textX, y + 12);
      }
    }
  }

  ctx.restore();
}

function drawHierarchyOverviewBadge(
  ctx: CanvasRenderingContext2D,
  node: GraphNode,
  x: number,
  y: number,
  color: string,
  isSelected: boolean,
  isHovered: boolean,
  zoom: number
): void {
  const overviewSize = getGraphNodeOverviewSize(node, zoom);
  if (!overviewSize) return;
  const effectiveZoom =
    node.visualVariant === 'team' ? Math.max(zoom, 0.19) : Math.max(zoom, 0.015);
  const inverseZoom = 1 / effectiveZoom;
  const isTeam = node.visualVariant === 'team';
  const titleFontSize = (isTeam ? 9 : 12) * inverseZoom;
  const summaryFontSize = (isTeam ? 6.5 : 9.5) * inverseZoom;
  const paddingX = (isTeam ? 6 : 8) * inverseZoom;
  const height = overviewSize.height;
  const radius = (isTeam ? 5 : 6) * inverseZoom;

  ctx.save();
  const maxWidth = overviewSize.width;
  ctx.font = `600 ${titleFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const renderedTitle = truncateCardText(ctx, node.label, maxWidth - paddingX * 2);
  const titleWidth = ctx.measureText(renderedTitle).width;
  ctx.font = `500 ${summaryFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  const renderedSummary = node.semanticSummary
    ? truncateCardText(ctx, node.semanticSummary, maxWidth - paddingX * 2)
    : '';
  const summaryWidth = ctx.measureText(renderedSummary).width;
  const width = isTeam
    ? maxWidth
    : Math.min(maxWidth, Math.max(titleWidth, summaryWidth) + paddingX * 2);
  const left = x - width / 2;
  const top = y - height / 2;

  ctx.beginPath();
  ctx.roundRect(left, top, width, height, radius);
  ctx.fillStyle = isTeam ? 'rgba(7, 14, 29, 0.9)' : 'rgba(7, 14, 29, 0.94)';
  ctx.fill();
  let borderAlpha = 0.5;
  if (isSelected) borderAlpha = 0.92;
  else if (isHovered) borderAlpha = 0.72;
  ctx.strokeStyle = hexWithAlpha(color, borderAlpha);
  ctx.lineWidth = (isSelected ? 1.8 : 1) * inverseZoom;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(
    left + (isTeam ? 6 : 8) * inverseZoom,
    y - (isTeam ? 4.5 : 5) * inverseZoom,
    (isTeam ? 1.8 : 2.5) * inverseZoom,
    0,
    Math.PI * 2
  );
  ctx.fillStyle = node.state === 'active' ? '#34d399' : getStateColor(node.state);
  ctx.fill();

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.font = `600 ${titleFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
  ctx.fillStyle = 'rgba(228, 240, 255, 0.96)';
  ctx.fillText(
    renderedTitle,
    left + (isTeam ? 11 : 15) * inverseZoom,
    y - (isTeam ? 4.5 : 5) * inverseZoom
  );
  if (renderedSummary) {
    ctx.font = `500 ${summaryFontSize}px ui-monospace, SFMono-Regular, Menlo, monospace`;
    ctx.fillStyle = 'rgba(174, 199, 227, 0.84)';
    ctx.fillText(renderedSummary, left + paddingX, y + 7 * inverseZoom);
  }
  ctx.restore();
}

function getHierarchyCardMetadata(
  node: GraphNode,
  semanticLevel: ReturnType<typeof getGraphSemanticZoomLevel>
): string | undefined {
  if (semanticLevel === 'summary') {
    return node.semanticSummary ?? node.runtimeLabel ?? node.role;
  }
  return node.role ?? node.semanticSummary ?? node.runtimeLabel ?? node.currentTaskSubject;
}

function drawHierarchyCardIcon(
  ctx: CanvasRenderingContext2D,
  variant: GraphNode['visualVariant'],
  x: number,
  y: number,
  size: number,
  color: string
): void {
  const cx = x + size / 2;
  const cy = y + size / 2;
  ctx.save();
  ctx.strokeStyle = hexWithAlpha(color, 0.88);
  ctx.fillStyle = hexWithAlpha(color, 0.14);
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  if (variant === 'team') {
    ctx.beginPath();
    ctx.moveTo(cx - 1, cy - 4);
    ctx.arc(cx - 4, cy - 4, 3, 0, Math.PI * 2);
    ctx.moveTo(cx + 7.5, cy - 3);
    ctx.arc(cx + 5, cy - 3, 2.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 10, cy + 5);
    ctx.arc(cx - 4, cy + 5, 6, Math.PI, 0);
    ctx.moveTo(cx, cy + 5);
    ctx.arc(cx + 5, cy + 5, 5, Math.PI, 0);
    ctx.stroke();
  } else if (variant === 'container') {
    ctx.beginPath();
    ctx.roundRect(cx - 9, cy - 6, 18, 13, 3);
    ctx.fill();
    ctx.stroke();
    ctx.beginPath();
    ctx.moveTo(cx - 7, cy - 7);
    ctx.lineTo(cx - 2, cy - 7);
    ctx.lineTo(cx, cy - 5);
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.roundRect(cx - 3, cy - 9, 6, 6, 1.5);
    ctx.roundRect(cx - 10, cy + 4, 6, 6, 1.5);
    ctx.roundRect(cx + 4, cy + 4, 6, 6, 1.5);
    ctx.moveTo(cx, cy - 3);
    ctx.lineTo(cx, cy + 1);
    ctx.moveTo(cx - 7, cy + 1);
    ctx.lineTo(cx + 7, cy + 1);
    ctx.moveTo(cx - 7, cy + 1);
    ctx.lineTo(cx - 7, cy + 4);
    ctx.moveTo(cx + 7, cy + 1);
    ctx.lineTo(cx + 7, cy + 4);
    ctx.stroke();
  }
  ctx.restore();
}

function drawExceptionPip(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tone: NonNullable<GraphNode['exceptionTone']>
): void {
  const pipX = x + r * 0.58;
  const pipY = y - r * 0.58;
  const pipColor = tone === 'error' ? '#ef4444' : '#f59e0b';

  ctx.save();
  ctx.beginPath();
  ctx.arc(pipX, pipY, 4.5, 0, Math.PI * 2);
  ctx.fillStyle = pipColor;
  ctx.fill();
  ctx.lineWidth = 1.5;
  ctx.strokeStyle = '#050510';
  ctx.stroke();
  ctx.restore();
}

function drawExceptionGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  time: number,
  simplified = false
): void {
  const pulse = 0.5 + 0.5 * Math.sin(time * 4.2);
  const glowAlpha = simplified ? 0.12 : 0.16 + pulse * 0.08;
  const strokeAlpha = simplified ? 0.7 : 0.5 + pulse * 0.24;
  const outerR = r + (simplified ? 13 : 20);
  const ringR = r + (simplified ? 4 : 7);
  const arcR = r + (simplified ? 9 : 13);
  const errorColor = '#ef4444';

  ctx.save();
  const grad = ctx.createRadialGradient(x, y, r * 0.6, x, y, outerR);
  grad.addColorStop(0, hexWithAlpha(errorColor, glowAlpha));
  grad.addColorStop(0.68, hexWithAlpha(errorColor, glowAlpha * 0.55));
  grad.addColorStop(1, hexWithAlpha(errorColor, 0));
  ctx.beginPath();
  ctx.arc(x, y, outerR, 0, Math.PI * 2);
  ctx.fillStyle = grad;
  ctx.fill();

  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = hexWithAlpha(errorColor, strokeAlpha);
  ctx.lineWidth = simplified ? 2 : 2.4;
  ctx.stroke();

  ctx.beginPath();
  ctx.arc(x, y, arcR, time * 1.35, time * 1.35 + Math.PI * 1.3);
  ctx.strokeStyle = hexWithAlpha('#f87171', simplified ? 0.78 : 0.62 + pulse * 0.22);
  ctx.lineWidth = simplified ? 1.4 : 2;
  ctx.lineCap = 'round';
  ctx.stroke();
  ctx.restore();
}

function drawLaunchStage(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  visualState: GraphNode['launchVisualState'],
  time: number
): void {
  if (!visualState) {
    return;
  }

  ctx.save();
  switch (visualState) {
    case 'queued':
    case 'waiting': {
      const ringR = r + 8 + Math.sin(time * 3.2) * 1.4;
      const pulseAlpha = 0.28 + 0.18 * (0.5 + 0.5 * Math.sin(time * 3.2));
      const dotOrbit = r + 11;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexWithAlpha('#d4d4d8', pulseAlpha);
      ctx.lineWidth = 2.5;
      ctx.setLineDash([4, 5]);
      ctx.stroke();
      ctx.setLineDash([]);
      for (let index = 0; index < 3; index += 1) {
        const angle = time * 1.2 + (Math.PI * 2 * index) / 3;
        ctx.beginPath();
        ctx.arc(
          x + Math.cos(angle) * dotOrbit,
          y + Math.sin(angle) * dotOrbit,
          1.7,
          0,
          Math.PI * 2
        );
        ctx.fillStyle = hexWithAlpha('#e4e4e7', 0.72);
        ctx.fill();
      }
      break;
    }
    case 'spawning': {
      const ringR = r + 7;
      const rotation = time * 2.7;
      ctx.beginPath();
      ctx.arc(x, y, ringR, rotation, rotation + Math.PI * 1.15);
      ctx.strokeStyle = hexWithAlpha('#f59e0b', 0.8);
      ctx.lineWidth = 2.8;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, ringR + 4, rotation + Math.PI, rotation + Math.PI + Math.PI * 0.4);
      ctx.strokeStyle = hexWithAlpha('#fbbf24', 0.65);
      ctx.lineWidth = 1.8;
      ctx.lineCap = 'round';
      ctx.stroke();

      const glow = ctx.createRadialGradient(x, y, r * 0.5, x, y, ringR + 12);
      glow.addColorStop(0, hexWithAlpha('#f59e0b', 0.18));
      glow.addColorStop(1, hexWithAlpha('#f59e0b', 0));
      ctx.beginPath();
      ctx.arc(x, y, ringR + 12, 0, Math.PI * 2);
      ctx.fillStyle = glow;
      ctx.fill();
      break;
    }
    case 'runtime_pending': {
      const ringR = r + 8;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexWithAlpha('#38bdf8', 0.48);
      ctx.lineWidth = 1.9;
      ctx.setLineDash([5, 4]);
      ctx.stroke();
      ctx.setLineDash([]);

      const orbit = time * 1.8;
      for (let index = 0; index < 2; index += 1) {
        const angle = orbit + Math.PI * index;
        const dotX = x + Math.cos(angle) * ringR;
        const dotY = y + Math.sin(angle) * ringR;
        ctx.beginPath();
        ctx.arc(dotX, dotY, 2.3, 0, Math.PI * 2);
        ctx.fillStyle = hexWithAlpha(index === 0 ? '#67e8f9' : '#38bdf8', 0.92);
        ctx.fill();
      }
      break;
    }
    case 'settling': {
      const ringR = r + 6;
      const arc = 0.72 + 0.08 * Math.sin(time * 2.2);
      const rotation = time * 1.25;
      ctx.beginPath();
      ctx.arc(x, y, ringR, 0, Math.PI * 2);
      ctx.strokeStyle = hexWithAlpha('#22c55e', 0.18);
      ctx.lineWidth = 1.4;
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x, y, ringR, rotation, rotation + Math.PI * arc);
      ctx.strokeStyle = hexWithAlpha('#22c55e', 0.62);
      ctx.lineWidth = 2.2;
      ctx.lineCap = 'round';
      ctx.stroke();
      break;
    }
    case 'error': {
      const ringR = r + 7 + Math.sin(time * 4) * 0.8;
      ctx.beginPath();
      ctx.arc(x, y, ringR, Math.PI * 0.2, Math.PI * 1.15);
      ctx.strokeStyle = hexWithAlpha('#ef4444', 0.72);
      ctx.lineWidth = 2.4;
      ctx.lineCap = 'round';
      ctx.stroke();

      ctx.beginPath();
      ctx.arc(x + ringR * 0.52, y - ringR * 0.5, 2.2, 0, Math.PI * 2);
      ctx.fillStyle = hexWithAlpha('#f87171', 0.92);
      ctx.fill();
      break;
    }
  }
  ctx.restore();
}

function drawDepthShadow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number): void {
  ctx.save();
  ctx.shadowColor = 'rgba(0, 0, 0, 0.5)';
  ctx.shadowBlur = AGENT_DRAW.shadowBlur;
  ctx.shadowOffsetX = AGENT_DRAW.shadowOffsetX;
  ctx.shadowOffsetY = AGENT_DRAW.shadowOffsetY;
  drawHexagon(ctx, x, y, r);
  ctx.fillStyle = 'rgba(0, 0, 0, 0.01)';
  ctx.fill();
  ctx.restore();
}

function drawGlow(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string
): void {
  const outerR = r + AGENT_DRAW.glowPadding;
  const sprite = getAgentGlowSprite(color, r * 0.5, outerR);
  ctx.drawImage(sprite, x - outerR, y - outerR);
}

function drawHexBody(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string,
  state: string,
  time: number,
  isSelected: boolean,
  isHovered: boolean
): void {
  // Interior fill
  drawHexagon(ctx, x, y, r);
  ctx.fillStyle = isSelected ? 'rgba(100, 200, 255, 0.15)' : COLORS.nodeInterior;
  ctx.fill();

  // Scanline effect
  const scanSpeed =
    state === 'active' || state === 'thinking' || state === 'tool_calling'
      ? ANIM.scanline.active
      : ANIM.scanline.normal;
  const scanY = ((time * scanSpeed) % (r * 2)) - r;
  ctx.save();
  drawHexagon(ctx, x, y, r);
  ctx.clip();
  const grad = ctx.createLinearGradient(
    x,
    y + scanY - AGENT_DRAW.scanlineHalfH,
    x,
    y + scanY + AGENT_DRAW.scanlineHalfH
  );
  grad.addColorStop(0, hexWithAlpha(color, 0));
  grad.addColorStop(0.5, hexWithAlpha(color, 0.13));
  grad.addColorStop(1, hexWithAlpha(color, 0));
  ctx.fillStyle = grad;
  ctx.fillRect(x - r, y + scanY - AGENT_DRAW.scanlineHalfH, r * 2, AGENT_DRAW.scanlineHalfH * 2);
  ctx.restore();

  // Border
  drawHexagon(ctx, x, y, r);
  ctx.strokeStyle = hexWithAlpha(color, isHovered ? 0.8 : 0.5);
  ctx.lineWidth = isSelected ? 2 : 1;
  ctx.stroke();
}

function truncateCardText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;
  let out = text;
  while (out.length > 1 && ctx.measureText(`${out}...`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}...`;
}

function drawToolCard(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  tool: NonNullable<GraphNode['activeTool']>,
  time: number
): void {
  const labelBase = tool.preview ? `${tool.name}: ${tool.preview}` : tool.name;
  const labelText =
    tool.state === 'error'
      ? `${tool.name}: failed`
      : tool.state === 'complete' && tool.resultPreview
        ? `${tool.name}: ${tool.resultPreview}`
        : labelBase;

  ctx.save();
  ctx.font = '8px monospace';
  const truncated = truncateCardText(ctx, labelText, 104);
  const textWidth = ctx.measureText(truncated).width;
  const cardW = Math.max(62, Math.min(124, textWidth + 24));
  const cardH = 18;
  const cardX = x - cardW / 2;
  const cardY = y - r - cardH - 10;
  const accent =
    tool.state === 'error'
      ? COLORS.error
      : tool.state === 'complete'
        ? COLORS.complete
        : COLORS.tool_calling;

  ctx.beginPath();
  ctx.roundRect(cardX, cardY, cardW, cardH, 4);
  ctx.fillStyle = tool.state === 'running' ? 'rgba(10, 15, 30, 0.85)' : 'rgba(10, 15, 30, 0.78)';
  ctx.fill();
  ctx.strokeStyle = hexWithAlpha(accent, 0.7);
  ctx.lineWidth = 1;
  ctx.stroke();

  const indicatorX = cardX + 10;
  const indicatorY = cardY + cardH / 2;

  if (tool.state === 'running') {
    ctx.beginPath();
    ctx.arc(indicatorX, indicatorY, 4.5, time * 3, time * 3 + Math.PI * 1.2);
    ctx.strokeStyle = accent;
    ctx.lineWidth = 1.4;
    ctx.stroke();
  } else {
    ctx.beginPath();
    ctx.arc(indicatorX, indicatorY, 2.5, 0, Math.PI * 2);
    ctx.fillStyle = accent;
    ctx.fill();
  }

  ctx.textAlign = 'left';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = accent;
  ctx.fillText(truncated, indicatorX + 8, indicatorY);
  ctx.restore();
}

function drawBreathing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  state: string,
  time: number,
  spawnStatus?: GraphNode['spawnStatus']
): void {
  // Spawning: bright animated double ring + radial glow
  if (spawnStatus === 'spawning') {
    const ringR = r + AGENT_DRAW.orbitParticleOffset;
    const rotation = time * ANIM.orbitSpeed * 2;

    // Outer glow pulse
    const glowAlpha = 0.15 + 0.1 * Math.sin(time * 3);
    const grad = ctx.createRadialGradient(x, y, r, x, y, ringR + 15);
    grad.addColorStop(0, hexWithAlpha(COLORS.holoBase, glowAlpha));
    grad.addColorStop(1, hexWithAlpha(COLORS.holoBase, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, ringR + 15, 0, Math.PI * 2);
    ctx.fill();

    // Primary spinning arc
    ctx.save();
    ctx.beginPath();
    ctx.arc(x, y, ringR, rotation, rotation + Math.PI * 1.2);
    ctx.strokeStyle = hexWithAlpha(COLORS.holoBase, 0.7);
    ctx.lineWidth = 2.5;
    ctx.setLineDash([8, 5]);
    ctx.stroke();

    // Secondary counter-rotating arc
    ctx.beginPath();
    ctx.arc(x, y, ringR + 5, -rotation * 0.7, -rotation * 0.7 + Math.PI * 0.6);
    ctx.strokeStyle = hexWithAlpha(COLORS.holoBase, 0.3);
    ctx.lineWidth = 1;
    ctx.stroke();
    ctx.setLineDash([]);
    ctx.restore();
    return;
  }

  // Waiting: pulsing glow + hex outline + "waiting" label
  if (spawnStatus === 'waiting') {
    const pulse = 0.15 + 0.15 * Math.sin(time * AGENT_DRAW.waitingBreatheSpeed);

    // Soft glow
    const grad = ctx.createRadialGradient(x, y, r * 0.5, x, y, r + 10);
    grad.addColorStop(0, hexWithAlpha(COLORS.waiting, pulse * 0.5));
    grad.addColorStop(1, hexWithAlpha(COLORS.waiting, 0));
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(x, y, r + 10, 0, Math.PI * 2);
    ctx.fill();

    // Pulsing hex outline
    drawHexagon(ctx, x, y, r + AGENT_DRAW.outerRingOffset);
    ctx.strokeStyle = hexWithAlpha(COLORS.waiting, pulse);
    ctx.lineWidth = 1.5;
    ctx.stroke();
    return;
  }

  const isActive = state === 'active' || state === 'thinking' || state === 'tool_calling';
  const speed = isActive ? ANIM.breathe.activeSpeed : ANIM.breathe.idleSpeed;
  const amp = isActive ? ANIM.breathe.activeAmp : ANIM.breathe.idleAmp;
  const breathe = 1 + amp * Math.sin(time * speed);

  if (isActive) {
    // Orbiting particles for active agents
    const orbitR = r + AGENT_DRAW.orbitParticleOffset;
    const count = 4;
    for (let i = 0; i < count; i++) {
      const angle = time * ANIM.orbitSpeed + (Math.PI * 2 * i) / count;
      const px = x + orbitR * breathe * Math.cos(angle);
      const py = y + orbitR * breathe * Math.sin(angle);
      ctx.fillStyle = COLORS.holoBright + '80';
      ctx.beginPath();
      ctx.arc(px, py, AGENT_DRAW.orbitParticleSize, 0, Math.PI * 2);
      ctx.fill();
    }
  } else {
    // Subtle pulsing glow ring for idle agents
    const pulseAlpha = 0.04 + 0.04 * Math.sin(time * speed);
    ctx.beginPath();
    ctx.arc(x, y, r + 2, 0, Math.PI * 2);
    ctx.strokeStyle = COLORS.holoBase + alphaHex(pulseAlpha);
    ctx.lineWidth = 1;
    ctx.stroke();
  }
}

// ─── Avatar image cache with LRU eviction ───────────────────────────────────

const AVATAR_CACHE_MAX = 100;
const avatarCache = new Map<string, HTMLImageElement>();
const avatarLoading = new Set<string>();

function getAvatarImage(url: string): HTMLImageElement | null {
  const cached = avatarCache.get(url);
  if (cached) {
    // Move to end (most recently used)
    avatarCache.delete(url);
    avatarCache.set(url, cached);
    return cached;
  }
  if (avatarLoading.has(url)) return null;

  avatarLoading.add(url);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    // Evict oldest entry if over limit
    if (avatarCache.size >= AVATAR_CACHE_MAX) {
      const first = avatarCache.keys().next().value;
      if (first != null) avatarCache.delete(first);
    }
    avatarCache.set(url, img);
    avatarLoading.delete(url);
  };
  img.onerror = () => {
    avatarLoading.delete(url);
  };
  img.src = url;
  return null;
}

function drawAvatar(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  name: string,
  color: string,
  isLead: boolean,
  avatarUrl?: string
): void {
  const avatarR = r * AGENT_DRAW.avatarRadiusScale;

  // Try to draw avatar image
  if (avatarUrl) {
    const img = getAvatarImage(avatarUrl);
    if (img) {
      ctx.save();
      // Clip to circle inside hexagon
      ctx.beginPath();
      ctx.arc(x, y, avatarR, 0, Math.PI * 2);
      ctx.clip();
      ctx.drawImage(img, x - avatarR, y - avatarR, avatarR * 2, avatarR * 2);
      ctx.restore();
      return;
    }
  }

  // Fallback: first letter
  const letter = name.charAt(0).toUpperCase();
  const fontSize = isLead ? Math.round(r * 0.6) : Math.round(r * 0.7);
  ctx.font = `bold ${fontSize}px sans-serif`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillStyle = hexWithAlpha(color, 0.9);
  ctx.fillText(letter, x, y + 1);
}

function drawLabel(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  label: string,
  runtimeLabel?: string,
  launchStatusLabel?: string,
  launchVisualState?: GraphNode['launchVisualState']
): void {
  const labelY = y + r + AGENT_DRAW.labelYOffset;
  ctx.font = 'bold 10px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  drawLabelText(ctx, label, x, labelY, '#e8f8ff', 12);

  const trimmedRuntimeLabel = runtimeLabel?.trim();
  const trimmedLaunchStatusLabel = launchStatusLabel?.trim();
  if (!trimmedRuntimeLabel && !trimmedLaunchStatusLabel) {
    return;
  }

  let nextLineY = labelY + 11;
  if (trimmedRuntimeLabel) {
    ctx.font = '8px monospace';
    drawLabelText(ctx, truncateSubLabel(ctx, trimmedRuntimeLabel, r), x, nextLineY, '#b9d7f2', 10);
    nextLineY += 10;
  }

  if (trimmedLaunchStatusLabel) {
    ctx.font = '7px monospace';
    drawLabelText(
      ctx,
      truncateSubLabel(ctx, trimmedLaunchStatusLabel, r),
      x,
      nextLineY,
      getLaunchStatusColor(launchVisualState),
      9
    );
  }
}

function drawLabelText(
  ctx: CanvasRenderingContext2D,
  text: string,
  x: number,
  y: number,
  fillStyle: string,
  lineHeight: number
): void {
  const textWidth = ctx.measureText(text).width;
  const paddingX = 5;
  const paddingY = 1.5;

  ctx.save();
  ctx.globalAlpha = Math.max(ctx.globalAlpha, 0.88);
  ctx.beginPath();
  ctx.roundRect(
    x - textWidth / 2 - paddingX,
    y - paddingY,
    textWidth + paddingX * 2,
    lineHeight,
    4
  );
  ctx.fillStyle = 'rgba(2, 6, 23, 0.78)';
  ctx.fill();
  ctx.strokeStyle = 'rgba(148, 213, 255, 0.18)';
  ctx.lineWidth = 1;
  ctx.stroke();

  ctx.fillStyle = fillStyle;
  drawTextWithHalo(ctx, text, x, y);
  ctx.restore();
}

function drawTextWithHalo(ctx: CanvasRenderingContext2D, text: string, x: number, y: number): void {
  ctx.save();
  ctx.lineWidth = 4;
  ctx.strokeStyle = 'rgba(0, 0, 0, 0.96)';
  ctx.strokeText(text, x, y);
  ctx.restore();
  ctx.fillText(text, x, y);
}

function truncateSubLabel(ctx: CanvasRenderingContext2D, label: string, r: number): string {
  const maxWidth = Math.max(132, r * AGENT_DRAW.labelWidthMultiplier * 2);
  if (ctx.measureText(label).width <= maxWidth) return label;

  let out = label;
  while (out.length > 1 && ctx.measureText(`${out}…`).width > maxWidth) {
    out = out.slice(0, -1);
  }
  return `${out}…`;
}

function getLaunchStatusColor(visualState: GraphNode['launchVisualState']): string {
  switch (visualState) {
    case 'queued':
    case 'waiting':
      return hexWithAlpha('#d4d4d8', 0.8);
    case 'spawning':
      return hexWithAlpha('#f59e0b', 0.9);
    case 'permission_pending':
      return hexWithAlpha('#f59e0b', 0.92);
    case 'runtime_pending':
      return hexWithAlpha('#67e8f9', 0.9);
    case 'shell_only':
    case 'runtime_candidate':
      return hexWithAlpha('#f97316', 0.9);
    case 'registered_only':
      return hexWithAlpha('#a1a1aa', 0.82);
    case 'stale_runtime':
      return hexWithAlpha('#ef4444', 0.82);
    case 'settling':
      return hexWithAlpha('#22c55e', 0.9);
    case 'error':
      return hexWithAlpha('#ef4444', 0.92);
    default:
      return hexWithAlpha(COLORS.holoBright, 0.75);
  }
}

/**
 * Draw context usage ring around lead node.
 */
export function drawContextRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  usage: number,
  time: number
): void {
  const ringR = r + CONTEXT_RING.ringOffset;
  const startAngle = -Math.PI / 2;
  const endAngle = startAngle + Math.PI * 2 * Math.min(1, usage);

  // Background ring
  ctx.beginPath();
  ctx.arc(x, y, ringR, 0, Math.PI * 2);
  ctx.strokeStyle = hexWithAlpha(COLORS.holoBright, 0.08);
  ctx.lineWidth = CONTEXT_RING.ringWidth;
  ctx.stroke();

  // Usage arc
  let ringColor: string = COLORS.complete;
  if (usage > CONTEXT_RING.criticalThreshold) {
    ringColor = COLORS.error;
  } else if (usage > CONTEXT_RING.warningThreshold) {
    ringColor = COLORS.waiting;
  }

  // Pulsing glow for high usage
  if (usage > CONTEXT_RING.warningThreshold) {
    const pulse = 0.5 + 0.5 * Math.sin(time * 3);
    ctx.beginPath();
    ctx.arc(x, y, ringR, startAngle, endAngle);
    ctx.strokeStyle = ringColor + alphaHex(0.3 * pulse);
    ctx.lineWidth = CONTEXT_RING.ringWidth + CONTEXT_RING.glowPadding;
    ctx.stroke();
  }

  ctx.beginPath();
  ctx.arc(x, y, ringR, startAngle, endAngle);
  ctx.strokeStyle = ringColor;
  ctx.lineWidth = CONTEXT_RING.ringWidth;
  ctx.stroke();

  // Percentage label — always show for lead
  ctx.font = '7px monospace';
  ctx.textAlign = 'center';
  ctx.fillStyle = ringColor;
  ctx.fillText(`${Math.round(usage * 100)}% context`, x, y - r - CONTEXT_RING.percentYOffset);
}

function drawSelectionRing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  color: string
): void {
  drawHexagon(ctx, x, y, r + 4);
  ctx.strokeStyle = hexWithAlpha(color, 0.67);
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}
