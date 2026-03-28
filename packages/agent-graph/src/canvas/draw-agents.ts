/**
 * Agent (member/lead) node drawing with holographic effects.
 * Adapted from agent-flow's draw-agents.ts (Apache 2.0).
 * Uses our GraphNode port type instead of agent-flow's Agent type.
 */

import type { GraphNode } from '../ports/types';
import { COLORS, getStateColor, alphaHex } from '../constants/colors';
import { NODE, AGENT_DRAW, CONTEXT_RING, ANIM, MIN_VISIBLE_OPACITY } from '../constants/canvas-constants';
import { drawHexagon } from './draw-misc';
import { getAgentGlowSprite, ensureHex, hexWithAlpha } from './render-cache';

/**
 * Draw all member/lead nodes on the canvas.
 */
export function drawAgents(
  ctx: CanvasRenderingContext2D,
  nodes: GraphNode[],
  time: number,
  selectedId: string | null,
  hoveredId: string | null,
): void {
  for (const node of nodes) {
    if (node.kind !== 'member' && node.kind !== 'lead') continue;
    const opacity = getNodeOpacity(node);
    if (opacity < MIN_VISIBLE_OPACITY) continue;

    const x = node.x ?? 0;
    const y = node.y ?? 0;
    const r = node.kind === 'lead' ? NODE.radiusLead : NODE.radiusMember;
    const color = node.color ?? getStateColor(node.state);
    const isSelected = node.id === selectedId;
    const isHovered = node.id === hoveredId;

    ctx.save();
    ctx.globalAlpha = opacity;

    // Depth shadow
    drawDepthShadow(ctx, x, y, r);

    // Outer glow
    drawGlow(ctx, x, y, r, color);

    // Hexagonal body with interior fill
    drawHexBody(ctx, x, y, r, color, node.state, time, isSelected, isHovered);

    // Avatar: robohash image or fallback letter
    drawAvatar(ctx, x, y, r, node.label, color, node.kind === 'lead', node.avatarUrl);

    // Breathing animation + spawn/waiting effects
    drawBreathing(ctx, x, y, r, node.state, time, node.spawnStatus);

    // Working indicator: subtle spinning arc when member has active task
    if (node.currentTaskId && (node.state === 'active' || node.state === 'thinking' || node.state === 'tool_calling')) {
      const ringR = r + 4;
      const rotation = time * 1.5;
      ctx.beginPath();
      ctx.arc(x, y, ringR, rotation, rotation + Math.PI * 0.8);
      ctx.strokeStyle = hexWithAlpha(color, 0.4);
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Name + role label (single line: "jack · developer")
    const labelText = node.role ? `${node.label} · ${node.role}` : node.label;
    drawLabel(ctx, x, y, r, labelText, color);

    // Context ring for lead
    if (node.kind === 'lead' && node.contextUsage != null) {
      drawContextRing(ctx, x, y, r, node.contextUsage, time);
    }

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

function drawGlow(ctx: CanvasRenderingContext2D, x: number, y: number, r: number, color: string): void {
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
  isHovered: boolean,
): void {
  // Interior fill
  drawHexagon(ctx, x, y, r);
  ctx.fillStyle = isSelected
    ? 'rgba(100, 200, 255, 0.15)'
    : COLORS.nodeInterior;
  ctx.fill();

  // Scanline effect
  const scanSpeed = state === 'active' || state === 'thinking'
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
    y + scanY + AGENT_DRAW.scanlineHalfH,
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

function drawBreathing(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  r: number,
  state: string,
  time: number,
  spawnStatus?: GraphNode['spawnStatus'],
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

    // "connecting" label below name
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = hexWithAlpha(COLORS.holoBase, 0.5 + 0.3 * Math.sin(time * 2));
    ctx.fillText('connecting...', x, y + r + AGENT_DRAW.labelYOffset + 14);
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

    // "waiting" label
    ctx.font = '7px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = hexWithAlpha(COLORS.waiting, 0.4 + 0.2 * Math.sin(time * 1.5));
    ctx.fillText('waiting...', x, y + r + AGENT_DRAW.labelYOffset + 14);
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

// ─── Avatar image cache ─────────────────────────────────────────────────────

const avatarCache = new Map<string, HTMLImageElement>();
const avatarLoading = new Set<string>();

function getAvatarImage(url: string): HTMLImageElement | null {
  const cached = avatarCache.get(url);
  if (cached) return cached;
  if (avatarLoading.has(url)) return null;

  avatarLoading.add(url);
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
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
  avatarUrl?: string,
): void {
  const avatarR = r * 0.6;

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
  color: string,
): void {
  const labelY = y + r + AGENT_DRAW.labelYOffset;
  ctx.font = '9px monospace';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'top';
  ctx.fillStyle = color;
  ctx.fillText(label, x, labelY);
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
  time: number,
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
  color: string,
): void {
  drawHexagon(ctx, x, y, r + 4);
  ctx.strokeStyle = hexWithAlpha(color, 0.67);
  ctx.lineWidth = 2;
  ctx.setLineDash([4, 4]);
  ctx.stroke();
  ctx.setLineDash([]);
}
