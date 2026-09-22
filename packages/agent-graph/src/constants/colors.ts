/**
 * Color palette for the space-themed graph visualization.
 * Adapted from agent-flow's colors.ts (Apache 2.0).
 * Uses our GraphNodeState instead of agent-flow's AgentState.
 */

import type { GraphNodeState } from '../ports/types';

// ─── Holographic Color Palette ──────────────────────────────────────────────

export const COLORS = {
  // Background
  void: '#050510',
  hexGrid: '#0d0d1f',

  // Primary hologram
  holoBase: '#66ccff',
  holoBright: '#aaeeff',
  holoHot: '#ffffff',

  // Node states
  idle: '#66ccff',
  active: '#66ccff',
  thinking: '#66ccff',
  tool_calling: '#ffbb44',
  complete: '#66ffaa',
  error: '#ff5566',
  waiting: '#ffaa33',
  terminated: '#888899',

  // Edge/Particle colors
  dispatch: '#cc88ff',
  return: '#66ffaa',
  tool: '#ffbb44',
  message: '#66ccff',

  // Task status colors
  taskPending: '#6b7280',
  taskInProgress: '#3b82f6',
  taskCompleted: '#22c55e',
  taskDeleted: '#ef4444',

  // Review state colors
  reviewNone: 'transparent',
  reviewPending: '#f59e0b',
  reviewNeedsFix: '#ef4444',
  reviewApproved: '#22c55e',

  // Edge type colors
  edgeParentChild: '#66ccff',
  edgeOwnership: '#66ccff',
  edgeBlocking: '#ff5566',
  edgeRelated: '#888899',
  edgeMessage: '#cc88ff',

  // Particle kind colors
  particleMessage: '#66ccff',
  particleInboxMessage: '#66ccff',
  particleTaskComment: '#ff9ad5',
  particleTaskAssign: '#ffbb44',
  particleReviewRequest: '#f59e0b',
  particleReviewResponse: '#22c55e',
  particleSpawn: '#cc88ff',

  // UI Chrome
  nodeInterior: 'rgba(10, 15, 40, 0.5)',
  textPrimary: '#aaeeff',
  textDim: '#66ccff90',
  textMuted: '#66ccff50',

  // Glass card (for popovers)
  glassBg: 'rgba(10, 15, 30, 0.7)',
  glassBorder: 'rgba(100, 200, 255, 0.15)',
  glassHighlight: 'rgba(100, 200, 255, 0.08)',

  // Holo background/border opacities
  holoBg05: 'rgba(100, 200, 255, 0.05)',
  holoBg10: 'rgba(100, 200, 255, 0.1)',
  holoBorder10: 'rgba(100, 200, 255, 0.1)',
  holoBorder12: 'rgba(100, 200, 255, 0.12)',

  // Card backgrounds
  cardBg: 'rgba(10, 15, 30, 0.6)',
  cardBgSelected: 'rgba(100, 200, 255, 0.15)',

  // Controls
  controlBg: 'rgba(8, 12, 24, 0.85)',
  controlBorder: 'rgba(100, 200, 255, 0.1)',
  controlActive: 'rgba(100, 200, 255, 0.15)',
  controlInactive: 'rgba(100, 200, 255, 0.05)',
} as const;

// ─── State Color Resolver ───────────────────────────────────────────────────

export function getStateColor(state: GraphNodeState): string {
  switch (state) {
    case 'idle':
      return COLORS.idle;
    case 'active':
      return COLORS.active;
    case 'thinking':
      return COLORS.thinking;
    case 'tool_calling':
      return COLORS.tool_calling;
    case 'complete':
      return COLORS.complete;
    case 'error':
      return COLORS.error;
    case 'waiting':
      return COLORS.waiting;
    case 'terminated':
      return COLORS.terminated;
  }
}

// ─── Task Status Color Resolver ─────────────────────────────────────────────

export function getTaskStatusColor(
  status: 'pending' | 'in_progress' | 'completed' | 'deleted' | undefined,
): string {
  switch (status) {
    case 'pending':
      return COLORS.taskPending;
    case 'in_progress':
      return COLORS.taskInProgress;
    case 'completed':
      return COLORS.taskCompleted;
    case 'deleted':
      return COLORS.taskDeleted;
    default:
      return COLORS.taskPending;
  }
}

// ─── Review State Color Resolver ────────────────────────────────────────────

export function getReviewStateColor(
  state: 'none' | 'review' | 'needsFix' | 'approved' | undefined,
): string {
  switch (state) {
    case 'review':
      return COLORS.reviewPending;
    case 'needsFix':
      return COLORS.reviewNeedsFix;
    case 'approved':
      return COLORS.reviewApproved;
    default:
      return COLORS.reviewNone;
  }
}

// ─── Hex Color Alpha Utility ────────────────────────────────────────────────

// Pre-built LUT: index 0-255 → '00'-'ff' (avoids toString+padStart per call)
const ALPHA_HEX_LUT: string[] = [];
for (let i = 0; i < 256; i++) ALPHA_HEX_LUT.push(i.toString(16).padStart(2, '0'));

/** Convert 0..1 alpha to 2-digit hex suffix (via LUT) */
export function alphaHex(alpha: number): string {
  return ALPHA_HEX_LUT[Math.round(Math.max(0, Math.min(1, alpha)) * 255)];
}

/** Safely combine a partial rgba base (e.g. "rgba(100, 200, 255,") with an alpha value */
export function withAlpha(rgbaBase: string, alpha: number): string {
  // Handles both "rgba(r,g,b," and "rgba(r, g, b," formats
  const trimmed = rgbaBase.trimEnd();
  const separator = trimmed.endsWith(',') ? ' ' : ', ';
  return `${trimmed}${separator}${alpha})`;
}
