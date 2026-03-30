/**
 * Hit detection — determine what the user clicked/hovered in world space.
 * Adapted from agent-flow's hit-detection.ts (Apache 2.0).
 */

import type { GraphNode } from '../ports/types';
import { NODE, TASK_PILL, HIT_DETECTION } from '../constants/canvas-constants';

/**
 * Find the node at the given world-space coordinates.
 * Returns node ID or null.
 * Priority: lead > member > task > process.
 */
export function findNodeAt(
  worldX: number,
  worldY: number,
  nodes: GraphNode[],
): string | null {
  // Check in reverse priority order, return last match (highest priority wins)
  let hit: string | null = null;

  for (const node of nodes) {
    const x = node.x ?? 0;
    const y = node.y ?? 0;

    switch (node.kind) {
      case 'lead':
      case 'member': {
        const r = (node.kind === 'lead' ? NODE.radiusLead : NODE.radiusMember) + HIT_DETECTION.agentPadding;
        const dx = worldX - x;
        const dy = worldY - y;
        if (dx * dx + dy * dy <= r * r) {
          hit = node.id;
          // Lead has highest priority, return immediately
          if (node.kind === 'lead') return hit;
        }
        break;
      }
      case 'task': {
        const halfW = TASK_PILL.width / 2 + HIT_DETECTION.taskPadding;
        const halfH = TASK_PILL.height / 2 + HIT_DETECTION.taskPadding;
        if (
          worldX >= x - halfW &&
          worldX <= x + halfW &&
          worldY >= y - halfH &&
          worldY <= y + halfH
        ) {
          hit = node.id;
        }
        break;
      }
      case 'process':
      case 'crossteam': {
        const r = (node.kind === 'crossteam' ? NODE.radiusCrossTeam : NODE.radiusProcess) + HIT_DETECTION.agentPadding;
        const dx = worldX - x;
        const dy = worldY - y;
        if (dx * dx + dy * dy <= r * r) {
          // Only override if no member/lead already hit
          if (!hit) hit = node.id;
        }
        break;
      }
    }
  }

  return hit;
}
